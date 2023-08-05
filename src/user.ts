const inspect = require('util').inspect;
import { Client, SFTPWrapper, ServerChannel } from 'ssh2';
import path from "path";
// import config from '../config.json';
import fs from "fs-extra";
const getRandomDomain = require("human-readable-ids").hri.random.bind(require("human-readable-ids").hri);
import { ChildProcess, execFile as exec } from 'child_process'
import { Connection, TcpipBindInfo } from "ssh2";
import { createTaskQueue } from './utils';

// const saveDir = path.resolve(__dirname, '../', config.saveDir);

const MAX_SUICIDE_REQUEST = 3
const SUICIDE_DELAY = 30 * 1000

function randId() {
    return Math.random().toString(36).substr(2, 10);
}

function promiseFromChildProcess(child: ChildProcess) {
    return new Promise(function (resolve, reject) {
        child.addListener("error", reject);
        child.addListener("exit", resolve);
    });
}

interface UserData {
    id: string,
    password: string
    domainName: string
    publicKey: string
    publicKey_pub: string
    privateKey: string
    privateKey_pub: string
}


class User {
    id: string | null
    publicKey: string | null
    publicKey_pub: string | null
    privateKey: string | null
    privateKey_pub: string | null
    domainName: string | null
    password: string | null
    // sshState: number
    remoteUser: string | null
    httpPort: number | null
    // sftpState: number
    staticDirectory: string | null
    // tunnelClient: Connection | null
    // tunnelInfo: TcpipBindInfo | null
    // sshClient: Client | null
    // sftpClient: SFTPWrapper | null
    suicideRequestCount = 0
    suicideTimer: null | ReturnType<typeof setTimeout> = null

    saveDir: string
    constructor(saveDir: string, data: UserData) {
        // super()

        this.saveDir = saveDir

        this.id = null;
        this.publicKey = null;
        this.publicKey_pub = null;
        this.privateKey = null;
        this.privateKey_pub = null;
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
        return new Promise<[Connection, TcpipBindInfo]>(() => {})
    })
    clientQueue = createTaskQueue(25 * 1000, (emitter) => {
        // a promise that never resolve
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
                privateKey: this.publicKey!,
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
    getSftp() {
        return this.sftpQueue.request()
    }
    disconnectAll() {
        this.tunnelQueue.reset()
        this.clientQueue.reset()
        this.sftpQueue.reset()
    }
}

const userMap = new Map<string, Promise<User>>();
const domainMap = new Map<string, Promise<User>>();

function getUserWithName(saveDir: string, name: string) {
    if (userMap.has(name)) {
        console.log(`${name}: [User] Try access user from in process cache (id ${name})`)
        return userMap.get(name)!
    }

    const userPromise = fs.readJson(path.resolve(saveDir, name, 'info.json'))
        .then(function (info) {
            return Promise.all([
                info,
                fs.readFile(path.resolve(saveDir, info.id, 'public_key'), 'utf8'),
                fs.readFile(path.resolve(saveDir, info.id, 'public_key.pub'), 'utf8'),
                fs.readFile(path.resolve(saveDir, info.id, 'private_key'), 'utf8'),
                fs.readFile(path.resolve(saveDir, info.id, 'private_key.pub'), 'utf8')
            ])
        })
        .then(function ([info, publicKey, publicKey_pub, privateKey, privateKey_pub]) {
            info.domainName = info.domain;
            delete info.domain;

            info.publicKey = publicKey;
            info.publicKey_pub = publicKey_pub;
            info.privateKey = privateKey;
            info.privateKey_pub = privateKey_pub;

            let user = new User(saveDir, info);
            if (userMap.has(user.id!) && domainMap.has(user.domainName!)) {
                console.log(`${user.id}: [User] Skip writing user to cache due to race condition (new from id, id ${user.id} domain ${user.domainName})`)
            } else {
                userMap.set(user.id!, userPromise);
                domainMap.set(user.domainName!, userPromise);
                console.log(`${user.id}: [User] Access user (new from id, id ${user.id} domain ${user.domainName})`)
            }
            return user;
        })
    
    // cache it no matter right or wrong, judge later
    userMap.set(name, userPromise)
    return userPromise
}

async function getUserWithDomain(saveDir: string, domain: string) {
    if (domainMap.has(domain)) {
        return domainMap.get(domain)!
    }

    const id = await fs.readFile(path.resolve(saveDir, 'domains', domain), 'utf8')
    return getUserWithName(saveDir, id)
}

async function createUser(saveDir: string) {
    let id = randId()
    let domain = getRandomDomain()
    let dataDir = path.resolve(saveDir, id);

    await fs.ensureDir(path.resolve(saveDir, 'domains'));
    await fs.ensureDir(dataDir);
    await fs.outputFile(path.resolve(saveDir, 'domains', domain), id);
    await promiseFromChildProcess(exec('ssh-keygen', ['-N', '', '-t', 'ecdsa', '-f', path.resolve(dataDir, 'public_key')]));
    await promiseFromChildProcess(exec('ssh-keygen', ['-N', '', '-t', 'ecdsa', '-f', path.resolve(dataDir, 'private_key')]));
    await fs.outputJson(path.resolve(dataDir, 'info.json'), {
        id: id,
        domain: domain,
        password: Math.random().toString(36).slice(2)
    });
    return getUserWithName(saveDir, id);
}

export {
    User,
    getUserWithName,
    getUserWithDomain,
    createUser
}
