import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat } from "fs/promises";
import path from "path";
import { HOST_KEY_TYPES, hostKeyFileName } from "./keys";
import {
    CLIENT_KEY_FILE,
    DOMAIN_PATTERN,
    GATEWAY_KEY_FILE,
    ID_PATTERN,
    initEmptyStore,
    randomPassword,
    readStoreVersion,
    STORE_VERSION,
    storePaths,
    UserRecord,
    UserStore,
    writeUserRecord,
} from "./store";

/**
 * Version 1 layout, before the store had a version file:
 *
 * save/<id>/info.json            { id, domain, password }
 * save/<id>/private_key(.pub)    client login key, now client_key
 * save/<id>/public_key(.pub)     gateway to client sshd key, now gateway_key
 * save/domains/<domain>          file containing the id
 * <project root>/ssh_host_<type>_key(.pub)
 */
const V1_KEY_FILES: [from: string, to: string][] = [
    ['private_key', CLIENT_KEY_FILE],
    ['private_key.pub', `${CLIENT_KEY_FILE}.pub`],
    ['public_key', GATEWAY_KEY_FILE],
    ['public_key.pub', `${GATEWAY_KEY_FILE}.pub`],
]

type Log = (msg: string) => void

export interface MigrationPlan {
    saveDir: string,
    tmpDir: string,
    backupDir: string,
    /** where the v1 host keys were kept */
    legacyHostKeyDir: string,
    users: (UserRecord & { sourceDir: string })[],
    hostKeys: string[],
    warnings: string[],
}

export const migrationTmpDir = (saveDir: string) => `${saveDir}.v2-tmp`

async function exists(file: string) {
    try {
        await stat(file)
        return true
    } catch (err: any) {
        if (err.code === 'ENOENT') return false
        throw err
    }
}

async function readdirIfExists(dir: string) {
    try {
        return await readdir(dir, { withFileTypes: true })
    } catch (err: any) {
        if (err.code === 'ENOENT') return []
        throw err
    }
}

/** the legacy host key files (private and public) found in `dir` */
async function findLegacyHostKeys(dir: string) {
    const found: string[] = []
    for (const type of HOST_KEY_TYPES) {
        for (const name of [hostKeyFileName(type), `${hostKeyFileName(type)}.pub`]) {
            if (await exists(path.join(dir, name))) found.push(name)
        }
    }
    return found
}

/** look at a save directory without a version file and work out what migrating it would do */
export async function planMigration(saveDir: string, legacyHostKeyDir: string): Promise<MigrationPlan | null> {
    const entries = await readdirIfExists(saveDir)
    const hostKeys = await findLegacyHostKeys(legacyHostKeyDir)
    if (entries.length === 0 && hostKeys.length === 0) return null

    const warnings: string[] = []
    const users: MigrationPlan['users'] = []

    const domainIndex = new Map<string, string>()
    for (const entry of await readdirIfExists(path.join(saveDir, 'domains'))) {
        domainIndex.set(entry.name, (await readFile(path.join(saveDir, 'domains', entry.name), 'utf8')).trim())
    }

    for (const entry of entries) {
        if (entry.name === 'domains' && entry.isDirectory()) continue

        const sourceDir = path.join(saveDir, entry.name)
        const infoFile = path.join(sourceDir, 'info.json')
        if (!entry.isDirectory() || !await exists(infoFile)) {
            warnings.push(`${entry.name}: not a user directory, kept in the backup only`)
            continue
        }

        try {
            const info = JSON.parse(await readFile(infoFile, 'utf8'))
            if (info.id !== entry.name) throw new Error(`info.json has id ${info.id}`)
            if (!ID_PATTERN.test(info.id)) throw new Error(`invalid id`)
            if (!DOMAIN_PATTERN.test(info.domain)) throw new Error(`invalid domain ${info.domain}`)
            if (typeof info.password !== 'string' || info.password === '') throw new Error('missing password')
            for (const [from] of V1_KEY_FILES) {
                if (!await exists(path.join(sourceDir, from))) throw new Error(`missing ${from}`)
            }

            const indexed = domainIndex.get(info.domain)
            if (indexed !== info.id) {
                warnings.push(`${info.id}: domains/${info.domain} ${indexed === undefined ? 'is missing' : `points to ${indexed}`}, using info.json`)
            }

            const extra = (await readdir(sourceDir)).filter(name => name !== 'info.json' && !V1_KEY_FILES.some(([from]) => from === name))
            if (extra.length) warnings.push(`${info.id}: unknown files ${extra.join(', ')} kept in the backup only`)

            users.push({
                id: info.id,
                domain: info.domain,
                password: info.password,
                socksPassword: randomPassword(),
                createdAt: (await stat(infoFile)).mtime.toISOString(),
                sourceDir,
            })
        } catch (err: any) {
            warnings.push(`${entry.name}: skipped, ${err.message}`)
        }
    }

    for (const [domain, id] of domainIndex) {
        if (!users.some(user => user.domain === domain && user.id === id) && !users.some(user => user.id === id)) {
            warnings.push(`domains/${domain}: points to unknown user ${id}, dropped`)
        }
    }

    const time = new Date().toISOString().replace(/[:.]/g, '-')
    return {
        saveDir,
        tmpDir: migrationTmpDir(saveDir),
        backupDir: `${saveDir}.backup-v1-${time}`,
        legacyHostKeyDir,
        users,
        hostKeys,
        warnings,
    }
}

