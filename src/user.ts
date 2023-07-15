const inspect = require('util').inspect;
import { Client, SFTPWrapper } from 'ssh2';
import path from "path";
// import config from '../config.json';
import fs from "fs-extra";
const getRandomDomain = require("human-readable-ids").hri.random.bind(require("human-readable-ids").hri);
import { ChildProcess, execFile as exec } from 'child_process'
import { EventEmitter } from 'events'
import { Connection, TcpipBindInfo } from "ssh2";

// const saveDir = path.resolve(__dirname, '../', config.saveDir);

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

class User extends EventEmitter {
    id: string | null
    publicKey: string | null
    publicKey_pub: string | null
    privateKey: string | null
    privateKey_pub: string | null
    domainName: string | null
    password: string | null
    sshState: number
    remoteUser: string | null
    httpPort: number | null
    sftpState: number
    staticDirectory: string | null
    tunnelClient: Connection | null
    tunnelInfo: TcpipBindInfo | null
    sshClient: Client | null
    sftpClient: SFTPWrapper | null

    saveDir: string
    constructor(saveDir: string, data: UserData) {
        super()

        this.saveDir = saveDir

        this.id = null;
        this.publicKey = null;
        this.publicKey_pub = null;
        this.privateKey = null;
        this.privateKey_pub = null;
        this.domainName = null;
        this.password = null;

        this.tunnelClient = null;
        this.tunnelInfo = null;

        this.sshState = User.SSH_CLIENT_STATE.DISCONNECT;
        this.sshClient = null;
        this.remoteUser = null;

        /** 0 to disable forward */
        this.httpPort = null;
        /** Path for folder to serve as static http site */
        this.staticDirectory = null;

        this.sftpState = User.SFTP_CLIENT_STATE.DISCONNECT;
        this.sftpClient = null;

        for (let key in data) {
            (this as any)[key] = (data as any)[key];
        }
    }
    createClient() {
        if (!this.tunnelClient || !this.tunnelInfo) {
            console.warn(`${this.id}: [User] Failed to create client because the tunnel is disconnected.`);
            this.once('tunnel_client', this.createClient.bind(this));
            return;
        }

        let info = this.tunnelInfo;

        if (this.sshState === User.SSH_CLIENT_STATE.WAIT) {
            return;
        }

        if (this.sshState === User.SSH_CLIENT_STATE.CONNECT) {
            this.emit('ssh_client', this.sshClient);
            return;
        }

        console.log(`${this.id}: [User] Starting to create client...`);

        this.sshState = User.SSH_CLIENT_STATE.WAIT;

        this.tunnelClient.forwardOut(info.bindAddr, info.bindPort, '127.0.0.1', 9999, (err, channel) => {

            if (err) {
                console.error(inspect(err));
                return;
            }

            // FIXME: monkey patch!!!!
            (channel.stderr as any).resume = function nuzz() { };

            let client = new Client();

            client.on('ready', () => {
                if (this.sshClient) {
                    this.sshClient.end();
                }

                this.sshClient = client;
                console.log(`${this.id}: [User] Client ready !!!`);
                this.sshState = User.SSH_CLIENT_STATE.CONNECT;
                this.emit('ssh_client', client);
            });

            client.connect({
                sock: channel,
                username: this.remoteUser!,
                privateKey: this.publicKey!,
            });

            client.on('error', function (err) {
                console.error(inspect(err));
            });

            client.on('close', () => {
                this.sshState = User.SSH_CLIENT_STATE.DISCONNECT;

                this.createClient();
            });
        });
    }
    getClient(timeout = 20000 /* 20 seconds default*/) {
        return new Promise<Client>((resolve, reject) => {
            let id: ReturnType<typeof setTimeout> | null = null;

            const handle = (client: Client | PromiseLike<Client>) => {
                if (id != null) {
                    clearTimeout(id);
                }
                resolve(client);
            }

            const onTimeout = () => {
                this.removeListener('ssh_client', handle);
                reject(new Error('client connection timeout'));
            }

            if (this.sshState !== User.SSH_CLIENT_STATE.CONNECT) {
                this.createClient();
                this.once('ssh_client', handle);
            } else {
                resolve(this.sshClient!);
            }

            setTimeout(onTimeout.bind(this), timeout);
        });
    }
    createSftp() {
        if (!this.sshClient) {
            console.log(`${this.id}: [User] Wish to create sftp client, but the ssh connection is not yet ready`);
            this.getClient()
                .then(() => {
                    console.log(`${this.id}: [User] SSH connection is ready, resume creating sftp client`);
                    this.createSftp.call(this);
                })
                .catch((err) => {
                    console.error(`${this.id}: [User] User wants to create SSH SFTP client, but it is not going to create due to ${inspect(err)}`);
                });
            return;
        }

        if (this.sftpState === User.SFTP_CLIENT_STATE.WAIT) {
            return;
        }

        if (this.sftpState === User.SFTP_CLIENT_STATE.CONNECT) {
            this.emit('sftp_client', this.sftpClient);
            return;
        }

        this.sftpState = User.SFTP_CLIENT_STATE.WAIT;

        this.sshClient.sftp((err?: Error, sftpStream?: SFTPWrapper) => {
            if (err || sftpStream == null) {
                console.error(inspect(err));
                this.sftpState = User.SFTP_CLIENT_STATE.DISCONNECT;
                return;
            }

            this.sftpClient = sftpStream;
            this.sftpState = User.SFTP_CLIENT_STATE.CONNECT;
            this.emit('sftp_client', sftpStream);

            console.log(`${this.id}: [User] SFTP ready`);

            let cleanup = () => {
                sftpStream.removeListener('end', cleanup);
                sftpStream.removeListener('close', cleanup);
                sftpStream.removeListener('error', cleanup);
                this.sftpState = User.SFTP_CLIENT_STATE.DISCONNECT;
                this.sftpClient = null;
            }

            sftpStream.once('end', cleanup);
            sftpStream.once('close', cleanup);
            sftpStream.once('error', cleanup);
        });
    }
    getSftp(timeout = 25000 /* 25 seconds default (because it needs to wait for client) */) {
        return new Promise<SFTPWrapper>((resolve, reject) => {
            let id: ReturnType<typeof setTimeout> | null = null;

            const  handle = (client: SFTPWrapper) => {
                if (id != null) {
                    clearTimeout(id);
                }
                resolve(client);
            }

            const onTimeout = () => {
                this.removeListener('sftp_client', handle);
                reject(new Error('client connection timeout'));
            }

            if (this.sftpState !== User.SFTP_CLIENT_STATE.CONNECT) {
                this.once('sftp_client', handle);
                this.createSftp();
            } else {
                resolve(this.sftpClient!);
            }

            setTimeout(onTimeout.bind(this), timeout);
        });
    }
    disconnectAll() {
        if (this.sftpState === User.SFTP_CLIENT_STATE.CONNECT) {
            this.sftpState = User.SFTP_CLIENT_STATE.DISCONNECT;
            this.sftpClient && this.sftpClient.end();
        }

        if (this.sshState === User.SSH_CLIENT_STATE.CONNECT) {
            this.sshState = User.SSH_CLIENT_STATE.DISCONNECT;
            this.sshClient && this.sshClient.end();
        }
    }

    static SSH_CLIENT_STATE = {
        DISCONNECT: 1,
        WAIT: 2,
        CONNECT: 3
    }

    static SFTP_CLIENT_STATE = {
        DISCONNECT: 1,
        WAIT: 2,
        CONNECT: 3
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
