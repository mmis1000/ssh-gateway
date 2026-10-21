const inspect = require('util').inspect;
import { Client, SFTPWrapper, ServerChannel } from 'ssh2';
import { Connection, TcpipBindInfo } from "ssh2";
import { createTaskQueue } from './utils';
import { Duplex } from 'stream';

const MAX_SUICIDE_REQUEST = 3
const SUICIDE_DELAY = 30 * 1000

export interface UserData {
    id: string,
    password: string
    domainName: string
    /** key the client logs in to the gateway with, handed out in the setup script */
    clientKey: string
    clientKeyPub: string
    /** key the gateway logs in to the client side sshd with */
    gatewayKey: string
    gatewayKeyPub: string
}

export enum Protocol {
    V0 = 0,
    V1 = 1
}


export interface ConnectionAgent {
    createConnection(cb: (err?: Error, stream?: Duplex) => void): void
}

class User {
    id: string | null
    clientKey: string | null
    clientKeyPub: string | null
    gatewayKey: string | null
    gatewayKeyPub: string | null
    domainName: string | null
    password: string | null
    // sshState: number
    remoteUser: string | null
    httpPort: number | null
    protocolVersion: Protocol.V0 | Protocol.V1 = Protocol.V0
    /** the ssh connection that holds the current tunnel, only it may tear the tunnel down */
    tunnelConnection: Connection | null = null

    // sftpState: number
    staticDirectory: string | null
    // tunnelClient: Connection | null
    // tunnelInfo: TcpipBindInfo | null
    // sshClient: Client | null
    // sftpClient: SFTPWrapper | null
    suicideRequestCount = 0


    suicideTimer: null | ReturnType<typeof setTimeout> = null

    constructor(data: UserData) {
        this.id = null;
        this.clientKey = null;
        this.clientKeyPub = null;
        this.gatewayKey = null;
        this.gatewayKeyPub = null;
        this.domainName = null;
        this.password = null;

        // this.tunnelClient = null;
        // this.tunnelInfo = null;

        // this.sshState = User.SSH_CLIENT_STATE.DISCONNECT;
        // this.sshClient = null;
        this.remoteUser = null;

        /** 0 to disable forward */
        this.httpPort = null;
        /** Path for folder to serve as static http site */
        this.staticDirectory = null;

        // this.sftpState = User.SFTP_CLIENT_STATE.DISCONNECT;
        // this.sftpClient = null;

        for (let key in data) {
            (this as any)[key] = (data as any)[key];
        }
    }
    tunnelQueue = createTaskQueue(20 * 1000, (emitter) => {
        // a promise that never resolve
        return new Promise<[Connection, TcpipBindInfo, Protocol]>(() => {})
    })

    clientQueue = createTaskQueue(25 * 1000, (emitter) => {
        const tunnelPromise = this.tunnelQueue.request()
        tunnelPromise.onDestroy(() => {
            this.clientQueue.reset()
        })

        const destroyPromise = new Promise<never>((_, reject) => tunnelPromise.onDestroy(() => { reject(new Error('tunnel destroyed')) }))
        const clientPromise = (async () => {
            const [tunnel, info] = await tunnelPromise

            const channel = await new Promise<ServerChannel>((resolve, reject) => {
                tunnel.forwardOut(info.bindAddr, info.bindPort, '127.0.0.1', 9999, (err, channel1) => {
                    if (err) {
                        console.error(inspect(err));
                        return reject(err)
                    }
                    resolve(channel1)
                })
            })
            

            // FIXME: monkey patch!!!!
            ;(channel.stderr as any).resume = function nuzz() { };

            const client = new Client();

            tunnelPromise.onDestroy(() => {
                client.destroy()
                emitter.emit()
            })

            const result = new Promise<Client>((resolve) => {
                client.on('ready', () => {
                    console.log(`${this.id}: [User] Client ready !!!`);
                    resolve(client)
                });
            })

            client.connect({
                sock: channel,
                username: this.remoteUser!,
                privateKey: this.gatewayKey!,
                debug: console.log,
            });

            client.on('banner', function (msg) {
                console.log(msg)
            });

            client.on('error', function (err) {
                console.error(inspect(err));
                emitter.emit()
            });

            client.on('close', () => {
                console.error('client error abort');
                emitter.emit()
            });

            return result
        })()

        return Promise.race([destroyPromise, clientPromise])
    })

