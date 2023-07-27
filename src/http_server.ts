import { Config } from "./interface";

/** @undindent-chained-methods */
import http from "http";
import express from "express";
const inspect = require('util').inspect;
import render from "./template";
import { promises as fs } from "fs";
import path from "path";
import mime from "mime";
import { User, createUser, getUserWithName, getUserWithDomain } from"./user";
import parseRange from 'range-parser';
import ejs from "ejs";
import ssh2_streams from 'ssh2-streams';
const SFTPStream = ssh2_streams.SFTPStream;
import { decodePath, encodePath } from "./path_utils";
import getFastReadStream from "./ssh_fast_read_stream";
import httpProxy from 'http-proxy';
import { AddressInfo } from "net";
import { Duplex, pipeline } from "stream";

export default function(config: Config) {
    const router = express();
    const server = http.createServer(router);

    var proxy = httpProxy.createProxyServer({
        target: {
            host: 'localhost',
            port: 65535
        }
    });

    server.on('upgrade', function (req, socket, head) {
        
        let domain = req.headers.host?.split(':')[0];

        if (!domain) {
            return
        }

        if (!domain.endsWith(config.httpHost) || domain === config.httpHost) {
            // do not proxy it
            return;
        }

        let id = domain.split('.')[0];

        getUserWithDomain(config.saveDir, id)
        .then(async function (user) {
            // ensure client exist
            await user.getClient();
            return user;
        })
        .then(async function (userData) {
            if (userData.httpPort !== 0) {
                const sshClient = await userData.getClient();
                return [userData, sshClient] as const;
            } else {
                throw Error('not in forward mode')
            }
        })
        .then(function ([userData, sshClient]) {
            if (sshClient) {
                proxy.ws(req, socket, head, {
                    target: {
                        host: 'localhost',
                        port: userData.httpPort!
                    },
                    agent: Object.assign(Object.create(http.Agent), {
                        createConnection: function (_opts: any, cb: (err?: Error, stream?: Duplex) => void) {
                            sshClient.forwardOut('localhost', 9999, 'localhost', userData.httpPort!, function(err, stream) {
                                if (err) {
                                    return cb(err);
                                }
                                console.log(`${userData.id}: [HTTP] Forward ${req.method} http connection established at ${req.url} of ${userData.domainName}`);
                                cb(undefined, stream);
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
    
    router.use(function(req, res, next) {
        let domain = req.hostname;

        if (!domain.endsWith(config.httpHost) || domain === config.httpHost) {
            return next();
        }

        if (req.url === '/robots.txt') {
            res.end(`# robots.ext is explicitly hardcoded to disallow everything for abuse prevention
User-agent: *
Disallow: /
`)
            return
        }

        if (req.url.startsWith('/.well-known/acme-challenge/')) {
            res.end(`Why?`)
            return
        }

        let id = domain.split('.')[0];

        let aborted = false
        req.on('error', () => {
            aborted = true
            try {
                res.destroy()
            } catch (err) {}
        })

        getUserWithDomain(config.saveDir, id)
        .then(function(userData) {
            if (aborted) {
                throw new Error('aborted')
            }
            if (userData.httpPort !== 0) {
                userData.getClient()
                .then(function(sshClient) {
                    let client = http.request({
                        createConnection: function(opts, cb) {
                            sshClient.forwardOut('localhost', 9999, 'localhost', userData.httpPort!, function(err, stream) {
                                if (err) {
                                    userData.requestSuicideTimer()
                                    return cb(err, null as never);
                                }
                                userData.clearSuicideTimer()
                                console.log(`${userData.id}: [HTTP] Forward ${req.method} http connection established at ${req.originalUrl} of ${userData.domainName}`);
                                // FIXME:  stream does not fully implement socket
                                cb(null as never, stream as any);
                            })

                            return undefined as never
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

                    pipeline(
                        req,
                        client,
                        (error) => {
                            if (error) {
                                if (!res.headersSent) {
                                    res.status(500).end(inspect(error))
                                }
                                try {
                                    client.destroy()
                                } catch (err) {}
                            }
                        }
                    )

                    client.on('response', function(msg) {
                        res.writeHead(msg.statusCode!, Object.assign({}, msg.headers, {
                            "X-Proxy-User": userData.id
                        }))

                        pipeline(
                            msg,
                            res,
                            (error) => {
                                if (error) {
                                    if (!res.headersSent) {
                                        res.status(500).end(inspect(error))
                                    }
                                    try {
                                        client.destroy()
                                    } catch (err) {}
                                }
                            }
                        )
                    })
                })
                .catch(function(err) {
                    userData.requestSuicideTimer()
                    res.status(500).end(inspect(err));
                })
                return;
            } else {
                console.log(`${userData.id}: [HTTP] Requested file at ${req.originalUrl} of ${userData.domainName}`)

                let remoteMountPoint = userData.staticDirectory;
                let reqPath = decodePath(req.path);
                let baseDir = path.dirname(reqPath);
                let baseName = path.basename(reqPath)
                let fullPath = path.resolve(remoteMountPoint!, reqPath.slice(1));
                let realBaseDir = path.dirname(fullPath);
                let realBaseName = path.basename(fullPath)
                
                userData.getSftp()
                .then(function (sftpClient) {
                    userData.clearSuicideTimer()
                    console.log(`${userData.id}: [HTTP] stating stat of ${fullPath}`);
                    sftpClient.lstat(fullPath, function(err, stats) {
                        console.log(`${userData.id}: [HTTP] got stat of ${fullPath}`);
                        
                        if (err) {
                            res.set('Content-Type', 'text/plain');
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

                                let relativePath = path.relative(remoteMountPoint!, realPath);
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
                                    // FIXME: undocumented api
                                    file.attrs = new ((SFTPStream as any).Stats)(file.attrs);
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
                            // let range = req.headers.range ? parseRange(size, req.headers.range) : null;
                            const range = req.range(stats.size)
                            let readStream: ReturnType<typeof getFastReadStream> | null = null;

                            res.set('Content-Type', contentType);
                            res.set('Content-Length', String(size));
                            res.set('Accept-Ranges', 'bytes');

                            if (range == null) {
                                // readStream = sftpClient.createReadStream(fullPath);
                                readStream = getFastReadStream(sftpClient, fullPath);
                            } else if (range !== -1 && range !== -2 && range.type === 'bytes' && range.length === 1) {
                                res.set('Content-Length', String(range[0].end - range[0].start + 1));

                                res.set('Content-Range', `bytes ${range[0].start}-${range[0].end}/${stats.size}`)
                                let temp: {
                                    start?: number,
                                    end?: number
                                } = {};
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
                                if (res.headersSent) {
                                    res.end()
                                    return
                                }
                                res.set('Content-Type', 'text/plain');
                                res.set('Content-Length', '');
                                res.status(500).end(err.stack ? err.stack : err.toString());
                            })
                            
                            req.on('close', function () {
                                
                                // req.closed = true;
                                try {
                                    readStream?.destroy();
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
                    userData.requestSuicideTimer()
                    res.status(500).end(inspect(err));
                })

                return;
            }
            // return res.end('not yet implement')
        })
        .catch(function(err) {
            if (!aborted) {
                if (!res.headersSent) {
                    res.status(500).end(inspect(err))
                }
            }
        })
    })

    router.use(function(req, res, next) {
        let domain = req.hostname;

        if (domain !== config.httpHost) {
            return next();
        }

        res.end(`This is a domain that serves user content.
To report abuse, go to ${config.setupProtocol}://${config.setupHost}:${config.setupPort}/report-abuse`)
    })

    const templatePromise = fs.readFile(path.join(__dirname, '../template/script.template'), 'utf8')

    router.post('/setup', function(req, res, next) {
        let domain = req.hostname;

        if (domain !== config.setupHost) {
            return next();
        }

        if (config.setupRequireAuth) {
            const authHeader = req.headers.authorization ?? ''
            const isBasicAuth = authHeader && authHeader.startsWith('Basic')
            
            if (!isBasicAuth) {
                res.setHeader('WWW-Authenticate', 'Basic realm="Not authencated"')
                res.status(401)
                res.end('')
                return
            }

            const base64Str = authHeader.replace('Basic', '').trim()
            const str = Buffer.from(base64Str, 'base64').toString('utf8')

            const account = decodeURIComponent(str.split(':')[0] ?? '')
            const password = decodeURIComponent(str.split(':')[1] ?? '')

            if (account !== config.setupAccount || password !== config.setupPassword) {
                res.status(401)
                res.end('bad credential')
                return
            }
        }

        createUser(config.saveDir)
            .then(function(userData) {
                return Promise.all([userData, templatePromise])
            })
            .then(function([userData, template]) {
                res.set('Content-Type', 'application/x-sh');

                res.end(render(template, {
                    TARGET_PORT: config.sshPort,
                    TARGET_USER: userData.id!,
                    TARGET_HOST: config.sshHost,
                    CLIENT_PRIVATE_KEY: userData.privateKey!,
                    CLIENT_SERVER_KEY: userData.publicKey_pub!,
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

        if (domain !== config.setupHost) {
            return next();
        }

        const authHeader = req.headers.authorization ?? ''
        const isBasicAuth = authHeader && authHeader.startsWith('Basic')

        if (!isBasicAuth) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Not authencated"')
            res.status(401)
            res.end('')
        }

        const base64Str = authHeader.replace('Basic', '').trim()
        const str = Buffer.from(base64Str, 'base64').toString('utf8')

        const account = decodeURIComponent(str.split(':')[0] ?? '')
        const password = decodeURIComponent(str.split(':')[1] ?? '')

        getUserWithName(config.saveDir, account)
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
                TARGET_USER: userData.id!,
                TARGET_HOST: config.sshHost,
                CLIENT_PRIVATE_KEY: userData.privateKey!,
                CLIENT_SERVER_KEY: userData.publicKey_pub!,
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

        if (domain !== config.setupHost) {
            return next();
        }

        res.end(`
Run following command to setup the forward !!!

$ curl -X POST${config.setupRequireAuth ? ' -u \'username:password\'': ''} ${config.setupProtocol}://${config.setupHost}:${config.setupPort}/setup > run.sh
$ chmod 755 run.sh
$ ./run.sh
`)
    })

    server.listen(config.httpListen || 8080, "0.0.0.0", function() {
        let addr = server.address() as AddressInfo;
        console.log("Http server listening at", addr.address + ":" + addr.port);
        console.log("Http server exposed at", `${config.httpProtocol}://${config.httpHost}:${config.httpPort}/`);
    });
}
