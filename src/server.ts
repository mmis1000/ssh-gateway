import httpServer from "./http_server";
import sshServer from "./ssh_server";
import socks5Server from "./socks5_server";
import { promises as fs } from 'fs'
import { resolve } from 'path'
import { Config } from "./interface";

fs.readFile(resolve(__dirname, '../config.json'), 'utf8').then(res => {
    const config: Config = JSON.parse(res)
    httpServer(config);
    sshServer(config);
    socks5Server(config);
})