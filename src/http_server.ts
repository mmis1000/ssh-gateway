import { ClientPacket, Config, Packet } from "./interface";

import http from "http";
import express from "express";
const inspect = require('util').inspect;
import render from "./template";
import { promises as fs } from "fs";
import path from "path";
import mime from "mime";
import { UserStore } from "./store";
import { User } from "./user";
import ssh2_streams from 'ssh2-streams';
const SFTPStream = ssh2_streams.SFTPStream;
import { asSocket, decodePath, encodePath, formatOrigin, getContentType, parseBasicAuth, parseRawData, secretEquals } from "./utils";
import getFastReadStream from "./ssh_fast_read_stream";
import httpProxy from 'http-proxy';
import { RawData, WebSocketServer } from 'ws';
import type { Stats } from "ssh2";
import { AddressInfo } from "net";
import { Duplex, pipeline } from "stream";
import { WsManager } from "./ws_manager";
import { Inspector } from "./inspector";
import { knownHostsLines } from "./keys";

/** websocket close code for failed inspector login, the app does not retry on it */
const WS_AUTH_FAILED = 4001
/** asked for on forwards started with run.sh --auth */
const VISITOR_AUTH_CHALLENGE = 'Basic realm="Protected forward", charset="UTF-8"'

const idMap: Record<string, number> = {}
const getId = (name: string) => {
    const current = idMap[name] ?? 0
    idMap[name] = current
    idMap[name]++
    return current
}

/** like nginx: changes with the modification time or the size, whichever the edit touched */
export function fileEtag(stats: Pick<Stats, 'mtime' | 'size'>) {
    return `"${Math.floor(stats.mtime).toString(16)}-${stats.size.toString(16)}"`
}

/** run.sh for a user, from template/script.template */
export function renderClientScript(template: string, config: Pick<Config, 'sshHost' | 'sshPort' | 'userListenPortLow' | 'userListenPortHigh'>, user: User, knownHosts: string) {
    return render(template, {
        TARGET_PORT: config.sshPort,
        TARGET_USER: user.id!,
        TARGET_HOST: config.sshHost,
        CLIENT_PRIVATE_KEY: user.clientKey!,
        CLIENT_SERVER_KEY: user.gatewayKeyPub!,
        LISTEN_PORT_LOW: config.userListenPortLow,
        LISTEN_PORT_HIGH: config.userListenPortHigh,
        KNOWN_HOSTS: knownHosts,
    })
}

