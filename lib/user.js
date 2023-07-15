const inspect = require('util').inspect;
const Client = require('ssh2').Client;
const path = require("path");
const config = require('../config');
const fs = require("fs-extra");
const getRandomDomain = require("human-readable-ids").hri.random.bind(require("human-readable-ids").hri);
const exec = require('child_process').execFile;
const EventEmitter = require('events').EventEmitter;
const util = require("util");

const saveDir = path.resolve(__dirname, '../', config.saveDir);

function randId() {
    return Math.random().toString(36).substr(2, 10);
}

function promiseFromChildProcess(child) {
    return new Promise(function (resolve, reject) {
        child.addListener("error", reject);
        child.addListener("exit", resolve);
    });
}

function User(data) {
    EventEmitter.call(this);

    this.id = null;
    this.publicKey = null;
    this.publicKey_pub = null;
    this.privateKey = null;
    this.privateKey_pub = null;
    this.domainName = null;
    this.password = null;

    this.tunnelClient = null;
    this.tunnelInfo = null;

    this.sshState = User.SSH_CLIENT_STATE.DISCONNECT
    this.sshClient = null;
    this.remoteUser = null;

    /** 0 to disable forward */
    this.httpPort = null;
    /** Path for folder to serve as static http site */
    this.staticDirectory = null;

    this.sftpState = User.SFTP_CLIENT_STATE.DISCONNECT
    this.sftpClient = null;

    for (let key in data) {
        this[key] = data[key];
    }
}
util.inherits(User, EventEmitter);

User.SSH_CLIENT_STATE = {
    DISCONNECT: 1,
    WAIT: 2,
    CONNECT: 3
}

User.SFTP_CLIENT_STATE = {
    DISCONNECT: 1,
    WAIT: 2,
    CONNECT: 3
}

User.prototype.createClient = function createClient() {
    let info = this.tunnelInfo;

    if (!this.tunnelClient) {
        console.warn(`${this.id}: [User] Failed to create client because the tunnel is disconnected.`);
        this.once('tunnel_client', createClient.bind(this));
        return;
    }

    if (this.sshState === User.SSH_CLIENT_STATE.WAIT) {
        return;
    }

    if (this.sshState === User.SSH_CLIENT_STATE.CONNECT) {
        this.emit('ssh_client', this.ssh_client);
        return;
    }

    console.log(`${this.id}: [User] Starting to create client...`)

    this.sshState = User.SSH_CLIENT_STATE.WAIT;

    this.tunnelClient.forwardOut(info.bindAddr, info.bindPort, '127.0.0.1', '9999', function (err, channel) {

        if (err) {
            console.error(inspect(err));
            return;
        }

        /** monkey patch!!!! */
        channel.stderr.resume = function nuzz() { };

        let client = new Client();

        client.on('ready', function () {
            if (this.sshClient) {
                this.sshClient.end();
            }

            this.sshClient = client;
            console.log(`${this.id}: [User] Client ready !!!`);
            this.sshState = User.SSH_CLIENT_STATE.CONNECT
            this.emit('ssh_client', client);
        }.bind(this));

        client.connect({
            sock: channel,
            username: this.remoteUser,
            privateKey: this.publicKey,
        })

        client.on('error', function (err) {
            console.error(inspect(err));
        })

        client.on('close', function () {
            this.sshState = User.SSH_CLIENT_STATE.DISCONNECT

            this.createClient();
        }.bind(this))
    }.bind(this))
}

User.prototype.getClient = function getClient(timeout) {
    return new Promise(function (resolve, reject) {
        timeout = timeout || 20000; // 20 seconds default
        let id = null;

        function handle(client) {
            clearTimeout(id);
            resolve(client);
        }

        function onTimeout() {
            this.removeListener('ssh_client', handle);
            reject(new Error('client connection timeout'));
        }

        if (this.sshState !== User.SSH_CLIENT_STATE.CONNECT) {
            this.createClient();
            this.once('ssh_client', handle);
        } else {
            resolve(this.sshClient);
        }

        setTimeout(onTimeout.bind(this), timeout)
    }.bind(this));
}