export function describePlan(plan: MigrationPlan) {
    return [
        `Migrate ${plan.saveDir} to storage version ${STORE_VERSION}`,
        ...plan.users.map(user => `  user ${user.id} (${user.domain})`),
        ...plan.hostKeys.map(name => `  host key ${path.join(plan.legacyHostKeyDir, name)}`),
        `  old files are moved to ${plan.backupDir}`,
        ...plan.warnings.map(warning => `  warning: ${warning}`),
    ].join('\n')
}

/**
 * Build the new layout next to the old one, then swap:
 * save -> backup, legacy host keys -> backup, tmp -> save.
 */
export async function runMigration(plan: MigrationPlan, log: Log = console.log) {
    log(describePlan(plan))

    await rm(plan.tmpDir, { recursive: true, force: true })
    await initEmptyStore(plan.tmpDir)
    const tmpPaths = storePaths(plan.tmpDir)

    for (const user of plan.users) {
        const dir = tmpPaths.user(user.id)
        await mkdir(dir, { mode: 0o700 })
        for (const [from, to] of V1_KEY_FILES) {
            await copyFile(path.join(user.sourceDir, from), path.join(dir, to))
            await chmod(path.join(dir, to), to.endsWith('.pub') ? 0o644 : 0o600)
        }
        const { sourceDir: _, ...record } = user
        await writeUserRecord(dir, record)
    }

    for (const name of plan.hostKeys) {
        const target = path.join(tmpPaths.hostKeys, name)
        await copyFile(path.join(plan.legacyHostKeyDir, name), target)
        await chmod(target, name.endsWith('.pub') ? 0o644 : 0o600)
    }

    // the tmp dir now has a version file, from here on a restart finishes the swap
    if (await exists(plan.saveDir)) {
        await rename(plan.saveDir, plan.backupDir)
    } else {
        await mkdir(plan.backupDir, { recursive: true, mode: 0o700 })
    }
    if (plan.hostKeys.length) {
        const legacyKeyBackup = path.join(plan.backupDir, 'legacy_host_keys')
        await mkdir(legacyKeyBackup, { recursive: true, mode: 0o700 })
        for (const name of plan.hostKeys) {
            await rename(path.join(plan.legacyHostKeyDir, name), path.join(legacyKeyBackup, name))
        }
    }
    await rename(plan.tmpDir, plan.saveDir)

    log(`[Store] migrated to storage version ${STORE_VERSION}, old files are in ${plan.backupDir}`)
}

/** finish or discard a migration that was interrupted */
export async function recoverInterruptedMigration(saveDir: string, log: Log = console.log) {
    const tmpDir = migrationTmpDir(saveDir)
    if (!await exists(tmpDir)) return

    if (!await exists(saveDir) && await readStoreVersion(tmpDir) === STORE_VERSION) {
        await rename(tmpDir, saveDir)
        log(`[Store] finished an interrupted migration`)
    } else {
        await rm(tmpDir, { recursive: true, force: true })
        log(`[Store] removed an incomplete migration, it will run again`)
    }
}

/** open the store at `saveDir`, migrating or creating it first when needed */
export async function openStore(saveDir: string, legacyHostKeyDir: string, log: Log = console.log) {
    await recoverInterruptedMigration(saveDir, log)

    const version = await readStoreVersion(saveDir)
    if (version === null) {
        const plan = await planMigration(saveDir, legacyHostKeyDir)
        if (plan) {
            await runMigration(plan, log)
        } else {
            await initEmptyStore(saveDir)
            log(`[Store] created a new store at ${saveDir}`)
        }
    } else if (version !== STORE_VERSION) {
        throw new Error(`${saveDir} uses storage version ${version}, this version of ssh-gateway only supports ${STORE_VERSION}`)
    }

    const leftover = await findLegacyHostKeys(legacyHostKeyDir)
    if (leftover.length) {
        log(`[Store] warning: ${leftover.join(', ')} in ${legacyHostKeyDir} are not used, host keys are read from ${storePaths(saveDir).hostKeys}`)
    }

    const store = new UserStore(saveDir, log)
    await store.load()
    return store
}
