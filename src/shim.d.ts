declare module 'buffer-equal-constant-time' {
    const compare: (buf1: Buffer, buf2: Buffer) => boolean
    export default compare
}