export async function createHttpServer(config: Config, store: UserStore) {

    const router = express();
    router.disable('x-powered-by');
    if (config.trustedProxy) {
        // config uses "localhost" for a reverse proxy on the same machine, express calls it "loopback"
        router.set('trust proxy', config.trustedProxy === 'localhost' ? 'loopback' : config.trustedProxy);
    }

    const server = http.createServer(router);
    const wsServer = new WebSocketServer({ noServer: true,  });

    wsServer.on('connection', function connection(ws) {
        const tempErrorHandler = () => {
            try {
                ws.close()
            } catch (err) {}
        }
        const tempHandler = async (msg: RawData, isBinary: boolean) => {
            if (isBinary) return

            try {
                const parsed = parseRawData(msg)
                const username: string = String(parsed[0]) ?? ''
                const password: string = String(parsed[1]) ?? ''
                const user = await store.findById(username)
                if (secretEquals(user.password, password)) {
                    console.log(`${username}: [HTTP] ws authenticated`)
                    wsManager.addManagedSocket(username, ws)
                    ws.off('message', tempHandler)
                    ws.off('error', tempErrorHandler)

                    const send = (packet: Packet) => ws.send(JSON.stringify(packet))
                    send({
                        type: 'authenticated',
                        id: getId(username),
                        url: `${config.httpProtocol}://${user.domainName}.${config.httpHost}:${config.httpPort}/`
                    })
                    send({
                        type: 'history',
                        id: -1,
                        entries: inspector.getHistory(username)
                    })

                    ws.on('message', (msg: RawData, isBinary: boolean) => {
                        if (isBinary) return
                        let packet: ClientPacket
                        try {
                            packet = parseRawData(msg)
                        } catch (err) {
                            return
                        }
                        if (packet.type === 'replay' && typeof packet.id === 'number') {
                            inspector.replay(username, packet.id).catch((err: Error) => {
                                send({ type: 'replay-failed', id: packet.id, message: err.message })
                            })
                        }
                    })
                } else {
                    console.log(`[HTTP] failed auth ws attempt`)
                    ws.close(WS_AUTH_FAILED, 'bad username or password')
                }
            } catch (err) {
                console.log(`[HTTP] failed auth ws attempt`)
                ws.close(WS_AUTH_FAILED, 'bad username or password')
            }
        }
        ws.on('message', tempHandler)
        ws.on('error', tempErrorHandler)
        // ...
    });

    const wsManager = new WsManager<Packet>()
    const inspector = new Inspector(wsManager, () => (server.address() as AddressInfo).port)
    var proxy = httpProxy.createProxyServer({
        target: {
            host: 'localhost',
            port: 65535
        }
    });

    server.on('upgrade', function (req, socket, head) {
        
        let domain = req.headers.host?.split(':')[0];

        if (!domain) {
            socket.destroy()
            return
        }

        if (domain === config.setupHost && req.url?.startsWith('/__observe_requests')) {
            console.log(`[HTTP] incoming ws attempt`)
            wsServer.handleUpgrade(req, socket, head, function done(ws) {
                console.log(`[HTTP] emit ws connection`)
                wsServer.emit('connection', ws, req);
            });
            // do not proxy it
            return;
        }


        if (!domain.endsWith(config.httpHost) || domain === config.httpHost) {
            // do not proxy it
            socket.destroy()
            return;
        }

        let id = domain.split('.')[0];

        store.findByDomain(id)
        .then(async function (userData) {
            if (!userData.allowsVisitor(req.headers.authorization)) {
                socket.end(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${VISITOR_AUTH_CHALLENGE}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
                throw Error('visitor not authenticated')
            }
            if (userData.httpPort !== 0) {
                const agent = await userData.getConnectionAgent();
                return [userData, agent] as const;
            } else {
                throw Error('not in forward mode')
            }
        })
        .then(function ([userData, agent]) {
            if (agent) {
                proxy.ws(req, socket, head, {
                    target: {
                        host: 'localhost',
                        port: userData.httpPort!
                    },
                    agent: Object.assign(new http.Agent(), {
                        // http.Agent accepts a callback when the connection is created asynchronously
                        createConnection: function (_opts: any, cb: (err: Error | null, stream?: Duplex) => void) {
                            agent.createConnection(function(err, stream) {
                                if (err) {
                                    return cb(err);
                                }
                                console.log(`${userData.id}: [HTTP] Forward ${req.method} http connection established at ${req.url} of ${userData.domainName}`);
                                // the visitor may vanish without the proxy ending the channel
                                socket.once('close', () => stream!.destroy());
                                cb(null, asSocket(stream!));
                            })
                            return undefined
                        }
                    })
                });
            }
        })
        .catch(function (err) {
            // let a response written with end() go out first
            if (socket.writableEnded) setTimeout(() => socket.destroy(), 1000).unref()
            else socket.destroy()
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

        let subdomain = domain.split('.')[0];

        let aborted = false
        req.on('error', () => {
            aborted = true
            try {
                res.destroy()
            } catch (err) {}
        })

        if (!store.getByDomain(subdomain)) {
            res.status(404).type('text/plain').end('No forward is registered for this domain')
            return
        }

        store.findByDomain(subdomain)
        .then(function(userData) {
            if (aborted) {
                throw new Error('aborted')
            }

            // before tracking, scanners guessing passwords should not fill the inspector
            if (!userData.allowsVisitor(req.headers.authorization)) {
                res.setHeader('WWW-Authenticate', VISITOR_AUTH_CHALLENGE)
                res.status(401).type('text/plain').end('This forward needs a user name and password')
                return
            }

            const tracker = inspector.track(userData.id!, req, res, { remoteAddress: req.ip ?? '' })

            if (userData.httpPort !== 0) {
                userData.getConnectionAgent()
                .then(function(agent) {
                    // the app may keep the connection alive and node does not end a socket it got
                    // from createConnection, so close the channel once the visitor got the response
                    let channel: Duplex | null = null
                    let finished = false
                    res.once('close', function() {
                        finished = true
                        channel?.destroy()
                    })

                    let client = http.request({
                        createConnection: function(opts, cb) {
                            agent.createConnection(function(err, stream) {
                                if (err) {
                                    userData.requestSuicideTimer()
                                    return cb(err, null as never);
                                }
                                userData.clearSuicideTimer()
                                channel = stream!
                                if (finished) {
                                    stream!.destroy()
                                    return cb(new Error('visitor disconnected'), null as never);
                                }
                                console.log(`${userData.id}: [HTTP] Forward ${req.method} http connection established at ${req.originalUrl} of ${userData.domainName}`);
                                cb(null as never, asSocket(stream!));
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
                        tracker.requestTap(),
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
                        res.writeHead(msg.statusCode!, msg.headers)


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
                let fullPath = path.resolve(remoteMountPoint!, reqPath.slice(1));
                let realBaseDir = path.dirname(fullPath);
                let realBaseName = path.basename(fullPath)

                const pathInMountPoint = path.relative(remoteMountPoint!, fullPath)
                if (pathInMountPoint === '..' || pathInMountPoint.startsWith('../') || path.isAbsolute(pathInMountPoint)) {
                    return res.status(403).end('Out of folder reading rejected');
                }
                
                userData.getSftp()
                .then(function (sftpClient) {
                    userData.clearSuicideTimer()
                    const sendFile = (filePath: string, stats: Stats) => {
                        let size = stats.size;
                        let contentType = getContentType(path.basename(filePath));
                        let readStream: ReturnType<typeof getFastReadStream> | null = null;

                        res.set('Content-Type', contentType);
                        res.set('Content-Length', String(size));
                        res.set('Accept-Ranges', 'bytes');

                        // every read goes through the tunnel, let browsers check back cheaply instead.
                        // no-cache: the shared files can change at any time, so always ask first
                        const etag = fileEtag(stats)
                        const lastModified = new Date(stats.mtime * 1000).toUTCString()
                        res.set('ETag', etag);
                        res.set('Last-Modified', lastModified);
                        res.set('Cache-Control', 'no-cache');
                        if (req.fresh) {
                            res.removeHeader('Content-Length');
                            return res.status(304).end();
                        }

                        // a range of a file that changed since would mix two versions, send all of it then
                        const ifRange = req.headers['if-range']
                        const rangeStillValid = !ifRange || ifRange === etag || ifRange === lastModified
                        const range = rangeStillValid ? req.range(size) : undefined

                        if (req.method === 'HEAD') {
                            return res.end();
                        }

                        // the size from the stat above saves the stream a round trip
                        if (range == null) {
                            readStream = getFastReadStream(sftpClient, filePath, { size });
                        } else if (range !== -1 && range !== -2 && range.type === 'bytes' && range.length === 1) {
                            res.set('Content-Length', String(range[0].end - range[0].start + 1));

                            res.set('Content-Range', `bytes ${range[0].start}-${range[0].end}/${stats.size}`)
                            readStream = getFastReadStream(sftpClient, filePath, { size, start: range[0].start, end: range[0].end });
                            res.status(206);
                        } else {
                            res.set('Content-Type', 'text/html');
                            res.removeHeader('Content-Length');
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
                            res.removeHeader('Content-Length');
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
                    }

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

                            const listDirectory = () => sftpClient.readdir(fullPath, function(err, files) {
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

                            // a folder with an index.html is a site, show that instead of the listing.
                            // a symlinked index.html is listed instead, following it could leave the folder
                            if (!userData.serveIndex) {
                                return listDirectory()
                            }
                            const indexPath = path.join(fullPath, 'index.html')
                            return sftpClient.lstat(indexPath, function(err, indexStats) {
                                if (!err && indexStats.isFile()) {
                                    return sendFile(indexPath, indexStats)
                                }
                                listDirectory()
                            })
                        } else if (stats.isFile()) {
                            console.log(`${userData.id}: [HTTP] is file  ${fullPath}`);
                            return sendFile(fullPath, stats)
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

        if (domain !== config.httpHost || (config.httpHost === config.setupHost && config.httpPort === config.setupPort)) {
            return next();
        }

        res.end(`This is a domain that serves user content.`)
    })

    const templatePromise = fs.readFile(path.join(__dirname, '../template/script.template'), 'utf8')
    // read on each request, host keys are generated on the first start
    const knownHostsPromise = () => knownHostsLines(store.hostKeyDir, config.sshHost, config.sshPort).then(lines => lines.join('\n'))

    router.post('/setup', function(req, res, next) {
        let domain = req.hostname;

        if (domain !== config.setupHost) {
            return next();
        }

        if (config.setupRequireAuth) {
            const credential = parseBasicAuth(req.headers.authorization)

            if (!credential) {
                res.setHeader('WWW-Authenticate', 'Basic realm="Not authenticated"')
                res.status(401)
                res.end('')
                return
            }

            // check both, so the time taken does not tell whether the account was right
            const accountMatches = secretEquals(config.setupAccount, credential.account)
            const passwordMatches = secretEquals(config.setupPassword, credential.password)
            if (!accountMatches || !passwordMatches) {
                res.status(401)
                res.end('bad credential')
                return
            }
        }

        store.create()
            .then(function(userData) {
                return Promise.all([userData, templatePromise, knownHostsPromise()])
            })
            .then(function([userData, template, knownHosts]) {
                res.set('Content-Type', 'application/x-sh');

                res.end(renderClientScript(template, config, userData, knownHosts))
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

        const credential = parseBasicAuth(req.headers.authorization)

        if (!credential) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Not authenticated"')
            res.status(401)
            res.end('')
            return
        }

        const { account, password } = credential

        store.findById(account)
        .then((userData) => {
            if (!secretEquals(userData.password, password)) {
                throw new Error('not authenticated')
            }
            return userData
        })
        .then(function(userData) {
            return Promise.all([userData, templatePromise, knownHostsPromise()])
        })
        .then(function([userData, template, knownHosts]) {
            res.set('Content-Type', 'application/x-sh');

            res.end(renderClientScript(template, config, userData, knownHosts))
        })
        .catch((err) => {
            console.log(`${account}: [HTTP] denied update due to ${err}`);
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

        // browsers get the landing page, curl and other tools keep the plain text instructions
        if (req.accepts(['text/plain', 'text/html']) === 'text/html') {
            const setupOrigin = formatOrigin(config.setupProtocol, config.setupHost, config.setupPort)
            const exampleHost = `brave-otter-42-k3x9qz.${config.httpHost}`
            return res.render('landing', {
                setupHost: config.setupHost,
                setupOrigin,
                setupCommand: `curl -X POST${config.setupRequireAuth ? " -u 'username:password'" : ''} ${setupOrigin}/setup > run.sh`,
                runCommand: 'chmod +x run.sh && ./run.sh',
                requireAuth: config.setupRequireAuth,
                inspectorUrl: '/app/',
                exampleHost,
                exampleUrl: formatOrigin(config.httpProtocol, exampleHost, config.httpPort),
                socksHost: config.socksHost,
                socksPort: config.socksPort,
                sshPort: config.sshPort,
            })
        }

        res.type('text/plain').end(`
Run following command to setup the forward !!!

$ curl -X POST${config.setupRequireAuth ? ' -u \'username:password\'': ''} ${config.setupProtocol}://${config.setupHost}:${config.setupPort}/setup > run.sh
$ chmod 755 run.sh
$ ./run.sh
`)
    })

    if (process.env.NODE_ENV !== 'development') {
        router.use('/app', express.static('app/dist'))

        router.use('/app', (req, res, next) => {
            res.sendFile('app/dist/index.html', { root: path.resolve(__dirname, '../') })
        })
    } else {
        const viteServerMiddleware = await (await import("./vite_dev_server.mjs")).createServer(server, [config.setupHost])
        router.use(viteServerMiddleware.middlewares)
    }

    return { router, server }
}

export default async function(config: Config, store: UserStore) {
    const { server } = await createHttpServer(config, store)

    server.listen(config.httpListen || 8080, "0.0.0.0", function() {
        let addr = server.address() as AddressInfo;
        console.log("Http server listening at", addr.address + ":" + addr.port);
        console.log("Http server exposed at", `${config.httpProtocol}://${config.httpHost}:${config.httpPort}/`);
        console.log('To setup a new client use', `curl -X POST${config.setupRequireAuth ? ` -u '${config.setupAccount}:${config.setupPassword.replace("'", `'"'"'`)}'`: ''} ${config.setupProtocol}://${config.setupHost}:${config.setupPort}/setup`)
    });
}
