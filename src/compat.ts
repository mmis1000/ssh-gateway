import util from "util";

// socksv5 is unmaintained and still calls util.isError, which Node 23 removed.
// Without it a failed socks login throws inside the auth callback.
if (typeof (util as any).isError !== 'function') {
    (util as any).isError = (value: unknown) => value instanceof Error
}
