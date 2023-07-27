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
                            // force normalize the path;
                            client.userData!.staticDirectory = path.resolve('/', temp[3])
                        }

                        stream.write(`Client accepted.
Forward server is opened at ${config.httpProtocol}://${client.userData!.domainName}.${config.httpHost}:${config.httpPort}/
Socks v5 tunnel is opened at socks5://${client.userData!.id}:${client.userData!.password}@${config.socksHost}:${config.socksPort}
To get new version of current script, fetch it from ${config.setupProtocol}://${client.userData!.id}:${client.userData!.password}@${config.setupHost}:${config.setupPort}/update
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
                    console.log(`${client.userData!.id}: [SSH] Tunnel started!`);
                    if (client.userData!.tunnelQueue.isRequesting()) {
                        console.log(`${client.userData!.id}: [SSH] Is requesting tunnel`);
                        client.userData!.tunnelQueue.externalResolve([client, info])
                    } else {
                        console.log(`${client.userData!.id}: [SSH] Is not requesting tunnel`);
                        client.userData!.tunnelQueue.request().then((c) => {
                            console.log('closed')
                            c[0].end()
                        }, () => {})
                        client.userData!.tunnelQueue.reset()
                        client.userData!.tunnelQueue.externalResolve([client, info])
                    }
                }

                if (name === 'cancel-tcpip-forward') {
                    client.userData!.tunnelQueue.reset()
                }
            });
        }).on('end', function() {
            if (client.userData) {
                client.userData.tunnelQueue.reset()
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