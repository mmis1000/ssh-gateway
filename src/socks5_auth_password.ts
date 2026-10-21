import { Duplex } from "stream";

var STATE_VERSION = 0,
    STATE_ULEN = 1,
    STATE_UNAME = 2,
    STATE_PLEN = 3,
    STATE_PASSWD = 4;

var BUF_SUCCESS = Buffer.from([0x01, 0x00]),
    BUF_FAILURE = Buffer.from([0x01, 0x01]);

type AuthCallback<S extends Duplex> = (stream: S, user: string, pass: string, cb: (success: boolean | Error) => void) => void

/** server side username/password authentication (RFC 1929) for socksv5 */
export default function UserPasswordAuthHandlers<S extends Duplex>(authcb: AuthCallback<S>) {
  if (typeof authcb !== 'function')
    throw new Error('Wrong arguments');

  return {
    METHOD: 0x02,
    server: function serverHandler(stream: S, cb: (success: boolean | Error) => void) {
      // all parsing state belongs to this connection
      var state = STATE_VERSION,
          userBuffer = Buffer.alloc(0),
          passBuffer = Buffer.alloc(0),
          userp = 0,
          passp = 0;

      function fail(err: Error) {
        stream.removeListener('data', onData);
        cb(err);
      }

      function onData(chunk: Buffer) {
        var i = 0,
            len = chunk.length,
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
              if (chunk[i] !== 0x01)
                return fail(new Error('Unsupported auth request version: ' + chunk[i]));
              ++i;
              state = STATE_ULEN;
            break;
            case STATE_ULEN:
              if (chunk[i] === 0)
                return fail(new Error('Bad username length (0)'));
              userBuffer = Buffer.alloc(chunk[i]);
              userp = 0;
              ++i;
              state = STATE_UNAME;
            break;
            case STATE_UNAME:
              minLen = Math.min(userBuffer.length - userp, len - i);
              chunk.copy(userBuffer, userp, i, i + minLen);
              userp += minLen;
              i += minLen;
              if (userp === userBuffer.length)
                state = STATE_PLEN;
            break;
            case STATE_PLEN:
              if (chunk[i] === 0)
                return fail(new Error('Bad password length (0)'));
              passBuffer = Buffer.alloc(chunk[i]);
              passp = 0;
              ++i;
              state = STATE_PASSWD;
            break;
            case STATE_PASSWD:
              minLen = Math.min(passBuffer.length - passp, len - i);
              chunk.copy(passBuffer, passp, i, i + minLen);
              passp += minLen;
              i += minLen;
              if (passp === passBuffer.length) {
                stream.removeListener('data', onData);
                if (i < len)
                  stream.unshift(chunk.subarray(i));
                authcb(stream, userBuffer.toString('utf8'), passBuffer.toString('utf8'), function(success) {
                  if (stream.writable) {
                    stream.write(success === true ? BUF_SUCCESS : BUF_FAILURE);
                    cb(success);
                  }
                });
                return;
              }
            break;
          }
        }
      }
      stream.on('data', onData);
    }
  };
};
