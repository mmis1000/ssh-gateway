export interface Config {
    /** external ssh server hostname */
    "sshHost": string,
    /** external ssh server port */
    "sshPort": number,
    /** internal listen ssh server port */
    "sshListen": number,
    /** external http server protocol */
    "httpProtocol": string,
    /** external http server hostname */
    "httpHost": string,
    /** external http server port */
    "httpPort": number,
    /** internal listen http server port */
    "httpListen": number,
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
    "saveDir": string
}