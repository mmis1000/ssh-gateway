const fs = require('fs');
const crypto = require('crypto');
const inspect = require('util').inspect;
const net = require('net');
const path = require('path');

const buffersEqual = require('buffer-equal-constant-time');
const ssh2 = require('ssh2');
const utils = ssh2.utils;

const getUser = require("./user").getUser;

module.exports = function(config) {
    new ssh2.Server({
        hostKeys: [
            fs.readFileSync(path.resolve(__dirname, '../ssh_host_rsa_key')),
            fs.readFileSync(path.resolve(__dirname, '../ssh_host_ecdsa_key')),
            fs.readFileSync(path.resolve(__dirname, '../ssh_host_ed25519_key')),
        ]
    }, function(client) {
        console.log('A new ssh client connected!');
        
        client
        .on('error', function (err) {
            if (client.userData) {
                console.error(`${client.userData.id}: [SSH] ${inspect(err)}`);
            } else {
                console.error(`<unknown user>: ${inspect(err)}`);
            }
        })
        
        client.on('authentication', function(ctx) {
            if (ctx.method === 'publickey'/* &&
                ctx.key.algo === pubKey.fulltype &&
                buffersEqual(ctx.key.data, pubKey.public)*/
            ) {
                let username = ctx.username;
                getUser(username)
                .then(function (userData) {
                    if (!userData) {
                        return ctx.reject();
                    }

                    client.userData = userData;
                    let parsed = utils.parseKey(userData.privateKey_pub)

                    if (ctx.key.algo !== parsed.type) {
                        return ctx.reject(['publickey']);
                    }
                    
                    if (!buffersEqual(ctx.key.data, parsed.getPublicSSH())) {
                        return ctx.reject(['publickey']);
                    }
                    
                    if (ctx.signature) {
                        // let verifier = crypto.createVerify(ctx.sigAlgo);
                        // verifier.update(ctx.blob);

                        if (parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
                            ctx.accept();
                        }
                        else {
                            ctx.reject();
                        }
                    }
                    else {
                        // if no signature present, that means the client is just checking
                        // the validity of the given public key
                        ctx.accept();
                    }
                })
                .catch(function (err) {
                    console.error(inspect(err));
                    ctx.reject(['publickey']);
                })
            }
            else {
                ctx.reject(['publickey']);
            }
        }).on('ready', function() {
            console.log(`${client.userData.id}: [SSH] Client authenticated!`);
            
            
            // client.on('session', function(accept, reject) {
            //     let session = accept();
            //     session.once('exec', function(accept, reject, info) {
            //         console.log('Client wants to execute: ' + inspect(info.command));
            //         let stream = accept();
            //         stream.stderr.write('Oh no, the dreaded errors!\n');
            //         stream.write('Just kidding about the errors!\n');
            //         stream.exit(0);
            //         stream.end();
            //     });
            // });
            client.on('session', function(accept, reject) {
                let session = accept();
                session.once('exec', function(accept, reject, info) {
                    console.log(`${client.userData.id}: [SSH] Client wants to execute: ${inspect(info.command)}`);
                    let temp = info.command.split(' ');
                    let stream = accept();
                    
                    if ((temp.length !== 3 && temp.length !== 4) || temp[0] !== 'register' || !temp[2].match(/^[1-9]\d*$|^0$/)) {
                        stream.stderr.write('bad register command');
                        stream.exit(-1);
                    } else {
                        client.userData.remoteUser = temp[1];
                        client.userData.httpPort = parseInt(temp[2], 10);
                        
                        if (client.userData.httpPort === 0) {
                            // force normalize th path;
                            client.userData.staticDirectory = path.resolve('/', temp[3])
                        }
                        
                        client.userData.emit('tnuunel_client', client);
                        
                        stream.write(`accepted. server is open at http://${client.userData.domainName}.${config.httpHost}:${config.httpPort}/
socks v5 tunnel is opened at socks5://${client.userData.id}:${client.userData.password}@${config.socksHost}:${config.socksPort}
`);
                        stream.exit(0);
                    }
                    stream.end();
                });
            });


            client.on('request', function(accept, reject, name, info) {
                console.log(`${client.userData.id}: [SSH] Clinet requested ${name} ${inspect(info)}`);
                // reject();
                if (name !== 'tcpip-forward' && name !== 'cancel-tcpip-forward') reject();

                if (name === 'tcpip-forward') {

                    let accepted = false;

                    if (client.userData.tunnelClient) {
                        client.userData.tunnelClient.end();
                        delete client.userData.tunnelClient;
                    }

                    client.userData.tunnelClient = client;
                    client.userData.tunnelInfo = info;
                    client.userData.emit('tnuunel_client', client);
                    client.userData.createClient();
                }

                if (name === 'cancel-tcpip-forward') {
                    delete client.userData.tunnelClient;
                    delete client.userData.tunnelInfo;
                }
            });
        }).on('end', function() {
            delete client.userData.tunnelClient;
            client.userData.disconnectAll()
            
            if (client.userData) {
                console.log(`${client.userData.id}: [SSH] Client disconnected`);
            } else {
                console.log('Client disconnected');
            }
        });
    }).listen(config.sshListen, '0.0.0.0', function() {
        console.log('SSH server listening on port ' + this.address().port);
    });
}