    connectionAgentQueue = createTaskQueue(30 * 1000, (emitter) => {
        const tunnelPromise = this.tunnelQueue.request()
        tunnelPromise.onDestroy(() => {
            this.connectionAgentQueue.reset()
        })

        const destroyPromise = new Promise<never>((_, reject) => tunnelPromise.onDestroy(() => { reject(new Error('tunnel destroyed')) }))


        const agentPromise = (async () => {
            const [tunnel, info, protocol] = await tunnelPromise

            if (protocol === Protocol.V0) {
                const channel = await new Promise<ServerChannel>((resolve, reject) => {
                    tunnel.forwardOut(info.bindAddr, info.bindPort, '127.0.0.1', 9999, (err, channel1) => {
                        if (err) {
                            console.error(inspect(err));
                            return reject(err)
                        }
                        resolve(channel1)
                    })
                })

                // FIXME: monkey patch!!!!
                ;(channel.stderr as any).resume = function nuzz() { };

                const client = new Client();

                tunnelPromise.onDestroy(() => {
                    client.destroy()
                    emitter.emit()
                })

                const result = new Promise<ConnectionAgent>((resolve) => {
                    client.on('ready', () => {
                        console.log(`${this.id}: [User] Client ready !!!`);

                        const agent: ConnectionAgent = {
                            createConnection: (cb) => {
                                client.forwardOut('localhost',  ~~(Math.random() * 65535), 'localhost', this.httpPort!, cb)
                            },
                        }

                        resolve(agent)
                    });
                })

                client.connect({
                    sock: channel,
                    username: this.remoteUser!,
                    privateKey: this.gatewayKey!,
                    debug: console.log,
                });

                client.on('banner', function (msg) {
                    console.log(msg)
                });

                client.on('error', function (err) {
                    console.error(inspect(err));
                    emitter.emit()
                });

                client.on('close', () => {
                    console.error('client error abort');
                    emitter.emit()
                });

                return result
            } else if (protocol === Protocol.V1) {
                const agent: ConnectionAgent = {
                    createConnection: (cb) => {
                        tunnel.forwardOut(info.bindAddr, info.bindPort, '127.0.0.1',  ~~(Math.random() * 65535), cb)
                    },
                }

                return agent
            } else {
                throw new Error('unknown protocol?')
            }

        })()

        return Promise.race([destroyPromise, agentPromise])
    })

    sftpQueue = createTaskQueue(30 * 1000, async (emitter) => {
        const clientPromise = this.clientQueue.request()

        clientPromise.onDestroy(() => {
            this.sftpQueue.reset()
            emitter.emit()
        })

        const client = await clientPromise

        const sftpStream = await new Promise<SFTPWrapper>((resolve, reject) => {
            client.sftp((err?: Error, sftpStream?: SFTPWrapper) => {
                if (err) {
                    return reject(err)
                }
                resolve(sftpStream!)
            })
        })

        clientPromise.onDestroy(() => {
            sftpStream.destroy()
        })

        
        console.log(`${this.id}: [User] SFTP ready`);

        let cleanup = () => {
            emitter.emit()
        }

        sftpStream.once('end', cleanup);
        sftpStream.once('close', cleanup);
        sftpStream.once('error', cleanup);

        return sftpStream
    })

    requestSuicideTimer () {
        console.log(`${this.id}: [User] check alive ${this.suicideRequestCount}/${MAX_SUICIDE_REQUEST}`)

        if (this.suicideRequestCount < MAX_SUICIDE_REQUEST) {
            this.suicideRequestCount++
        }
        if (this.suicideRequestCount >= MAX_SUICIDE_REQUEST) {
            if (this.suicideTimer == null) {
                this.suicideTimer = setTimeout(() => {
                    this.tunnelQueue.reset()
                }, SUICIDE_DELAY)
            }
        }
    }
    clearSuicideTimer () {
        console.log(`${this.id}: [User] clear alive ${this.suicideRequestCount}/${MAX_SUICIDE_REQUEST}`)

        this.suicideRequestCount = 0
        if (this.suicideTimer != null) {
            clearTimeout(this.suicideTimer)
            this.suicideTimer = null
        }
    }

    resetConnection() {
        this.tunnelQueue.reset()
        this.clientQueue.reset()
        this.sftpQueue.reset()
    }
    getClient() {
        return this.clientQueue.request()
    }
    getConnectionAgent() {
        return this.connectionAgentQueue.request()
    }
    getSftp() {
        return this.sftpQueue.request()
    }
    disconnectAll() {
        this.tunnelQueue.reset()
        this.connectionAgentQueue.reset()
        this.clientQueue.reset()
        this.sftpQueue.reset()
    }
}

export {
    User
}
