declare module 'buffer-equal-constant-time' {
    const compare: (buf1: Buffer, buf2: Buffer) => boolean
    export default compare
}
declare module 'socksv5' {
    class Server {
        listen(port: number, ip: string, cb: () => void): void
        useAuth(opt: {
            METHOD: number,
            server: (stream: Duplex, cb: (success: boolean | Error) => void) => void
        }): void
    }

    type Socket = import('net').Socket
    type User = import('./user').User
    interface SocksStream extends Socket {
        userInfo: User
    }
    interface Info {
        dstPort: number
    }
    export const createServer: (cb: (info: Info, accept: (b: boolean) => SocksStream, deny: () => void) => void) => Server
    export default compare
}
socksv5