User.prototype.createSftp = function createSftp() {
    if (!this.sshClient) {
        console.log(`${this.id}: [User] Wish to create sftp client, but the ssh connection is not yet ready`);
        this.getClient()
            .then(function () {
                console.log(`${this.id}: [User] SSH connection is ready, resume creating sftp client`);
                createSftp.call(this)
            }.bind(this))
            .catch(function (err) {
                console.error(`${this.id}: [User] User wants to create SSH SFTP client, but it is not going to create due to ${inspect(err)}`);
            }.bind(this));
        return
    }

    if (this.sftpState === User.SFTP_CLIENT_STATE.WAIT) {
        return;
    }

    if (this.sftpState === User.SFTP_CLIENT_STATE.CONNECT) {
        this.emit('sftp_client', this.sftpClient);
        return;
    }

    this.sftpState = User.SFTP_CLIENT_STATE.WAIT;

    this.sshClient.sftp(function (err, sftpStream) {
        if (err) {
            console.error(inspect(err));
            this.sftpState = User.SFTP_CLIENT_STATE.DISCONNECT;
            return;
        }

        this.sftpClient = sftpStream;
        this.sftpState = User.SFTP_CLIENT_STATE.CONNECT;
        this.emit('sftp_client', sftpStream);

        console.log(`${this.id}: [User] SFTP ready`)

        let cleanup = function () {
            sftpStream.removeListener('end', cleanup)
            sftpStream.removeListener('close', cleanup)
            sftpStream.removeListener('error', cleanup)
            this.sftpState = User.SFTP_CLIENT_STATE.DISCONNECT
            this.sftpClient = null;
        }.bind(this)

        sftpStream.once('end', cleanup)
        sftpStream.once('close', cleanup)
        sftpStream.once('error', cleanup)
    }.bind(this))
}

User.prototype.getSftp = function getClient(timeout) {
    return new Promise(function (resolve, reject) {
        timeout = timeout || 25000; // 25 seconds default (because it needs to wait for client)
        let id = null;

        function handle(client) {
            clearTimeout(id);
            resolve(client);
        }

        function onTimeout() {
            this.removeListener('sftp_client', handle);
            reject(new Error('client connection timeout'));
        }

        if (this.sftpState !== User.SFTP_CLIENT_STATE.CONNECT) {
            this.once('sftp_client', handle);
            this.createSftp();
        } else {
            resolve(this.sftpClient);
        }

        setTimeout(onTimeout.bind(this), timeout)
    }.bind(this));
}

User.prototype.disconnectAll = function disconnectAll() {
    if (this.sftpState === User.SFTP_CLIENT_STATE.CONNECT) {
        this.sftpState = User.SFTP_CLIENT_STATE.DISCONNECT
        this.sftpClient && this.sftpClient.end()
    }

    if (this.sshState === User.SSH_CLIENT_STATE.CONNECT) {
        this.sshState = User.SSH_CLIENT_STATE.DISCONNECT
        this.ssh_client && this.ssh_client.end()
    }
}

const userMap = new Map();
const domainMap = new Map();

function getUserWithName(name) {
    if (userMap.has(name)) {
        console.log(`${name}: [User] Try access user from in process cache (id ${name})`)
        return userMap.get(name)
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

            let user = new User(info);
            if (userMap.has(user.id) && domainMap.has(user.domainName)) {
                console.log(`${user.id}: [User] Skip writing user to cache due to race condition (new from id, id ${user.id} domain ${user.domainName})`)
            } else {
                userMap.set(user.id, userPromise);
                domainMap.set(user.domainName, userPromise);
                console.log(`${user.id}: [User] Access user (new from id, id ${user.id} domain ${user.domainName})`)
            }
            return user;
        })
    
    // cache it no matter right or wrong, judge later
    userMap.set(name, userPromise)
    return userPromise
}

async function getUserWithDomain(domain) {
    if (domainMap.has(domain)) {
        return domainMap.get(domain)
    }

    const id = await fs.readFile(path.resolve(saveDir, 'domains', domain), 'utf8')
    return getUserWithName(id)
}

function createUser(cb) {
    let id = randId()
    let domain = getRandomDomain()
    let dataDir = path.resolve(saveDir, id);

    return fs.ensureDir(path.resolve(saveDir, 'domains'))
        .then(function () {
            return fs.ensureDir(dataDir);
        })
        .then(function () {
            return fs.outputFile(path.resolve(saveDir, 'domains', domain), id);
        })
        .then(function () {
            return promiseFromChildProcess(exec('ssh-keygen', ['-N', '', '-t', 'ecdsa', '-f', path.resolve(dataDir, 'public_key')]));
        })
        .then(function () {
            return promiseFromChildProcess(exec('ssh-keygen', ['-N', '', '-t', 'ecdsa', '-f', path.resolve(dataDir, 'private_key')]));
        })
        .then(function () {
            return fs.outputJson(path.resolve(dataDir, 'info.json'), {
                id: id,
                domain: domain,
                password: Math.random().toString(36).slice(2)
            })
        })
        .then(function () {
            return getUserWithName(id);
        })
}

module.exports = {
    User,
    getUserWithName,
    getUserWithDomain,
    createUser
}