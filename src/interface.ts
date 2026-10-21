export interface Config {
    /** internal listen http server port,
     * it is shared between setup domain and user content proxy 
     */
    "httpListen": number,
    /** protocol of domain for retrieve config, update script */
    "setupProtocol": string,
    /** domain for retrieve config, update script */
    "setupHost": string,
    /** external domain port for retrieve config, update script */
    "setupPort": number,
    /** external ssh server hostname */
    "sshHost": string,
    /** external ssh server port */
    "sshPort": number,
    /** internal listen ssh server port */
    "sshListen": number,
    /** external http server protocol */
    "httpProtocol": string,
    /** external http server hostname, used for serving ugc */
    "httpHost": string,
    /** external http server port */
    "httpPort": number,
    /** external socks5 server hostname */
    "socksHost": string,
    /** external socks5 server port */
    "socksPort": number,
    /** internal listen socks5 server port */
    "socksListen": number,
    /** client port range lower bound*/
    "userListenPortLow": number,
    /** client port range higher bound*/
    "userListenPortHigh": number,
    "trustedProxy": string,
    /** save directory */
    "saveDir": string,
    /** requires basic authentication to setup new forward */
    "setupRequireAuth": boolean,
    /** setup authentication account */
    "setupAccount": string,
    /** setup authentication password */
    "setupPassword": string,

}

export type Headers = Record<string, string | string[] | number | undefined>

export interface CapturedBody {
    /** total bytes seen on the wire */
    size: number,
    /** captured bytes, base64, decoded from content-encoding when possible */
    data: string,
    /** true when only the first part of the body is captured */
    truncated: boolean,
    /** content-encoding that was removed from data, or that failed to decode */
    encoding: string | null,
    decoded: boolean,
}

export interface InspectorEntry {
    id: number,
    /** epoch ms */
    startTime: number,
    /** ms, null while pending */
    duration: number | null,
    state: 'pending' | 'complete' | 'aborted',
    method: string,
    path: string,
    remoteAddress: string,
    requestHeaders: Headers,
    requestBody: CapturedBody | null,
    status: number | null,
    responseHeaders: Headers | null,
    responseBody: CapturedBody | null,
    /** id of the entry this request replays */
    replayOf: number | null,
}

export interface AbstractPacket {
    type: string,
    id: number
}

export interface PacketPing extends AbstractPacket {
    type: 'ping'
}

interface PacketAuthenticated extends AbstractPacket {
    type: 'authenticated',
    /** public url of the user's forward */
    url: string,
}

interface PacketHistory extends AbstractPacket {
    type: 'history',
    entries: InspectorEntry[],
}

/** sent when a request starts and again when it ends, replaces the entry with same id */
interface PacketEntry extends AbstractPacket {
    type: 'entry',
    entry: InspectorEntry,
}

interface PacketReplayFailed extends AbstractPacket {
    type: 'replay-failed',
    message: string,
}

export type Packet =
    | PacketPing
    | PacketAuthenticated
    | PacketHistory
    | PacketEntry
    | PacketReplayFailed

/** messages sent from the inspector after authentication */
export type ClientPacket =
    | { type: 'replay', id: number }
