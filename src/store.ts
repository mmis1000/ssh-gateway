import { randomInt } from "crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
import { generateKeyPair, writeKeyPair } from "./keys";
import { User } from "./user";
const hri = require("human-readable-ids").hri;

export const STORE_VERSION = 2

export const ID_PATTERN = /^[a-z0-9]{1,32}$/
export const DOMAIN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * save/
 *   version
 *   host_keys/ssh_host_<type>_key(.pub)
 *   users/<id>/user.json, client_key(.pub), gateway_key(.pub)
 */
export const storePaths = (saveDir: string) => ({
    version: path.join(saveDir, 'version'),
    hostKeys: path.join(saveDir, 'host_keys'),
    users: path.join(saveDir, 'users'),
    user: (id: string) => path.join(saveDir, 'users', id),
})

export const USER_RECORD_FILE = 'user.json'
export const CLIENT_KEY_FILE = 'client_key'
export const GATEWAY_KEY_FILE = 'gateway_key'

export interface UserRecord {
    id: string,
    domain: string,
    /** logs in to the inspector and fetches the script, never sent unencrypted */
    password: string,
    /** for the SOCKS5 proxy only, which sends it in the clear, so it must not unlock anything else */
    socksPassword: string,
    /** ISO date */
    createdAt: string,
    /**
     * the newest run.sh this user registered with, it only goes up. Missing in records from before
     * it was kept, which counts as 0. From version 9 on, the script updates over ssh and /update no
     * longer hands it out for the password
     */
    highestScriptVersion?: number,
}

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789'
const randomString = (length: number) => Array.from({ length }, () => ALPHANUMERIC[randomInt(ALPHANUMERIC.length)]).join('')
export const randomPassword = () => randomString(16)
/** random characters after the readable part of new domains */
const DOMAIN_SUFFIX_LENGTH = 6

export async function readStoreVersion(saveDir: string) {
    try {
        return parseInt(await readFile(storePaths(saveDir).version, 'utf8'), 10)
    } catch (err: any) {
        if (err.code === 'ENOENT') return null
        throw err
    }
}

export async function initEmptyStore(saveDir: string) {
    const paths = storePaths(saveDir)
    await mkdir(paths.users, { recursive: true, mode: 0o700 })
    await mkdir(paths.hostKeys, { recursive: true, mode: 0o700 })
    await writeFile(paths.version, `${STORE_VERSION}\n`)
}

/** replaces user.json in one step, a crash leaves either the old or the new record */
export async function writeUserRecord(dir: string, record: UserRecord) {
    const file = path.join(dir, USER_RECORD_FILE)
    await writeFile(`${file}.tmp`, JSON.stringify(record, undefined, 2) + '\n', { mode: 0o600 })
    await rename(`${file}.tmp`, file)
}

export class UserStore {
    private byId = new Map<string, User>()
    private byDomain = new Map<string, User>()
    /** pending writes of user.json per user, so they land in order */
    private recordWrites = new Map<string, Promise<unknown>>()

    constructor (readonly saveDir: string, private log: (msg: string) => void = console.log) {}

    get hostKeyDir() {
        return storePaths(this.saveDir).hostKeys
    }

