import { ClientPacket, Config, Packet } from "./interface";

import http from "http";
import express from "express";
const inspect = require('util').inspect;
import { clientScripts } from "./template";
import path from "path";
import { UserStore } from "./store";
import { updatesOnlyOverSsh } from "./ssh_server";
import { asSocket, decodePath, formatOrigin, getContentType, parseBasicAuth, parseRawData, secretEquals } from "./utils";
import getFastReadStream from "./ssh_fast_read_stream";
import httpProxy from 'http-proxy';
import { RawData, WebSocketServer } from 'ws';
import type { Stats } from "ssh2";
import { AddressInfo } from "net";
import { Duplex, pipeline } from "stream";
import { WsManager } from "./ws_manager";
import { Inspector } from "./inspector";
import { folderView, hasHiddenSegment } from "./listing";

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

/** what a visitor of a forward is told when it can not be served, the details only go to the log */
const VISITOR_ERRORS = {
    'unknown-domain': [404, 'Nothing is shared here', 'No one is sharing anything at this address.'],
    'needs-auth': [401, 'Sign in required', 'This address needs a user name and password.'],
    'offline': [502, 'This address is offline', 'The computer sharing it is not connected right now. Try again later.'],
    'app-unreachable': [502, 'Nothing answered', 'The computer sharing this address is connected, but the app it shares did not answer.'],
    'not-found': [404, 'Not found', 'There is no file at this address.'],
    'forbidden': [403, 'Not available', 'This file can not be shared.'],
    'bad-range': [416, 'Range not satisfiable', 'The requested part is outside of the file.'],
    'failed': [500, 'Something went wrong', 'The gateway could not finish this request. Try again later.'],
} as const satisfies Record<string, readonly [number, string, string]>

export type VisitorError = keyof typeof VISITOR_ERRORS

/**
 * what /update answers once the user updates over ssh only, see updatesOnlyOverSsh. Older scripts
 * tell users to run curl ... > run.sh, so this lands in run.sh and says what to do instead
 */
const UPDATES_OVER_SSH_SCRIPT = `#! /bin/bash
echo "The gateway no longer hands out this script for the password, a newer copy of it connected" >&2
echo "before. Copy that one here and run it with --update to get the current version." >&2
exit 1
`

/** the file viewer on the setup host reads folder shares with these, see the user content handler */
const VIEWER_CORS_EXPOSED = 'Content-Range, ETag'
const VIEWER_CORS_MAX_AGE = 600

/** headers a file response sets early, which must not stay on an error */
const FILE_HEADERS = ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']

/** sftp status codes (ssh2 STATUS_CODE) */
const SFTP_NO_SUCH_FILE = 2
const SFTP_PERMISSION_DENIED = 3

const sftpErrorKind = (err: Error): VisitorError => {
    const code = (err as Error & { code?: unknown }).code
    return code === SFTP_NO_SUCH_FILE ? 'not-found' : code === SFTP_PERMISSION_DENIED ? 'forbidden' : 'failed'
}

interface VisitorErrorOptions {
    /** logged with the user id, never sent to the visitor */
    err?: unknown
    userId?: string | null
    headers?: Record<string, string>
}

/** answer a visitor with an error page for browsers, plain text for everything else */
export function sendVisitorError(req: express.Request, res: express.Response, kind: VisitorError, options: VisitorErrorOptions = {}) {
    if (options.err !== undefined) {
        console.error(`${options.userId ?? '<unknown user>'}: [HTTP] ${kind} for ${req.method} ${req.originalUrl}: ${inspect(options.err)}`)
    }
    // two failures of one request, like a proxy error followed by the pipeline's
    if (res.locals.visitorError) return
    if (res.headersSent) {
        // the response is under way, all that is left is to cut it short
        res.destroy()
        return
    }
    res.locals.visitorError = kind

    const [status, title, message] = VISITOR_ERRORS[kind]
    for (const name of FILE_HEADERS) res.removeHeader(name)
    res.status(status).set('Cache-Control', 'no-store').set(options.headers ?? {})
    if (req.accepts(['text/plain', 'text/html']) === 'text/html') {
        res.render('error', { status, title, message })
    } else {
        res.type('text/plain').end(`${title}\n${message}\n`)
    }
}

/** like nginx: changes with the modification time or the size, whichever the edit touched */
export function fileEtag(stats: Pick<Stats, 'mtime' | 'size'>) {
    return `"${Math.floor(stats.mtime).toString(16)}-${stats.size.toString(16)}"`
}

