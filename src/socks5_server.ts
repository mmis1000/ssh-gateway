import './compat'
import { User } from './user'
import { UserStore } from './store'
const inspect = require('util').inspect;
import { createServer } from 'socksv5';
import socksPasswordAuth from "./socks5_auth_password.js";
import { Config } from './interface';
import { Duplex } from 'stream';
import { closeWhenDone } from './utils';
export function createSocksServer(config: Config, store: UserStore) {
    const srv = createServer(function(info, accept, deny) {
        const stream = accept(true);
        const userInfo = stream.userInfo;
        const dstPort = info.dstPort;

        stream.pause();
        process.nextTick(function() {
           stream.pause();
        });
        
        stream.on('error', function (err) {
            console.log(err);
            try {
                stream.destroy()
            } catch (err) {
                console.error(`${userInfo.id}: [Socks5] error during destroy stream ${inspect(err)}`)
            }
        })
        
        userInfo.getClient()
        .then(function(sshClient) {
            sshClient.forwardOut('localhost', ~~(Math.random() * 65535), 'localhost', dstPort, function(err, dstStream) {
                if (err) {
                    console.log(err);
                    return stream.end();
                }
                
                console.log(`${userInfo.id}: [Socks5] Forward sock connection established at port ${dstPort}`);
                
                dstStream.on('error', function (err?: Error) {
                    console.log(err);
                    try {
                        dstStream.destroy()
                    } catch (err) {
                        console.error(`${userInfo.id}: [Socks5] error during destroy destination stream ${inspect(err)}`)
                    }
                })
                
                closeWhenDone(dstStream)

                stream.on('end', function () {
                    dstStream.end();
                })

                // also close the channel when the visitor disconnects abruptly
                stream.on('close', function () {
                    dstStream.destroy();
                })
                
                stream.pipe(dstStream).pipe(stream);
            })
        })
        .catch(function (err) {
            stream.end();
        })
    });
    
    srv.useAuth(socksPasswordAuth(function(stream: Duplex & { user: string, userInfo: User }, user: string, password: string, cb: (success: boolean | Error) => void) {
        store.findById(user)
        .then(function (userInfo) {
            stream.user = user;
            stream.userInfo = userInfo;
            return userInfo.password === password;
        }, function () {
            return false
        })
        // outside the lookup chain, an error thrown by cb must not call it again
        .then(function (success) {
            cb(success)
        })
    }));

    return srv
}

export default function(config: Config, store: UserStore) {
    const srv = createSocksServer(config, store)

    srv.listen(config.socksListen, "0.0.0.0", function() {
        console.log('SOCKS server listening on port ' + config.socksListen);
    });
}
