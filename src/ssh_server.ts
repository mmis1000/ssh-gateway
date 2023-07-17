import { Config } from "./interface";

import fs from 'fs';
const inspect = require('util').inspect;
import path from 'path';
import { parse } from 'shell-quote';

import buffersEqual from 'buffer-equal-constant-time';
import ssh2, { Connection } from 'ssh2';
import { User, getUserWithName } from "./user"
import { AddressInfo } from "net";
const utils = ssh2.utils;


export default function(config: Config) {
    const server = new ssh2.Server({
        hostKeys: [
            fs.readFileSync(path.resolve(__dirname, '../ssh_host_rsa_key')),
            fs.readFileSync(path.resolve(__dirname, '../ssh_host_ecdsa_key')),
            fs.readFileSync(path.resolve(__dirname, '../ssh_host_ed25519_key')),
        ]
    }, function(client: Connection & { userData?: User }) {
        console.log('A new ssh client connected!');
        
        client
        .on('error', function (err) {
            if (client.userData) {
                console.error(`${client.userData.id}: [SSH] ${inspect(err)}`);
                client.userData.resetConnection()
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
                getUserWithName(config.saveDir, username)
                .then(function (userData) {
                    if (!userData) {
                        return ctx.reject();
                    }

                    client.userData = userData;
                    let parsed = utils.parseKey(userData.privateKey_pub!)

                    if (parsed instanceof Error) {
                        return ctx.reject(['publickey']);
                    }

                    if (ctx.key.algo !== parsed.type) {
                        return ctx.reject(['publickey']);
                    }
                    
                    if (!buffersEqual(ctx.key.data, parsed.getPublicSSH())) {
                        return ctx.reject(['publickey']);
                    }
                    
                    if (ctx.blob && ctx.signature && (ctx as any).hashAlgo) {
                        // let verifier = crypto.createVerify(ctx.sigAlgo);
                        // verifier.update(ctx.blob);

                        if (parsed.verify(ctx.blob, ctx.signature, (ctx as any).hashAlgo)) {
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
            console.log(`${client.userData!.id}: [SSH] Client authenticated!`);

            client.on('session', function(accept, reject) {
                let session = accept();
                session.once('exec', function(accept, reject, info) {
                    console.log(`${client.userData!.id}: [SSH] Client wants to execute: ${inspect(info.command)}`);
                    let temp = parse(info.command).map(i => String(i));
                    let stream = accept();
                    
                    if ((temp.length !== 3 && temp.length !== 4) || temp[0] !== 'register' || !temp[2].match(/^[1-9]\d*$|^0$/)) {
                        console.log(`${client.userData!.id}: [SSH] bad register command: ${inspect(info.command)}`);
                        stream.stderr.write('bad register command');
                        stream.exit(-1);
                    } else {
                        client.userData!.remoteUser = temp[1];
                        client.userData!.httpPort = parseInt(temp[2], 10);
                        
                        if (client.userData!.httpPort === 0) {
                            // force normalize th path;
                            client.userData!.staticDirectory = path.resolve('/', temp[3])
                        }
                        
                        client.userData!.emit('tunnel_client', client);
                        
                        stream.write(`accepted. server is open at ${config.httpProtocol}://${client.userData!.domainName}.${config.httpHost}:${config.httpPort}/
socks v5 tunnel is opened at socks5://${client.userData!.id}:${client.userData!.password}@${config.socksHost}:${config.socksPort}
to get new version of script, get it from ${config.httpProtocol}://${client.userData!.id}:${client.userData!.password}@${config.httpHost}:${config.httpPort}/update
`);
                        stream.exit(0);
                    }
                    stream.end();
                });
            });


            client.on('request', function(accept, reject, name, info) {
                console.log(`${client.userData!.id}: [SSH] Client requested ${name} ${inspect(info)}`);
                // reject();
                if (name !== 'tcpip-forward' && name !== 'cancel-tcpip-forward') reject!();

                if (name === 'tcpip-forward') {
                    if (client.userData!.tunnelClient) {
                        client.userData!.tunnelClient.end();
                        client.userData!.tunnelClient = null;
                    }

                    client.userData!.tunnelClient = client;
                    client.userData!.tunnelInfo = info;
                    client.userData!.emit('tunnel_client', client);
                    client.userData!.createClient();
                }

                if (name === 'cancel-tcpip-forward') {
                    client.userData!.tunnelClient = null;
                    client.userData!.tunnelInfo = null;
                }
            });
        }).on('end', function() {
            if (client.userData) {
                client.userData.tunnelClient = null;
                client.userData.disconnectAll()

                console.log(`${client.userData.id}: [SSH] Client disconnected`);
            } else {
                console.log('Client disconnected');
            }
        });
    }).listen(config.sshListen, '0.0.0.0', function() {
        console.log('SSH server listening on port ' + (server.address() as AddressInfo).port);
    });
}