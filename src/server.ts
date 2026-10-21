import httpServer from "./http_server";
import sshServer from "./ssh_server";
import socks5Server from "./socks5_server";
import { resolve } from 'path'
import { inspect } from "util";
import { LEGACY_HOST_KEY_DIR, readConfig } from "./config";
import { openStore } from "./migrate";
import { loadHostKeys } from "./keys";

async function main() {
    const config = await readConfig()
    const store = await openStore(resolve(config.saveDir), LEGACY_HOST_KEY_DIR)
    const hostKeys = await loadHostKeys(store.hostKeyDir)

    await httpServer(config, store);
    sshServer(config, store, hostKeys);
    socks5Server(config, store);
}

main().catch(err => {
    console.error(err instanceof Error ? err.message : inspect(err))
    process.exit(1)
})
