var fs = require('fs');
var crypto = require('crypto');
var inspect = require('util').inspect;
var net = require('net');
var path = require('path');

var buffersEqual = require('buffer-equal-constant-time');
var ssh2 = require('ssh2');
var utils = ssh2.utils;

const createUser = require("./user").createUser;
const getUser = require("./user").getUser;

module.exports = function(config) {
    new ssh2.Server({
        hostKeys: [fs.readFileSync(path.resolve(__dirname, '../ssh_host_rsa_key'))]
    }, function(client) {
        console.log('A new ssh client connected!');
        
        client
        .on('error', function (err) {
            if (client.userData) {
                console.error(client.userData.id + ': ' + inspect(err))
            } else {
                console.error('<unknown user>: ' + inspect(err))
            }
        })
        
        client.on('authentication', function(ctx) {
            if (ctx.method === 'publickey'/* &&
                ctx.key.algo === pubKey.fulltype &&
                buffersEqual(ctx.key.data, pubKey.public)*/
            ) {
                var username = ctx.username;
                getUser(username)
                .then(function (userData) {
                    if (!userData) {
                        return ctx.reject();
                    }

                    client.userData = userData;

                    var pubKey = utils.genPublicKey(utils.parseKey(userData.privateKey_pub));

                    if (ctx.key.algo !== pubKey.fulltype) {
                        return ctx.reject(['publickey']);
                    }
                    
                    if (!buffersEqual(ctx.key.data, pubKey.public)) {
                        return ctx.reject(['publickey']);
                    }
                    
                    if (ctx.signature) {
                        var verifier = crypto.createVerify(ctx.sigAlgo);
                        verifier.update(ctx.blob);

                        if (verifier.verify(pubKey.publicOrig, ctx.signature)) {
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
            console.log(client.userData.id + ': Client authenticated!');
            
            
            // client.on('session', function(accept, reject) {
            //     var session = accept();
            //     session.once('exec', function(accept, reject, info) {
            //         console.log('Client wants to execute: ' + inspect(info.command));
            //         var stream = accept();
            //         stream.stderr.write('Oh no, the dreaded errors!\n');
            //         stream.write('Just kidding about the errors!\n');
            //         stream.exit(0);
            //         stream.end();
            //     });
            // });
            client.on('session', function(accept, reject) {
                var session = accept();
                session.once('exec', function(accept, reject, info) {
                    console.log(client.userData.id + ': Client wants to execute: ' + inspect(info.command));
                    var temp = info.command.split(' ');
                    var stream = accept();
                    
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
                        
                        stream.write(`accepted. server is open at http://${client.userData.domain}.${config.httpHost}:${config.httpPort}/\n`)
                        stream.exit(0);
                    }
                    stream.end();
                });
            });


            client.on('request', function(accept, reject, name, info) {
                console.log(client.userData.id + ': Clinet requested ' + name  + ' ' + inspect(info));
                // reject();
                if (name !== 'tcpip-forward' && name !== 'cancel-tcpip-forward') reject();

                if (name === 'tcpip-forward') {

                    var accepted = false;

                    if (client.userData.tunnelClient) {
                        client.userData.tunnelClient.end();
                        delete client.userData.tunnelClient;
                    }

                    client.userData.tunnelClient = client;
                    client.userData.tunnelInfo = info;
                    client.userData.creareClient();
                    // var server = net.createServer(function(connection) {
                    //     console.log('accepted connection from ' + connection.remoteAddress + ':' + connection.remotePort)

                    //     client.forwardOut(info.bindAddr, info.bindPort, connection.remoteAddress, connection.remotePort, function(err, channel) {
                    //         if (err) {
                    //             console.error(inspect(err));
                    //             try {
                    //                 connection.destroy();
                    //             }
                    //             catch (err) {
                    //                 if (err) console.error(inspect(err));
                    //             }
                    //             return;
                    //         }

                    //         function handler(err) {
                    //             console.log(err)
                    //         }

                    //         channel
                    //             .on('error', handler)
                    //             .pipe(connection)
                    //             .on('error', handler)
                    //             .pipe(channel);
                    //     })
                    // })

                    // server.on('error', (err) => {
                    //     console.log(err);
                    //     if (!accepted) reject();
                    // });

                    // server.listen(info.bindPort, info.bindAddr, () => {
                    //     accept();
                    //     accepted = true;
                    //     bounded[info.bindAddr + ':' + info.bindPort] = server;
                    //     console.log(info.bindAddr + ':' + info.bindPort + ' bounded')
                    // });

                }

                if (name === 'cancel-tcpip-forward') {
                    delete client.userData.tunnelClient;
                    delete client.userData.tunnelInfo;
                    // if (bounded[info.bindAddr + ':' + info.bindPort]) {
                    //     server = bounded[info.bindAddr + ':' + info.bindPort];
                    //     server.close(function(err) {
                    //         if (err) return reject();
                    //         accept()
                    //     })
                    //     delete bounded[info.bindAddr + ':' + info.bindPort];
                    //     console.log(info.bindAddr + ':' + info.bindPort + ' unbounded')
                    // }
                }
            });
        }).on('end', function() {
            delete client.userData.tunnelClient;
            if (client.userData) {
                console.log(client.userData.id + ': Client disconnected');
            } else {
                console.log('Client disconnected');
            }

            // for (var key in bounded) {
            //     console.log(key)
            //     bounded[key].close(function(key, err) {
            //         if (err) return console.error(inspect(err));
            //         console.log(key + ' unbounded')
            //     }.bind(null, key))
            // }
            // bounded = {};
        });
    }).listen(config.sshListen, '0.0.0.0', function() {
        console.log('Listening on port ' + this.address().port);
    });
}