    /** read every user into memory, broken entries are logged and skipped */
    async load() {
        const paths = storePaths(this.saveDir)
        for (const entry of await readdir(paths.users, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue
            try {
                this.add(await this.readUser(entry.name))
            } catch (err: any) {
                this.log(`[Store] skipped user ${entry.name}: ${err.message}`)
            }
        }
        this.log(`[Store] loaded ${this.byId.size} user(s)`)
    }

    private async readUser(id: string) {
        if (!ID_PATTERN.test(id)) throw new Error('invalid id')
        const dir = storePaths(this.saveDir).user(id)
        const read = (name: string) => readFile(path.join(dir, name), 'utf8')

        const record: UserRecord = JSON.parse(await read(USER_RECORD_FILE))
        if (record.id !== id) throw new Error(`user.json has id ${record.id}`)
        if (!DOMAIN_PATTERN.test(record.domain)) throw new Error(`invalid domain ${record.domain}`)
        if (this.byDomain.has(record.domain)) throw new Error(`domain ${record.domain} is already used`)

        // users created before the SOCKS5 proxy had a password of its own
        if (typeof record.socksPassword !== 'string' || record.socksPassword === '') {
            record.socksPassword = randomPassword()
            await writeUserRecord(dir, record)
            this.log(`${id}: [Store] added a SOCKS5 password, the old one stops working for SOCKS5`)
        }

        return new User({
            id: record.id,
            password: record.password,
            socksPassword: record.socksPassword,
            domainName: record.domain,
            highestScriptVersion: Number.isSafeInteger(record.highestScriptVersion) ? record.highestScriptVersion! : 0,
            clientKey: await read(CLIENT_KEY_FILE),
            clientKeyPub: await read(`${CLIENT_KEY_FILE}.pub`),
            gatewayKey: await read(GATEWAY_KEY_FILE),
            gatewayKeyPub: await read(`${GATEWAY_KEY_FILE}.pub`),
        })
    }

    private add(user: User) {
        this.byId.set(user.id!, user)
        this.byDomain.set(user.domainName!, user)
    }

    /** names come from logins and host headers, anything not matching the id format is unknown */
    getById(id: unknown) {
        return typeof id === 'string' && ID_PATTERN.test(id) ? this.byId.get(id) : undefined
    }

    getByDomain(domain: unknown) {
        return typeof domain === 'string' && DOMAIN_PATTERN.test(domain) ? this.byDomain.get(domain) : undefined
    }

    /** promise flavour of getById for call sites that chain on the lookup */
    findById(id: unknown) {
        const user = this.getById(id)
        return user ? Promise.resolve(user) : Promise.reject(new Error(`unknown user ${String(id)}`))
    }

    findByDomain(domain: unknown) {
        const user = this.getByDomain(domain)
        return user ? Promise.resolve(user) : Promise.reject(new Error(`unknown domain ${String(domain)}`))
    }

    /** remembers that the user registered with this script version, a lower one changes nothing */
    async noteScriptVersion(user: User, version: number) {
        if (version <= user.highestScriptVersion) return
        user.highestScriptVersion = version
        const id = user.id!
        const dir = storePaths(this.saveDir).user(id)
        const write = (this.recordWrites.get(id) ?? Promise.resolve()).then(async () => {
            const record: UserRecord = JSON.parse(await readFile(path.join(dir, USER_RECORD_FILE), 'utf8'))
            if ((record.highestScriptVersion ?? 0) >= version) return
            record.highestScriptVersion = version
            await writeUserRecord(dir, record)
            this.log(`${id}: [Store] registered with script version ${version} for the first time`)
        })
        this.recordWrites.set(id, write.catch(() => {}))
        await write
    }

    get size() {
        return this.byId.size
    }

    async create() {
        let id = randomString(10)
        while (this.byId.has(id)) id = randomString(10)

        // adjective-animal-number alone is about 1.3M names, few enough to scan for live forwards
        const randomDomain = (): string => `${hri.random()}-${randomString(DOMAIN_SUFFIX_LENGTH)}`
        let domain = randomDomain()
        for (let attempt = 0; this.byDomain.has(domain) || !DOMAIN_PATTERN.test(domain); attempt++) {
            if (attempt > 100) throw new Error('unable to pick an unused domain')
            domain = randomDomain()
        }

        const record: UserRecord = {
            id,
            domain,
            password: randomPassword(),
            socksPassword: randomPassword(),
            createdAt: new Date().toISOString(),
        }

        // write everything to a temporary directory first, so a crash never leaves half a user behind
        const paths = storePaths(this.saveDir)
        const tmpDir = path.join(paths.users, `.tmp-${id}`)
        await rm(tmpDir, { recursive: true, force: true })
        await mkdir(tmpDir, { mode: 0o700 })
        try {
            const [clientKey, gatewayKey] = await Promise.all([
                generateKeyPair('ed25519', `ssh-gateway client ${id}`),
                generateKeyPair('ed25519', `ssh-gateway ${id}`),
            ])
            await writeKeyPair(path.join(tmpDir, CLIENT_KEY_FILE), clientKey)
            await writeKeyPair(path.join(tmpDir, GATEWAY_KEY_FILE), gatewayKey)
            await writeUserRecord(tmpDir, record)
            await rename(tmpDir, paths.user(id))
        } catch (err) {
            await rm(tmpDir, { recursive: true, force: true })
            throw err
        }

        const user = await this.readUser(id)
        this.add(user)
        this.log(`${id}: [Store] created user with domain ${domain}`)
        return user
    }
}
