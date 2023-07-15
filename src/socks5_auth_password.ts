import { Duplex } from "stream";

var STATE_VERSION = 0,
    // server
    STATE_ULEN = 1,
    STATE_UNAME = 2,
    STATE_PLEN = 3,
    STATE_PASSWD = 4,
    // client
    STATE_STATUS = 5;

    // server
var BUF_SUCCESS = Buffer.from([0x01, 0x00]),
    BUF_FAILURE = Buffer.from([0x01, 0x01]);

export default function UserPasswordAuthHandlers(...args: any[]) {
  var authcb: (stream:Duplex, user: string, pass: string, cb: (success: boolean | Error) => void) => void,
      user: string,
      pass: string,
      userBuffer: Buffer,
      passBuffer: Buffer,
      userlen: number,
      passlen: number;

  if (args.length === 1 && typeof args[0] === 'function')
    authcb = args[0];
  else if (args.length === 2
           && typeof args[0] === 'string'
           && typeof args[1] === 'string') {
    user = args[0];
    pass = args[1];
    userlen = Buffer.byteLength(user);
    passlen = Buffer.byteLength(pass);
    if (userlen > 255)
      throw new Error('Username too long (limited to 255 bytes)');
    else if (passlen > 255)
      throw new Error('Password too long (limited to 255 bytes)');
  } else
    throw new Error('Wrong arguments');

  return {
    METHOD: 0x02,
    server: function serverHandler(stream: Duplex, cb: (success: boolean | Error) => void) {
      var state = STATE_VERSION,
          userp = 0,
          passp = 0;

      function onData(chunk: Buffer) {
        var i = 0,
            len = chunk.length,
            left,
            chunkLeft,
            minLen;

        while (i < len) {
          switch (state) {
            /*
              +----+------+----------+------+----------+
              |VER | ULEN |  UNAME   | PLEN |  PASSWD  |
              +----+------+----------+------+----------+
              | 1  |  1   | 1 to 255 |  1   | 1 to 255 |
              +----+------+----------+------+----------+
            */
            case STATE_VERSION:
              if (chunk[i] !== 0x01) {
                stream.removeListener('data', onData);
                cb(new Error('Unsupported auth request version: ' + chunk[i]));
                return;
              }
              ++i;
              ++state;
            break;
            case STATE_ULEN:
              var ulen = chunk[i];
              if (ulen === 0) {
                stream.removeListener('data', onData);
                cb(new Error('Bad username length (0)'));
                return;
              }
              ++i;
              ++state;
              userBuffer = Buffer.alloc(ulen);
              userp = 0;
            break;
            case STATE_UNAME:
              left = user.length - userp;
              chunkLeft = len - i;
              minLen = (left < chunkLeft ? left : chunkLeft);
              chunk.copy(userBuffer,
                         userp,
                         i,
                         i + minLen);
              userp += minLen;
              i += minLen;
              if (userp === user.length) {
                user = userBuffer.toString('utf8');
                ++state;
              }
            break;
            case STATE_PLEN:
              var plen = chunk[i];
              if (plen === 0) {
                stream.removeListener('data', onData);
                cb(new Error('Bad password length (0)'));
                return;
              }
              ++i;
              ++state;
              passBuffer = Buffer.alloc(plen);
              passp = 0;
            break;
            case STATE_PASSWD:
              left = pass.length - passp;
              chunkLeft = len - i;
              minLen = (left < chunkLeft ? left : chunkLeft);
              chunk.copy(passBuffer,
                         passp,
                         i,
                         i + minLen);
              passp += minLen;
              i += minLen;
              if (passp === pass.length) {
                stream.removeListener('data', onData);
                pass = passBuffer.toString('utf8');
                state = STATE_VERSION;
                if (i < len)
                  stream.unshift(chunk.slice(i));
                authcb(stream, user, pass, function(success) {
                  if (stream.writable) {
                    if (success)
                      stream.write(BUF_SUCCESS);
                    else
                      stream.write(BUF_FAILURE);
                    cb(success);
                  }
                });
                return;
              }
            break;
            // ===================================================================
          }
        }
      }
      stream.on('data', onData);
    }
  };
};