export async function createHttpServer(config: Config, store: UserStore) {

    const router = express();
    router.disable('x-powered-by');
    if (config.trustedProxy) {
        // config uses "localhost" for a reverse proxy on the same machine, express calls it "loopback"
        router.set('trust proxy', config.trustedProxy === 'localhost' ? 'loopback' : config.trustedProxy);
    }

    const setupOrigin = formatOrigin(config.setupProtocol, config.setupHost, config.setupPort)

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
            return sendVisitorError(req, res, 'unknown-domain')
        }

        store.findByDomain(subdomain)
        .then(function(userData) {
            if (aborted) {
                throw new Error('aborted')
            }

            // the file viewer on the setup host may read folder shares, never the apps of forwards.
            // before the password check, so it can tell a missing password from other failures
            if (userData.httpPort === 0) {
                res.vary('Origin')
                if (req.headers.origin === setupOrigin) {
                    res.set({
                        'Access-Control-Allow-Origin': setupOrigin,
                        'Access-Control-Allow-Credentials': 'true',
                        'Access-Control-Expose-Headers': VIEWER_CORS_EXPOSED,
                    })
                    // browsers send preflights without the password
                    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
                        res.set({
                            'Access-Control-Allow-Methods': 'GET, HEAD',
                            'Access-Control-Allow-Headers': 'Range',
                            'Access-Control-Max-Age': String(VIEWER_CORS_MAX_AGE),
                        })
                        return res.status(204).end()
                    }
                }
            }

            // before tracking, scanners guessing passwords should not fill the inspector
            if (!userData.allowsVisitor(req.headers.authorization)) {
                return sendVisitorError(req, res, 'needs-auth', { headers: { 'WWW-Authenticate': VISITOR_AUTH_CHALLENGE } })
            }

            const tracker = inspector.track(userData.id!, req, res, { remoteAddress: req.ip ?? '' })

            if (userData.httpPort !== 0) {
                userData.getConnectionAgent()
                .then(function(agent) {
                    // the app may keep the connection alive and node does not end a socket it got
                    // from createConnection, so close the channel once the visitor got the response
                    let channel: Duplex | null = null
                    // the visitor may have left while waiting for the tunnel, 'close' is already over then
                    let finished = res.destroyed
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

                    // also after a response started, then sendVisitorError cuts it short
                    client.on('error', function(err) {
                        sendVisitorError(req, res, 'app-unreachable', { err, userId: userData.id })
                    })


                    pipeline(
                        req,
                        tracker.requestTap(),
                        client,
                        (error) => {
                            if (error) {
                                sendVisitorError(req, res, 'app-unreachable', { err: error, userId: userData.id })
                                try {
                                    client.destroy()
                                } catch (err) {}
                            }
                        }
                    )

                    client.on('response', function(msg) {
                        // destroy() of an ssh2 channel only asks the client to close it, an answer already on
                        // its way still arrives after the visitor left. pipeline() throws for a closed res
                        // since node 24, inside the ssh2 parser that is an error of the whole connection
                        // and the tunnel went down with it
                        if (res.destroyed) {
                            client.destroy()
                            return
                        }
                        res.writeHead(msg.statusCode!, msg.headers)


                        pipeline(
                            msg,
                            res,
                            (error) => {
                                if (error) {
                                    sendVisitorError(req, res, 'app-unreachable', { err: error, userId: userData.id })
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
                    sendVisitorError(req, res, 'offline', { err, userId: userData.id })
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
                    return sendVisitorError(req, res, 'forbidden')
                }
                // .git and .env are rarely meant to be shared, answer as if they did not exist
                if (!userData.serveDotfiles && hasHiddenSegment(reqPath)) {
                    return sendVisitorError(req, res, 'not-found')
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
                            return sendVisitorError(req, res, 'bad-range', { headers: { 'Content-Range': `bytes */${size}` } })
                        }

                        readStream.on('error', function(err) {
                            if (req.closed) {
                                return;
                            }
                            sendVisitorError(req, res, sftpErrorKind(err), { err, userId: userData.id })
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
                            return sendVisitorError(req, res, sftpErrorKind(err), { err, userId: userData.id })
                        }

                        if (stats.isSymbolicLink()) {
                            return sftpClient.readlink(fullPath, function(err, realPath) {
                                if (err) {
                                    return sendVisitorError(req, res, sftpErrorKind(err), { err, userId: userData.id })
                                }

                                /** `realPath` can be sometimes relative path*/
                                realPath = path.resolve(path.dirname(fullPath) + '/', realPath)
                                console.log(`${userData.id}: [HTTP] real path: ${realPath}, mount point: ${remoteMountPoint}`);

                                let relativePath = path.relative(remoteMountPoint!, realPath);
                                console.log(`${userData.id}: [HTTP] path relative to root: ${relativePath}`)

                                if (relativePath.indexOf('../') >= 0) {
                                    return sendVisitorError(req, res, 'forbidden')
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
                                    return sendVisitorError(req, res, sftpErrorKind(err), { err, userId: userData.id })
                                }

                                res.render('folder', folderView(reqPath, files, {
                                    siteName: userData.domainName!,
                                    showHidden: userData.serveDotfiles,
                                    viewer: `${setupOrigin}/app/view/#${formatOrigin(config.httpProtocol, `${userData.domainName}.${config.httpHost}`, config.httpPort)}`,
                                }))
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
                            // sockets, devices and the like
                            return sendVisitorError(req, res, 'forbidden')
                        }

                    })
                })
                .catch(function(err) {
                    userData.requestSuicideTimer()
                    sendVisitorError(req, res, 'offline', { err, userId: userData.id })
                })

                return;
            }
            // return res.end('not yet implement')
        })
        .catch(function(err) {
            if (!aborted) {
                sendVisitorError(req, res, 'failed', { err })
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

    const clientScriptFor = clientScripts(config, store.hostKeyDir)

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
            .then(clientScriptFor)
            .then(function(script) {
                res.set('Content-Type', 'application/x-sh');

                res.end(script)
            })
            .catch(function(err) {
                console.error(`[HTTP] setup failed: ${inspect(err)}`)
                res.status(500).type('text/plain').end('Could not create the user, the gateway log has the details\n')
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
            if (updatesOnlyOverSsh(userData)) {
                console.log(`${account}: [HTTP] refused update, a script that updates over ssh registered before`);
                res.status(403).set('Content-Type', 'application/x-sh').set('Cache-Control', 'no-store')
                res.end(UPDATES_OVER_SSH_SCRIPT)
                return
            }
            return clientScriptFor(userData).then(function(script) {
                res.set('Content-Type', 'application/x-sh');

                res.end(script)
            })
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
