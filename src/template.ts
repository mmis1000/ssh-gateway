import { promises as fs } from "fs";
import path from "path";
import type { Config } from "./interface";
import type { User } from "./user";
import { knownHostsLines } from "./keys";

export default function render(string: string, options: { [k: string]: string | number }) {
    for (let key in options) {
        string = string.replace(new RegExp('\\*' + key + '\\*', 'g'), String(options[key]));
    }

    var unrendered = string.match(/\*[a-zA-Z0-9_]+\*/g);

    if (unrendered) {
        console.warn('[warning] unrandered variable: ' + unrendered.join(', '));
    }

    return string;
}

export const CLIENT_TEMPLATE_DIR = path.join(__dirname, '../template/client')

/** the parts of run.sh in file name order, each after the first under a line naming it */
export async function readClientTemplate(dir = CLIENT_TEMPLATE_DIR) {
    const names = (await fs.readdir(dir)).filter(name => name.endsWith('.sh')).sort()
    const parts = await Promise.all(names.map(name => fs.readFile(path.join(dir, name), 'utf8')))
    return parts
        .map((part, i) => i === 0 ? part : `# ===== ${names[i]} =====\n${part}`)
        .join('\n')
}

type ClientScriptConfig = Pick<Config, 'sshHost' | 'sshPort' | 'userListenPortLow' | 'userListenPortHigh'>

/** run.sh for a user, from the parts in template/client */
export function renderClientScript(template: string, config: ClientScriptConfig, user: User, knownHosts: string) {
    return render(template, {
        TARGET_PORT: config.sshPort,
        TARGET_USER: user.id!,
        TARGET_HOST: config.sshHost,
        CLIENT_PRIVATE_KEY: user.clientKey!,
        CLIENT_SERVER_KEY: user.gatewayKeyPub!,
        LISTEN_PORT_LOW: config.userListenPortLow,
        LISTEN_PORT_HIGH: config.userListenPortHigh,
        KNOWN_HOSTS: knownHosts,
    })
}

/**
 * run.sh for a user as /setup, /update and the ssh "update" command hand it out. The template is
 * read once, the host keys on each call, they are generated on the first start
 */
export function clientScripts(config: ClientScriptConfig, hostKeyDir: string) {
    const templatePromise = readClientTemplate()
    return async (user: User) => {
        const [template, knownHosts] = await Promise.all([
            templatePromise,
            knownHostsLines(hostKeyDir, config.sshHost, config.sshPort),
        ])
        return renderClientScript(template, config, user, knownHosts.join('\n'))
    }
}
