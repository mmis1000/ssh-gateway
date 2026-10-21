import { Config } from "./interface";

const inspect = require('util').inspect;
import path from 'path';
import { parse } from 'shell-quote';

import buffersEqual from 'buffer-equal-constant-time';
import ssh2, { Connection } from 'ssh2';
import { Protocol, User } from "./user"
import { UserStore } from "./store"
import { formatOrigin } from "./utils"
import { AddressInfo } from "net";
const utils = ssh2.utils;

const HANDSHAKE_TIMEOUT = 60 * 1000
/** time for the disconnect message to go out before the socket is destroyed */
const DESTROY_DELAY = 1000

export interface SshServerOptions {
    /** ms between keepalive pings, ssh2 defaults to 15000 */
    keepaliveInterval?: number
    /** unanswered pings before the connection is dropped, ssh2 defaults to 3 */
    keepaliveCountMax?: number
}

/**
 * end() only half closes, a peer that vanished (laptop asleep, network gone) never
 * answers, so the socket stayed open until tcp gave up. Destroy it shortly after.
 */
function killConnection(client: Connection) {
    try {
        client.end()
    } catch (err) {}
    const socket: { destroy(): void } | undefined = (client as any)._sock
    if (socket) {
        setTimeout(() => socket.destroy(), DESTROY_DELAY).unref()
    }
}

/**
 * Version of template/script.template, sent as "v<n>:" before the register command.
 * Older scripts keep working but are asked to update.
 * 1: protocol v1, the gateway connects through the reverse forward directly
 * 2: hardened client sshd (sftp read only, local ports only), pinned host keys,
 *    no agent or X11 forwarding, only the issued key is offered
 * 3: cleans up on ctrl+\ and on hangup, never kills its parent, a watchdog cleans up
 *    after kill -9, and the next start removes what a killed run left
 * 4: quiet while the tunnel is fine, reports only when the connection is lost and back
 * 5: --port/--dir/--yes/--help options, files in ~/.ssh-gateway/<host>/<id>, works without
 *    netstat and with spaces in paths, refuses to run twice
 */
export const CLIENT_SCRIPT_VERSION = 5
const VERSION_HEADER = /^v(\d+):$/

