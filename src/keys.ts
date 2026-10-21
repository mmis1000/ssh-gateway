import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { utils } from "ssh2";

export type KeyType = 'ed25519' | 'ecdsa' | 'rsa'

const KEY_OPTIONS: Record<KeyType, { bits?: number }> = {
    ed25519: {},
    ecdsa: { bits: 256 },
    rsa: { bits: 3072 },
}

export interface KeyPair {
    /** OpenSSH private key */
    private: string,
    /** authorized_keys line */
    public: string,
}

function generateOnce(type: KeyType, comment: string) {
    return new Promise<KeyPair>((resolve, reject) => {
        utils.generateKeyPair(type, { ...KEY_OPTIONS[type], comment }, (err, keys) => {
            if (err) return reject(err)
            resolve({ private: keys.private, public: keys.public })
        })
    })
}

function isValidPair(keys: KeyPair) {
    const parsedPrivate = utils.parseKey(keys.private)
    const parsedPublic = utils.parseKey(keys.public)
    return !(parsedPrivate instanceof Error) && !(parsedPublic instanceof Error)
        && parsedPrivate.getPublicSSH().equals(parsedPublic.getPublicSSH())
}

export async function generateKeyPair(type: KeyType, comment: string) {
    // ssh2 drops a leading zero byte of ed25519 keys, so about 1 in 256 of them is
    // malformed and rejected by both ssh2 and OpenSSH, generate those again
    for (let attempt = 0; attempt < 10; attempt++) {
        const keys = await generateOnce(type, comment)
        if (isValidPair(keys)) return keys
    }
    throw new Error(`unable to generate a valid ${type} key`)
}

/** write a key pair as `<file>` (0600) and `<file>.pub` (0644) */
export async function writeKeyPair(file: string, keys: KeyPair) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, keys.private, { mode: 0o600, flag: 'wx' })
    await writeFile(`${file}.pub`, keys.public.endsWith('\n') ? keys.public : `${keys.public}\n`, { mode: 0o644, flag: 'wx' })
}

/** SHA256 fingerprint in the format `ssh-keygen -l` prints */
export function fingerprint(publicKey: string) {
    const blob = Buffer.from(publicKey.trim().split(/\s+/)[1] ?? '', 'base64')
    return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** host key types, in the order offered to clients */
export const HOST_KEY_TYPES: KeyType[] = ['rsa', 'ecdsa', 'ed25519']

export const hostKeyFileName = (type: KeyType) => `ssh_host_${type}_key`

/** known_hosts lines for the host keys in `dir`, for clients connecting to host:port */
export async function knownHostsLines(dir: string, host: string, port: number) {
    const name = Number(port) === 22 ? host : `[${host}]:${port}`
    const lines: string[] = []
    for (const type of HOST_KEY_TYPES) {
        try {
            const [keyType, key] = (await readFile(path.join(dir, `${hostKeyFileName(type)}.pub`), 'utf8')).trim().split(/\s+/)
            lines.push(`${name} ${keyType} ${key}`)
        } catch (err: any) {
            if (err.code !== 'ENOENT') throw err
        }
    }
    return lines
}

/** read the host keys from `dir`, generating the ones that are missing */
export async function loadHostKeys(dir: string, log: (msg: string) => void = console.log) {
    await mkdir(dir, { recursive: true, mode: 0o700 })

    const keys: Buffer[] = []
    for (const type of HOST_KEY_TYPES) {
        const file = path.join(dir, hostKeyFileName(type))
        try {
            keys.push(await readFile(file))
        } catch (err: any) {
            if (err.code !== 'ENOENT') throw err

            const pair = await generateKeyPair(type, 'ssh-gateway host key')
            await writeKeyPair(file, pair)
            log(`[Keys] generated ${type} host key ${fingerprint(pair.public)}`)
            keys.push(Buffer.from(pair.private))
        }
    }
    return keys
}
