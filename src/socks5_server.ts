import net from 'net'
import { inspect } from 'util'
import { User } from './user'
import { UserStore } from './store'
import { Config } from './interface'
import { closeWhenDone, secretEquals } from './utils'
import {
    AddressTypeError,
    AUTH_VERSION,
    COMMAND_CONNECT,
    METHOD_NONE_ACCEPTABLE,
    METHOD_USER_PASS,
    parseGreeting,
    parseRequest,
    parseUserPass,
    reply,
    ReplyStatus,
    SOCKS_VERSION,
} from './socks5'

export interface SocksServerOptions {
    /** ms a client has from connecting until its connection is set up */
    handshakeTimeout?: number
}

const AUTH_SUCCESS = Buffer.from([AUTH_VERSION, 0x00])
const AUTH_FAILURE = Buffer.from([AUTH_VERSION, 0x01])

/** SOCKS5 sends the password in the clear, so it has a password of its own, not the account one */
const passwordMatches = (user: User, password: string) => secretEquals(user.socksPassword, password)

/**
 * SOCKS5 with username/password auth and the CONNECT command only. Connections go to
 * localhost:<port> on the user's machine through an ssh channel, whatever host is asked for.
 */
export function createSocksServer(config: Config, store: UserStore, options: SocksServerOptions = {}) {
    const handshakeTimeout = options.handshakeTimeout ?? 30 * 1000

    return net.createServer(function (socket) {
        socket.setNoDelay(true)
        socket.on('error', () => {})

        let stage: 'greeting' | 'auth' | 'request' | 'connecting' = 'greeting'
        let buffer: Buffer = Buffer.alloc(0)
        let user: User | undefined

        const timer = setTimeout(() => socket.destroy(), handshakeTimeout)
        socket.on('close', () => clearTimeout(timer))

        const fail = (response?: Buffer) => {
            socket.off('data', onData)
            if (response) {
                socket.end(response)
                // do not wait for a client that never closes its side
                setTimeout(() => socket.destroy(), 1000).unref()
            } else {
                socket.destroy()
            }
        }

        const consume = (length: number) => {
            buffer = buffer.subarray(length)
        }

        function onData(chunk: Buffer) {
            buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk

            while (stage !== 'connecting') {
                if (stage === 'greeting') {
                    const greeting = parseGreeting(buffer)
                    if (greeting === null) return
                    if (greeting instanceof Error) return fail()
                    consume(greeting.length)
                    if (!greeting.value.includes(METHOD_USER_PASS)) {
                        return fail(Buffer.from([SOCKS_VERSION, METHOD_NONE_ACCEPTABLE]))
                    }
                    socket.write(Buffer.from([SOCKS_VERSION, METHOD_USER_PASS]))
                    stage = 'auth'
                } else if (stage === 'auth') {
                    const credential = parseUserPass(buffer)
                    if (credential === null) return
                    if (credential instanceof Error) return fail(AUTH_FAILURE)
                    consume(credential.length)
                    const found = store.getById(credential.value.username)
                    if (!found || !passwordMatches(found, credential.value.password)) {
                        return fail(AUTH_FAILURE)
                    }
                    user = found
                    socket.write(AUTH_SUCCESS)
                    stage = 'request'
                } else {
                    const request = parseRequest(buffer)
                    if (request === null) return
                    if (request instanceof AddressTypeError) return fail(reply(ReplyStatus.AddressTypeNotSupported))
                    if (request instanceof Error) return fail()
                    if (request.value.command !== COMMAND_CONNECT) return fail(reply(ReplyStatus.CommandNotSupported))
                    consume(request.length)
                    stage = 'connecting'

                    // hold whatever the client already sent until the channel is open
                    socket.off('data', onData)
                    socket.pause()
                    if (buffer.length) socket.unshift(buffer)
                    buffer = Buffer.alloc(0)
                    connect(user!, request.value.port)
                }
            }
        }

        function connect(user: User, port: number) {
            user.getClient()
            .then(function (sshClient) {
                sshClient.forwardOut('localhost', ~~(Math.random() * 65535), 'localhost', port, function (err, channel) {
                    if (err) {
                        console.log(`${user.id}: [Socks5] forward to port ${port} failed: ${err.message}`)
                        return fail(reply(ReplyStatus.ConnectionRefused))
                    }
                    if (socket.destroyed) {
                        channel.destroy()
                        return
                    }

                    console.log(`${user.id}: [Socks5] Forward sock connection established at port ${port}`)
                    clearTimeout(timer)
                    closeWhenDone(channel)
                    channel.on('error', () => socket.destroy())
                    // a reset visitor never ends its side, close the channel anyway
                    socket.on('close', () => channel.destroy())
                    socket.write(reply(ReplyStatus.Granted))
                    socket.pipe(channel).pipe(socket)
                })
            })
            .catch(function (err) {
                console.log(`${user.id}: [Socks5] no connection to the client: ${inspect(err)}`)
                fail(reply(ReplyStatus.HostUnreachable))
            })
        }

        socket.on('data', onData)
    })
}

export default function(config: Config, store: UserStore) {
    const server = createSocksServer(config, store)

    server.listen(config.socksListen, "0.0.0.0", function() {
        console.log('SOCKS server listening on port ' + config.socksListen);
    });
}
