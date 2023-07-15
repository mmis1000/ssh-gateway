/** @undindent-chained-methods */
const http = require("http");
const express = require("express");
const inspect = require('util').inspect;
const createUser = require("./user").createUser;
const getUserWithName = require("./user").getUserWithName;
const getUserWithDomain = require("./user").getUserWithDomain;
const render = require("./template");
const { promises: fs } = require("fs")
const path = require("path");
const mime = require("mime");
const User = require("./user").User;
const parseRange = require('range-parser');
const range = require('express-range');
const ejs = require("ejs");
const ssh2_streams = require('ssh2-streams');
const SFTPStream = ssh2_streams.SFTPStream;
const {decodePath, encodePath} = require("./path_utils");
const getFastReadStream = require("./ssh_fast_read_stream");
const httpProxy = require('http-proxy');

module.exports = function(config) {
    const router = express();
    const server = http.createServer(router);

    var proxy = new httpProxy.createProxyServer({
        target: {
            host: 'localhost',
            port: 65535
        }
    });

    server.on('upgrade', function (req, socket, head) {
        
        let domain = req.hostname ?? req.headers.host?.split(':')[0];

        if (!domain) {
            return
        }

        if (domain === config.httpHost) {
            // do not proxy it
            return;
        }

        let id = domain.split('.')[0];

        getUserWithDomain(id)
        .then(function (user) {
            // ensure client exist
            return user.getClient()
            .then(function () {
                return user
            })
        })
        .then(function (userData) {
            if (userData.httpPort !== 0) {
                return userData.getClient().then(function (sshClient) {
                    return [userData, sshClient]
                })
            }
        })
        .then(function ([userData, sshClient]) {
            if (sshClient) {
                proxy.ws(req, socket, head, {
                    target: {
                        host: 'localhost',
                        port: userData.httpPort
                    },
                    agent: Object.assign(Object.create(http.Agent), {
                        createConnection: function (opts, cb) {
                            sshClient.forwardOut('localhost', 9999, 'localhost', userData.httpPort, function(err, stream) {
                                if (err) {
                                    return cb(err);
                                }
                                console.log(`${userData.id}: [HTTP] Forward ${req.method} http connection established at ${req.originalUrl} of ${userData.domainName}`);
                                cb(null, stream);
                            })
                        }
                    })
                });
            }
        })
        .catch(function (err) {
            // just let it go
        })
    });

    router.set('views', path.resolve(__dirname, '../views'));
    router.set('view engine', 'ejs');
    router.locals.mime = mime;
    router.locals.SFTPStream = SFTPStream;
    router.locals.decodePath = decodePath;
    router.locals.encodePath = encodePath;
    
    router.use(range({
        accept: 'bytes',
        limit: 10,
    }));

    router.use(function(req, res, next) {
        let domain = req.hostname;

        if (domain === config.httpHost) {
            return next();
        }

        let id = domain.split('.')[0];

        getUserWithDomain(id)
        .then(function (user) {
            // ensure client exist
            return user.getClient()
            .then(function () {
                return user
            })
        })
        .then(function(userData) {
            if (userData.httpPort !== 0) {
                userData.getClient()
                .then(function(sshClient) {
                    let client = http.request({
                        createConnection: function(opts, cb) {
                            sshClient.forwardOut('localhost', 9999, 'localhost', userData.httpPort, function(err, stream) {
                                if (err) {
                                    return cb(err);
                                }
                                console.log(`${userData.id}: [HTTP] Forward ${req.method} http connection established at ${req.originalUrl} of ${userData.domainName}`);
                                cb(null, stream);
                            })
                        },
                        headers: Object.assign({}, req.headers, {
                            "X-Forwarded-For": `${req.ip} 127.0.0.1`
                        }),
                        method: req.method,
                        path: req.originalUrl
                    })

                    client.on('error', function(err) {
                        res.status(500).end(inspect(err))
                    })

                    req
                    .on('error', function(err) {
                        res.status(500).end(inspect(err))
                    })
                    .pipe(client)

                    client.on('response', function(msg) {
                        res.writeHeader(msg.statusCode, Object.assign({}, msg.headers, {
                            "X-Proxy-User": userData.id
                        }))


                        msg
                        .on('error', function nuzz() {})
                        .pipe(res)
                        .on('error', function nuzz() {})
                    })
                })
                .catch(function(err) {
                    res.status(500).end(inspect(err));
                })
                return;
            } else {
                console.log(`${userData.id}: [HTTP] Requested file at ${req.originalUrl} of ${userData.domainName}`)

                let remoteMountPoint = userData.staticDirectory;
                let reqPath = decodePath(req.path);
                let baseDir = path.dirname(reqPath);
                let baseName = path.basename(reqPath)
                let fullPath = path.resolve(remoteMountPoint, reqPath.slice(1));
                let realBaseDir = path.dirname(fullPath);
                let realBaseName = path.basename(fullPath)
                
                userData.getSftp()
                .then(function (sftpClient) {
                    console.log(`${userData.id}: [HTTP] stating stat of ${fullPath}`);
                    sftpClient.lstat(fullPath, function(err, stats) {
                        console.log(`${userData.id}: [HTTP] got stat of ${fullPath}`);
                        
                        if (err) {
                            res.set('Content-Type', 'plain/text');
                            return res.status(404).end(inspect(err));
                        }

                        if (stats.isSymbolicLink()) {
                            return sftpClient.readlink(fullPath, function(err, realPath) {
                                if (err) {
                                    return res.status(404).end(inspect(err));
                                }

                                /** `realPath` can be sometimes relative path*/
                                realPath = path.resolve(path.dirname(fullPath) + '/', realPath)
                                console.log(`${userData.id}: [HTTP] real path: ${realPath}, mount point: ${remoteMountPoint}`);

                                let relativePath = path.relative(remoteMountPoint, realPath);
                                console.log(`${userData.id}: [HTTP] path relative to root: ${relativePath}`)

                                if (relativePath.indexOf('../') >= 0) {
                                    return res.status(403).end('Out of folder reading rejected');
                                }

                                res.redirect(302, '/' + relativePath);
                            })
                        } else if (stats.isDirectory()) {
                            console.log(`${userData.id}: [HTTP] is dir  ${fullPath}`);
                            
                            if (!req.path.match(/\/$/)) {
                                return res.redirect(302, req.path + '/');
                            }

                            return sftpClient.readdir(fullPath, function(err, files) {
                                console.log(`${userData.id}: [HTTP] got dir res  ${fullPath}`);
                                
                                if (err) {
                                    return res.status(404).end(inspect(err));
                                }

                                files = files.map(function(file) {
                                    file.attrs = new SFTPStream.Stats(file.attrs);
                                    return file;
                                })

                                res.render('folder', {
                                    path: reqPath,
                                    files
                                })
                            })
                        } else if (stats.isFile()) {
                            console.log(`${userData.id}: [HTTP] is file  ${fullPath}`);
                            
                            let size = stats.size;
                            let ext = path.extname(baseName);
                            let contentType = ext ? (mime.getType(ext) || 'application/octet-stream') : 'application/octet-stream';
                            let range = req.headers.range ? parseRange(size, req.headers.range) : null;
                            let readStream = null;

                            res.set('Content-Type', contentType);
                            res.set('Content-Length', size);

                            if (range === null) {
                                // readStream = sftpClient.createReadStream(fullPath);
                                readStream = getFastReadStream(sftpClient, fullPath);
                            } else if (range !== -1 && range.type === 'bytes' && range.length === 1) {
                                res.set('Content-Length', range[0].end - range[0].start + 1);

                                res.range({
                                    first: range[0].start,
                                    last: range[0].end,
                                    length: size
                                });

                                let temp = {};
                                if (range[0].start !== 0) {
                                    temp.start = range[0].start;
                                }

                                if (range[0].end + 1 !== size) {
                                    temp.end = range[0].end;
                                }

                                //readStream = sftpClient.createReadStream(fullPath, temp);
                                readStream = getFastReadStream(sftpClient, fullPath, temp);
                                res.status(206);
                            } else {
                                res.set('Content-Type', 'text/html');
                                res.set('Content-Length', '');
                                return res.status(416).end('range not satisfied');
                            }

                            readStream.on('error', function(err) {
                                if (req.closed) {
                                    return;
                                }
                                res.set('Content-Type', 'text/plain');
                                res.set('Content-Length', '');
                                res.status(500).end(err.stack ? err.stack : err.toString());
                            })
                            
                            req.on('close', function () {
                                
                                req.closed = true;
                                try {
                                    readStream.destroy();
                                } catch (err) {
                                    // nuzz
                                }
                            })
                            
                            readStream.pipe(res);
                            return;
                        } else {
                            return res.status(403).end('file type not implemented');
                        }

                    })
                })
                .catch(function(err) {
                    res.status(500).end(inspect(err));
                })

                return;
            }
            // return res.end('not yet implement')
        })
        .catch(function(err) {
            res.status(500).end(inspect(err))
        })
    })

    const templatePromise = fs.readFile(path.join(__dirname, '../template/script.template'), 'utf8')

    router.get('/setup', function(req, res, next) {
        let domain = req.hostname;

        if (domain !== config.httpHost) {
            return next();
        }

        createUser()
            .then(function(userData) {
                return Promise.all([userData, templatePromise])
            })
            .then(function([userData, template]) {
                res.set('Content-Type', 'application/x-sh');

                res.end(render(template, {
                    TARGET_PORT: config.sshPort,
                    TARGET_USER: userData.id,
                    TARGET_HOST: config.sshHost,
                    CLIENT_PRIVATE_KEY: userData.privateKey,
                    CLIENT_SERVER_KEY: userData.publicKey_pub,
                    LISTEN_PORT_LOW: config.userListenPortLow,
                    LISTEN_PORT_HIGH: config.userListenPortHigh,
                }))
            })
            .catch(function(err) {
                res.status(500).end(err.stack)
            })
    })

    router.get('/update', function(req, res, next) {
        let domain = req.hostname;

        if (domain !== config.httpHost) {
            return next();
        }

        const authHeader = req.headers.authorization
        const isBasicAuth = authHeader != null && authHeader.startsWith('Basic')

        if (!isBasicAuth) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Not authencated"')
            res.status(401)
            res.end('')
        }

        const base64Str = authHeader.replace('Basic', '').trim()
        const str = Buffer.from(base64Str, 'base64').toString('utf8')

        const account = decodeURIComponent(str.split(':')[0] ?? '')
        const password = decodeURIComponent(str.split(':')[1] ?? '')

        getUserWithName(account)
        .then((userData) => {
            if (userData.password !== password) {
                throw new Error('not authenticated')
            }
            return userData
        })
        .then(function(userData) {
            return Promise.all([userData, templatePromise])
        })
        .then(function([userData, template]) {
            res.set('Content-Type', 'application/x-sh');

            res.end(render(template, {
                TARGET_PORT: config.sshPort,
                TARGET_USER: userData.id,
                TARGET_HOST: config.sshHost,
                CLIENT_PRIVATE_KEY: userData.privateKey,
                CLIENT_SERVER_KEY: userData.publicKey_pub,
                LISTEN_PORT_LOW: config.userListenPortLow,
                LISTEN_PORT_HIGH: config.userListenPortHigh,
            }))
        })
        .catch((err) => {
            console.log(`${account}: [HTTP] denied update of ${str} due to ${err}`);
            res.setHeader('WWW-Authenticate', 'Basic realm="Not authenticated"')
            res.status(401)
            res.end('')
        })
    })

    router.get('/', function(req, res, next) {
        let domain = req.hostname;

        if (domain !== config.httpHost) {
            return next();
        }

        res.end(`
Run following command to setup the forward !!!

$ curl ${config.httpProtocol}://${config.httpHost}:${config.httpPort}/setup > run.sh
$ chmod 755 run.sh
$ sudo ./run.sh
`)
    })

    server.listen(config.httpListen || 8080, "0.0.0.0", function() {
        let addr = server.address();
        console.log("Http server listening at", addr.address + ":" + addr.port);
    });
}
