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
        this.once('tnuunel_client', createClient.bind(this));
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
    
    this.tunnelClient.forwardOut(info.bindAddr, info.bindPort, '127.0.0.1', '9999', function(err, channel) {
        
        if (err) {
            console.error(inspect(err));
            return;
        }
        
        /** monkey patch!!!! */
        channel.stderr.resume = function nuzz(){};
        
        let client = new Client();
        
        client.on('ready', function() {
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
            reject(new Error('client conenction timeout'));
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
        console.log(`${this.id}: [User] Wish to create sftp client, but the ssh conenction is not yet ready`);
        this.getClient()
        .then(function () {
            console.log(`${this.id}: [User] SSH conenction is ready, resume creating sftp client`);
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
        
        let cleanup = function() {
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
            reject(new Error('client conenction timeout'));
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

function getUser(name) {
    if (userMap.has(name) || domainMap.has(name)) {
        return (userMap.get(name) || domainMap.get(name)).then(function (user) {
            console.log(`${user.id}: [User] Access user (cache from ${name === user.id ? 'id' : 'domain'})`);
            return user
        })
    }
    
    let p =  new Promise(function (resolve ,reject) {
        let dataDir = path.resolve(config.saveDir, name);
        
        fs.readJson(path.resolve(saveDir, name, 'info.json'))
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
            
            
            if (userMap.has(name) || domainMap.has(name)) {
                console.warn(`${user.id}: [User] Abort loaded user due to race condtion!!!`)
                console.log(`${user.id}: [User] Access user (cache from id)`)
                return resolve(userMap.get(name) || domainMap.get(name));
            }
            
            let user = new User(info);
            userMap.set(user.id, p);
            domainMap.set(user.domainName, p);
            console.log(`${user.id}: [User] Access user (new from id, id ${user.id} domain ${user.domainName})`)
            resolve(user);
        })
        .catch(function (err) {
            // console.error(err);
            fs.readFile(path.resolve(saveDir, 'domains', name), 'utf8')
            .then(function (/** @type {string} */ id) {
                /** @type {Buffer} */
                return fs.readJson(path.resolve(saveDir, id, 'info.json'));
            })
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
                
            
                if (userMap.has(name) || domainMap.has(name)) {
                    console.warn(`${user.id}: [User] Abort loaded user due to race condtion!!!`)
                    console.log(`${user.id}: [User] Access user (cache from domain)`)
                    return resolve(userMap.get(name) || domainMap.get(name));
                }
                
                let user = new User(info);
                userMap.set(user.id, p);
                domainMap.set(user.domainName, p);
                console.log(`${user.id}: [User] Access user (new from domain, id ${user.id} domain ${user.domainName})`)
                resolve(user);
            })
            .catch(function (err) {
                reject(err);
            })
        })
        
    })
    
    return p;
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
        return getUser(id);
    })
}

module.exports = {
    User,
    getUser,
    createUser
}