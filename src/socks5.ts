/**
 * The parts of SOCKS5 (RFC 1928) and its username/password auth (RFC 1929) the gateway uses.
 * Each parser takes everything received so far and returns the message with the bytes it
 * used, null when more bytes are needed, or an Error for a malformed message.
 */

export const SOCKS_VERSION = 0x05
export const AUTH_VERSION = 0x01
export const METHOD_USER_PASS = 0x02
export const METHOD_NONE_ACCEPTABLE = 0xff
export const COMMAND_CONNECT = 0x01

export enum ReplyStatus {
    Granted = 0x00,
    GeneralFailure = 0x01,
    NotAllowed = 0x02,
    NetworkUnreachable = 0x03,
    HostUnreachable = 0x04,
    ConnectionRefused = 0x05,
    CommandNotSupported = 0x07,
    AddressTypeNotSupported = 0x08,
}

export interface Parsed<T> {
    value: T,
    /** bytes of the input the message used */
    length: number,
}

/** VER | NMETHODS | METHODS */
export function parseGreeting(buf: Buffer): Parsed<number[]> | null | Error {
    if (buf.length < 2) return null
    if (buf[0] !== SOCKS_VERSION) return new Error(`unsupported socks version ${buf[0]}`)
    const count = buf[1]
    if (count === 0) return new Error('no auth methods offered')
    if (buf.length < 2 + count) return null
    return { value: [...buf.subarray(2, 2 + count)], length: 2 + count }
}

/** VER | ULEN | UNAME | PLEN | PASSWD */
export function parseUserPass(buf: Buffer): Parsed<{ username: string, password: string }> | null | Error {
    if (buf.length < 2) return null
    if (buf[0] !== AUTH_VERSION) return new Error(`unsupported auth version ${buf[0]}`)
    const userLength = buf[1]
    if (userLength === 0) return new Error('empty username')
    if (buf.length < 2 + userLength + 1) return null
    const passLength = buf[2 + userLength]
    if (passLength === 0) return new Error('empty password')
    const length = 2 + userLength + 1 + passLength
    if (buf.length < length) return null
    return {
        value: {
            username: buf.toString('utf8', 2, 2 + userLength),
            password: buf.toString('utf8', 3 + userLength, length),
        },
        length,
    }
}

export interface SocksRequest {
    command: number,
    host: string,
    port: number,
}

export class AddressTypeError extends Error {}

/** VER | CMD | RSV | ATYP | DST.ADDR | DST.PORT */
export function parseRequest(buf: Buffer): Parsed<SocksRequest> | null | Error {
    if (buf.length < 5) return null
    if (buf[0] !== SOCKS_VERSION) return new Error(`unsupported socks version ${buf[0]}`)
    const command = buf[1]
    let host: string
    let offset: number
    switch (buf[3]) {
        case 0x01: // IPv4
            if (buf.length < 4 + 4 + 2) return null
            host = [...buf.subarray(4, 8)].join('.')
            offset = 8
            break
        case 0x03: { // domain name
            const nameLength = buf[4]
            if (buf.length < 5 + nameLength + 2) return null
            host = buf.toString('utf8', 5, 5 + nameLength)
            offset = 5 + nameLength
            break
        }
        case 0x04: { // IPv6
            if (buf.length < 4 + 16 + 2) return null
            const groups: string[] = []
            for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(4 + i).toString(16))
            host = groups.join(':')
            offset = 20
            break
        }
        default:
            return new AddressTypeError(`unsupported address type ${buf[3]}`)
    }
    return { value: { command, host, port: buf.readUInt16BE(offset) }, length: offset + 2 }
}

/** reply to a request, the bound address is not meaningful for the gateway */
export function reply(status: ReplyStatus) {
    return Buffer.from([SOCKS_VERSION, status, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}
