const config = require("./config");
const httpServer = require("./lib/http_server")
const sshServer = require("./lib/ssh_server")

httpServer(config);
sshServer(config)