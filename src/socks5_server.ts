import { User, getUserWithName } from './user'
const inspect = require('util').inspect;
import { createServer } from 'socksv5';
import socksPasswordAuth from "./socks5_auth_password.js";
import { Config } from './interface';
import { Duplex } from 'stream';
export default function(config: Config) {
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
                
                stream.on('end', function () {
                    dstStream.end();
                })
                
                stream.pipe(dstStream).pipe(stream);
            })
        })
        .catch(function (err) {
            stream.end();
        })
    });
    
    srv.listen(config.socksListen, "0.0.0.0", function() {
        console.log('SOCKS server listening on port ' + config.socksListen);
    });

    srv.useAuth(socksPasswordAuth(function(stream: Duplex & { user: string, userInfo: User }, user: string, password: string, cb: (success: boolean | Error) => void) {
        getUserWithName(config.saveDir, user)
        .then(function (userInfo) {
            stream.user = user;
            stream.userInfo = userInfo;
            cb(userInfo.password === password);
        })
        .catch(function (err) {
            cb(false)
        })
    }));
}