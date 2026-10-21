import { promises as fs } from 'fs'
import { resolve } from 'path'
import { inspect } from "util";
import { Config } from "./interface";

/** host keys lived in the project root before storage version 2 */
export const LEGACY_HOST_KEY_DIR = resolve(__dirname, '..')

export async function readConfig() {
    let config: Config
    try {
        config = JSON.parse(await fs.readFile(resolve(__dirname, '../config.json'), 'utf8'))
    } catch (err) {
        console.error(inspect(err))
        throw new Error('Please check if there is a valid config.json exists')
    }
    if (config.setupRequireAuth && (!config.setupAccount || !config.setupPassword)) {
        throw new Error('bad config, requires auth without setup the credential')
    }
    return config
}
