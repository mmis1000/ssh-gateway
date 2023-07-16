import httpServer from "./http_server";
import sshServer from "./ssh_server";
import socks5Server from "./socks5_server";
import { promises as fs } from 'fs'
import { resolve } from 'path'
import { Config } from "./interface";
import { inspect } from "util";

fs.readFile(resolve(__dirname, '../config.json'), 'utf8').then(res => {
    const config: Config = JSON.parse(res)
    if (config.setupRequireAuth && (!config.setupAccount || !config.setupPassword)) {
        throw new Error('bad config, requires auth without setup the credential')
    }
    httpServer(config);
    sshServer(config);
    socks5Server(config);
}).catch(err => {
    console.error(inspect(err))
    console.error('Please check if there is a valid config.json exists')
})