export function createSshServer(config: Config, store: UserStore, hostKeys: Buffer[], options: SshServerOptions = {}) {
    return new ssh2.Server({
        hostKeys,
        keepaliveInterval: options.keepaliveInterval,
        keepaliveCountMax: options.keepaliveCountMax,
    } as ssh2.ServerConfig, function(client: Connection & { userData?: User }) {
        console.log('A new ssh client connected!');

        const timeoutKiller = setTimeout(() => {
            console.error(`${client.userData?.id ?? '<unknown user>'}: [SSH] not finished handshake in time, considering bad`)
            killConnection(client)
        }, HANDSHAKE_TIMEOUT)

        /**
         * Called on end, close and error. A user often has an older connection that
         * closes after the client set up a new one, only the connection that holds the
         * tunnel may tear it down.
         */
        const release = (reason: string) => {
            const userData = client.userData
            client.userData = undefined
            if (!userData) return

            console.log(`${userData.id}: [SSH] connection ${reason}`)
            if (userData.tunnelConnection === client) {
                userData.tunnelConnection = null
                userData.disconnectAll()
            }
        }

        client
        .on('error', function (err: Error & { level?: string }) {
            console.error(`${client.userData?.id ?? '<unknown user>'}: [SSH] ${inspect(err)}`);
            release('failed')
            // includes keepalive timeouts, where ssh2 only calls end()
            killConnection(client)
        })

        client.on('close', function () {
            clearTimeout(timeoutKiller)
            release('closed')
        })
        
        client.on('authentication', function(ctx) {
            if (ctx.method === 'publickey'/* &&
                ctx.key.algo === pubKey.fulltype &&
                buffersEqual(ctx.key.data, pubKey.public)*/
            ) {
                let username = ctx.username;
                store.findById(username)
                .then(function (userData) {
                    if (!userData) {
                        return ctx.reject();
                    }

                    let parsed = utils.parseKey(userData.clientKeyPub!)

                    if (parsed instanceof Error) {
                        return ctx.reject(['publickey']);
                    }

                    if (ctx.key.algo !== parsed.type) {
                        return ctx.reject(['publickey']);
                    }
                    
                    if (!buffersEqual(ctx.key.data, parsed.getPublicSSH())) {
                        return ctx.reject(['publickey']);
                    }
                    
                    if (ctx.signature) {
                        // hashAlgo is only set for rsa-sha2-*, other key types pick their own hash
                        if (ctx.blob && parsed.verify(ctx.blob, ctx.signature, (ctx as any).hashAlgo) === true) {
                            // only an authenticated connection is tied to the user
                            client.userData = userData;
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
                    
                    const header = VERSION_HEADER.exec(temp[0] ?? '')
                    const scriptVersion = header ? Number(header[1]) : 0
                    if (header) temp.shift()
                    client.userData!.protocolVersion = scriptVersion >= 1 ? Protocol.V1 : Protocol.V0

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

                        const userData = client.userData!
                        const updateNotice = scriptVersion < CLIENT_SCRIPT_VERSION
                            ? `Please update this script, a newer version with fixes is available:
  curl -u '${userData.id}:${userData.password}' ${formatOrigin(config.setupProtocol, config.setupHost, config.setupPort)}/update > run.sh
`
                            : ''
                        stream.write(`${updateNotice}Client accepted.
Forward server is opened at ${config.httpProtocol}://${client.userData!.domainName}.${config.httpHost}:${config.httpPort}/
Socks v5 tunnel is opened at socks5://${client.userData!.id}:${client.userData!.password}@${config.socksHost}:${config.socksPort}
To get new version of current script, fetch it from ${config.setupProtocol}://${client.userData!.id}:${client.userData!.password}@${config.setupHost}:${config.setupPort}/update
Inspect requests at ${config.setupProtocol}://${config.setupHost}:${config.setupPort}/app/#${client.userData!.id}:${client.userData!.password}
`);
                        stream.exit(0);
                    }
                    stream.end();
                });
            });


            client.on('request', function(accept, reject, name, info) {
                console.log(`${client.userData!.id}: [SSH] Client requested ${name} ${inspect(info)}`);
                // reject();
                if (name !== 'tcpip-forward' && name !== 'cancel-tcpip-forward') reject?.();
                else accept?.();

                clearTimeout(timeoutKiller)

                if (name === 'tcpip-forward') {
                    console.log(`${client.userData!.id}: [SSH] Tunnel started!`);
                    const userData = client.userData!
                    const previous = userData.tunnelConnection
                    userData.tunnelConnection = client
                    if (userData.tunnelQueue.isRequesting()) {
                        console.log(`${userData.id}: [SSH] Is requesting tunnel`);
                        userData.tunnelQueue.externalResolve([client, info, userData.protocolVersion], () => {
                            killConnection(client)
                        })
                    } else {
                        console.log(`${userData.id}: [SSH] Is not requesting tunnel`);
                        userData.tunnelQueue.reset()
                        userData.tunnelQueue.externalResolve([client, info, userData.protocolVersion], () => {
                            killConnection(client)
                        })
                    }
                    // the replaced connection is likely dead, do not wait for it to time out
                    if (previous && previous !== client) {
                        console.log(`${userData.id}: [SSH] closing the replaced tunnel connection`);
                        killConnection(previous)
                    }
                }

                if (name === 'cancel-tcpip-forward' && client.userData!.tunnelConnection === client) {
                    client.userData!.tunnelConnection = null
                    client.userData!.tunnelQueue.reset()
                }
            });
        }).on('end', function() {
            release('ended')
        });
    })
}

export default function(config: Config, store: UserStore, hostKeys: Buffer[]) {
    const server = createSshServer(config, store, hostKeys)

    server.listen(config.sshListen, '0.0.0.0', function() {
        console.log('SSH server listening on port ' + (server.address() as AddressInfo).port);
    });
}