const config = require("./config");
const httpServer = require("./lib/http_server");
const sshServer = require("./lib/ssh_server");
const socks5Server = require("./lib/socks5_server");

httpServer(config);
sshServer(config);
socks5Server(config);