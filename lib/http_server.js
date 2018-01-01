const http = require("http");
const express = require("express");
const inspect = require('util').inspect;
const createUser = require("./user").createUser;
const getUser = require("./user").getUser;
const render = require("./templete");
const fs = require("fs")
const path = require("path");
const mime = require("mime");
const User = require("./user").User;
const parseRange = require('range-parser');
const range = require('express-range');
const ejs = require("ejs");
var ssh2_streams = require('ssh2-streams');
var SFTPStream = ssh2_streams.SFTPStream;

module.exports = function(config) {
    const router = express();
    const server = http.createServer(router);

    router.set('views', path.resolve(__dirname, '../views'));
    router.set('view engine', 'ejs');
    router.locals.mime = mime;
    router.locals.SFTPStream = SFTPStream;
    router.use(range({
      accept: 'bytes',
      limit: 10,
    }));
    
    router.use(function(req, res, next) {
        var domain = req.hostname;

        if (domain === config.httpHost) {
            return next();
        }

        var id = domain.split('.')[0];

        getUser(id)
            .then(function(userData) {
                if (!userData.sshClient) {
                    return res.end(userData.id + ': connection not yes established');
                }

                if (userData.httpPort !== 0) {
                    var client = http.request({
                        createConnection: function(opts, cb) {
                            userData.sshClient.forwardOut('localhost', 9999, 'localhost', userData.httpPort, function(err, stream) {
                                if (err) {
                                    return cb(err);
                                }
                                console.log(userData.id + ': Forward ' + req.method + ' http connection established at ' + req.originalUrl + ' of ' + userData.domainName)
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
                } else {
                    var remoteMountPoint = userData.staticDirectory;
                    var reqPath = req.path;
                    var baseDir = path.dirname(reqPath);
                    var baseName = path.basename(reqPath)
                    var fullPath = path.resolve(remoteMountPoint, reqPath.slice(1));
                    var realBaseDir = path.dirname(fullPath);
                    var realBaseName = path.basename(fullPath)

                    function handle(sftpClient) {
                        sftpClient.stat(fullPath, function(err, stats) {
                            if (err) {
                                res.set('Content-Type', 'plain/text');
                                return res.status(404).end(inspect(err));
                            }

                            if (stats.isDirectory()) {
                                if (!req.path.match(/\/$/)) {
                                    return res.redirect(302, req.path + '/');
                                }
                                
                                return sftpClient.readdir(fullPath, function(err, files) {
                                    if (err) {
                                        return res.status(404).end(inspect(err));
                                    }
                                    
                                    files = files.map(function (file) {
                                        file.attrs = new SFTPStream.Stats(file.attrs);
                                        return file;
                                    })
                                    
                                    res.render('folder', {
                                        path: baseDir,
                                        files
                                    })
                                })
                            } else if (stats.isSymbolicLink()) {
                                return sftpClient.readlink(fullPath, function(err, realPath) {
                                    if (err) {
                                        return res.status(404).end(inspect(err));
                                    }

                                    var relativePath = path.relative(realPath, remoteMountPoint);

                                    if (relativePath.indexOf('../') >= 0) {
                                        return res.status(403).end('Out of folder reading rejected');
                                    }

                                    res.redirect(302, relativePath);
                                })
                            } else if (stats.isFile()) {
                                var readStream = sftpClient.createReadStream(fullPath);
                                var size = stats.size;
                                var ext = path.extname(baseName);
                                var contentType = ext ? (mime.getType(ext) || 'application/octet-stream') : 'application/octet-stream';
                                var range = req.headers.range ? parseRange(size, req.headers.range) : null;
                                var readStream = null;
                                
                                res.set('Content-Type', contentType);
                                res.set('Content-Length', size);
                                
                                if (range === null) {
                                    readStream = sftpClient.createReadStream(fullPath);
                                } else if (range !== -1 && range.type === 'bytes' && range.length === 1) {
                                    res.set('Content-Length', range[0].end - range[0].start + 1);
                                    
                                    res.range({
                                        first: range[0].start,
                                        last: range[0].end,
                                        length: size
                                    });
                                    
                                    var temp = {};
                                    if (range[0].start !== 0) {
                                        temp.start = range[0].start;
                                    }
                                    
                                    if (range[0].end !== size + 1) {
                                        temp.end = range[0].end + 1;
                                    }
                                    
                                    readStream = sftpClient.createReadStream(fullPath, temp);
                                    res.status(206);
                                } else {
                                    res.set('Content-Type', 'text/html');
                                    res.set('Content-Length', '');
                                    return res.status(416).end('range not satisfied');
                                }
                                
                                readStream.on('error', function (err) {
                                    res.set('Content-Type', 'text/plain');
                                    res.set('Content-Length', '');
                                    res.status(500).end(err.stack? err.stack: err.toString());
                                })
                                
                                readStream.pipe(res);
                                return;
                            } else {
                                return res.status(403).end('file type not implemented');
                            }

                        })
                    }

                    if (userData.sftpState !== User.SFTP_CLIENT_STATE.CONNECT) {
                        userData.createSftp();
                        return userData.once('sftp_client', function(sftp) {
                            handle(sftp);
                        })
                    } else {
                        return handle(userData.sftpClient);
                    }


                    return res.end('not yet implement');
                }
                // return res.end('not yet implement')
            })
            .catch(function(err) {
                res.status(500).end(inspect(err))
            })
    })

    router.get('/setup', function(req, res, next) {
        var domain = req.hostname;

        if (domain !== config.httpHost) {
            return next();
        }

        createUser()
            .then(function(userData) {
                res.set('Content-Type', 'application/x-sh');

                res.end(render(fs.readFileSync(path.join(__dirname, '../templete/script.templete'), 'utf8'), {
                    TARGET_PORT: config.sshPort,
                    TARGET_USER: userData.id,
                    TARGET_HOST: config.sshHost,
                    CLIENT_PRIVATE_KEY: userData.privateKey,
                    CLIENT_SERVER_KEY: userData.publicKey_pub,
                    LISTEN_PORT: 30020
                }))
            })
            .catch(function(err) {
                res.status(500).end(err.stack)
            })
    })

    router.get('/', function(req, res, next) {
        var domain = req.hostname;

        if (domain !== config.httpHost) {
            return next();
        }

        res.end(`
Run folloing command to setup the forward !!!

$ curl http://${config.httpHost}/setup > run.sh
$ chmod 755 run.sh
$ sudo ./run.sh
`)
    })

    server.listen(config.httpListen || 8080, "0.0.0.0", function() {
        var addr = server.address();
        console.log("Http server listening at", addr.address + ":" + addr.port);
    });
}
