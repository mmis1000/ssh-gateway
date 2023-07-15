export function encodePath (str: string) {
    return str.split('/').map((p)=>encodeURIComponent(p)).join('/')
}
export function decodePath (str: string) {
    return str.split('/').map((p)=>decodeURIComponent(p)).join('/')
}
