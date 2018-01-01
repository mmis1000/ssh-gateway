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
    this.httpPort = 8080;
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

User.prototype.creareClient = function creareClient() {
    var info = this.tunnelInfo;
    
    if (!this.tunnelClient) {
        console.warn('[warn] Failed to create client because the tunnel is disconnected.');
        this.once('tnuunel_client', creareClient.bind(this));
        return;
    }
    
    if (this.sshState === User.SSH_CLIENT_STATE.WAIT) {
        return;
    }
    
    if (this.sshState === User.SSH_CLIENT_STATE.CONNECT) {
        this.emit('ssh_client', this.ssh_client);
        return;
    }
    
    this.sshState = User.SSH_CLIENT_STATE.WAIT;
    
    this.tunnelClient.forwardOut(info.bindAddr, info.bindPort, '127.0.0.1', '9999', function(err, channel) {
        
        if (err) {
            console.error(inspect(err));
            return;
        }
        
        /** monkey patch!!!! */
        channel.stderr.resume = function nuzz(){};
        
        var client = new Client();
        
        client.on('ready', function() {
            if (this.sshClient) {
                this.sshClient.end();
            }
            
            this.sshClient = client;
            console.log(this.id + ': Client ready !!!');
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
            this.creareClient();
        }.bind(this))
    }.bind(this))
}

User.prototype.createSftp = function createSftp() {
    if (!this.sshClient) {
        this.once('ssh_client', createSftp.bind(this));
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
        
        var cleanup = function() {
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

var userMap = new Map();
var domainMap = new Map();

function getUser(name) {
    return new Promise(function (resolve ,reject) {
        if (userMap.has(name) || domainMap.has(name)) {
            // console.log('got client from cache!!!')
            var user = userMap.get(name) || domainMap.get(name);
            return resolve(user);
        }
        
        var dataDir = path.resolve(config.saveDir, name);
        
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
            
            var user = new User(info);
            userMap.set(user.id, user);
            domainMap.set(user.domainName, user);
            resolve(user);
        })
        .catch(function (err) {
            // console.error(err);
            fs.readFile(path.resolve(saveDir, 'domians', name), 'utf8')
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
                info.publicKey = publicKey;
                info.publicKey_pub = publicKey_pub;
                info.privateKey = privateKey;
                info.privateKey_pub = privateKey_pub;
                
                var user = new User(info);
                userMap.set(user.id, user);
                domainMap.set(user.domainName, user);
                resolve(user);
            })
            .catch(function (err) {
                reject(err);
            })
        })
        
    })
}

function createUser(cb) {
    var id = randId()
    var domain = getRandomDomain()
    var dataDir = path.resolve(saveDir, id);
    
    return fs.ensureDir(path.resolve(saveDir, 'domians'))
    .then(function () {
        return fs.ensureDir(dataDir);
    })
    .then(function () {
        return fs.outputFile(path.resolve(saveDir, 'domians', domain), id);
    })
    .then(function () {
        return promiseFromChildProcess(exec('ssh-keygen', ['-N', '', '-t', 'rsa', '-f', path.resolve(dataDir, 'public_key')]));
    })
    .then(function () {
        return promiseFromChildProcess(exec('ssh-keygen', ['-N', '', '-t', 'rsa', '-f', path.resolve(dataDir, 'private_key')]));
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