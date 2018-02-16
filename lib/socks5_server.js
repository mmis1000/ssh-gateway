const getUser = require("./user").getUser;
const inspect = require('util').inspect;
const socks = require('socksv5');
const socksPasswordAuth = require("./socks5_auth_password.js");
    
module.exports = function(config) {
    const srv = socks.createServer(function(info, accept, deny) {
        const stream = accept(true);
        const userInfo = stream.userInfo;
        const dstPort = info.dstPort;
        
        stream.on('error', function () {
            try {
                stream.destroy()
            } catch (err) {
                console.error(`${userInfo.id}: [Socks5] error during destroy stream ${inspect(err)}`)
            }
        })
        
        userInfo.getClient()
        .then(function(sshClient) {
            sshClient.forwardOut('localhost', 9999, 'localhost', dstPort, function(err, dstStream) {
                if (err) {
                    return stream.end();
                }
                
                console.log(`${userInfo.id}: [Socks5] Forward sock connection established at port ${dstPort}`);
                
                dstStream.on('error', function () {
                    try {
                        dstStream.destroy()
                    } catch (err) {
                        console.error(`${userInfo.id}: [Socks5] error during destroy destination stream ${inspect(err)}`)
                    }
                })
                
                stream.pipe(dstStream).pipe(stream);
            })
        })
        .catch(function (err) {
            stream.end();
        })
    });
    
    srv.listen(config.socksPort, "0.0.0.0", function() {
        console.log('SOCKS server listening on port ' + config.socksPort);
    });

    srv.useAuth(socksPasswordAuth(function(stream, user, password, cb) {
        getUser(user)
        .then(function (userInfo) {
            stream.user = user;
            stream.userInfo = user.userInfo;
            cb(userInfo.password === password);
        })
        .catch(function (err) {
            cb(false)
        })
    }));
}