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

export interface AbstractPacket {
    type: string,
    id: number
}

export interface PacketPing extends AbstractPacket {
    type: 'ping'
}


interface PacketAuthenticated extends AbstractPacket {
    type: 'authenticated'
}


interface PacketRequestHeader extends AbstractPacket {
    type: 'request-header',
    method: string,
    path: string,
    headers: Record<string, string | string[] | undefined>
}

interface PacketResponseHeader extends AbstractPacket {
    type: 'response-header',
    method: string,
    path: string,
    code: number,
    headers: Record<string, string | string[] | undefined>
}

export type Packet =
    | PacketPing
    | PacketAuthenticated
    | PacketRequestHeader
    | PacketResponseHeader