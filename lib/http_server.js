const http = require("http");
const express = require("express");
const inspect = require('util').inspect;
const createUser = require("./user").createUser;
const getUser = require("./user").getUser;
const render = require("./templete");
const fs = require("fs")
const path = require("path");

module.exports = function(config) {
    const router = express();
    const server = http.createServer(router);
    
    router.use(function (req, res, next) {
        var domain = req.hostname;
        
        if (domain === config.httpHost) {
            return next();
        }
        
        var id = domain.split('.')[0];
        
        getUser(id)
        .then(function (userData) {
            console.log('user get!!!')
            
            if (!userData.sshClient) {
                return res.end('connection not yes established');
            }
            
            var client = http.request({
                createConnection: function (opts, cb) {
                    userData.sshClient.forwardOut('localhost', 9999, 'localhost', userData.httpPort, function(err, stream) {
                        if (err) {
                            return cb(err);
                        }
                        console.log('forward http connection established')
                        cb(null, stream);
                    })
                },
                headers: Object.assign({}, req.headers, {
                    "X-Forwarded-For": `${req.ip} 127.0.0.1`
                }),
                method: req.method,
                path: req.originalUrl
            })
            
            req
            .on('error', function (err) {
                res.status(500).end(inspect(err))
            })
            .pipe(client)
                
            client.on('response', function (msg) {
                res.writeHeader(msg.statusCode, Object.assign({}, msg.headers, {
                    "X-Proxy-User": userData.id
                }))
                
                
                msg
                .on('error', function nuzz() {})
                .pipe(res)
                .on('error', function nuzz() {})
            })
            
            
            client
            .on('error', function (err) {
                res.status(500).end(inspect(err))
            })
            
            // return res.end('not yet implement')
        })
        .catch(function (err) {
            res.status(500).end(inspect(err))
        })
    })
    
    router.get('/setup', function (req, res, next) {
        var domain = req.hostname;
        
        if (domain !== config.httpHost) {
            return next();
        }
        
        createUser()
        .then(function (userData) {
            res.set('Content-Type', 'application/x-sh');
            
            res.end(render(fs.readFileSync(path.join(__dirname, '../templete/script.templete'), 'utf8'), {
                TARGET_PORT: config.sshPort,
                TARGET_USER: userData.id,
                TARGET_HOST: config.sshHost,
                CLIENT_PRIVATE_KEY: userData.privateKey,
                CLIENT_SERVER_KEY: userData.publicKey_pub,
                LISTEN_PORT: 30020
            }))
        })
        .catch(function (err) {
            res.status(500).end(err.stack)
        })
    })
    
    router.get('/', function (req, res, next) {
        var domain = req.hostname;
        
        if (domain !== config.httpHost) {
            return next();
        }
        
        res.end('see /setup')
    })
    
    server.listen(config.httpListen || 8080, "0.0.0.0", function() {
        var addr = server.address();
        console.log("Http server listening at", addr.address + ":" + addr.port);
    });
}
