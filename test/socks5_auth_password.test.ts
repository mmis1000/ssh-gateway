import { describe, expect, it } from "vitest";
import { PassThrough } from "stream";
import socksPasswordAuth from "../src/socks5_auth_password";

const authRequest = (user: string, pass: string) =>
    Buffer.concat([Buffer.from([1, Buffer.byteLength(user)]), Buffer.from(user), Buffer.from([Buffer.byteLength(pass)]), Buffer.from(pass)]);

/** a stream that records what the handler writes back */
function fakeStream() {
    const stream = new PassThrough();
    const written: Buffer[] = [];
    stream.write = ((chunk: Buffer) => {
        written.push(chunk);
        return true;
    }) as typeof stream.write;
    return { stream, written };
}

/** feed `chunks` to the server handler, resolve with what the auth callback saw */
function authenticate(chunks: Buffer[]) {
    const { stream, written } = fakeStream();
    return new Promise<{ result: boolean | Error; seen?: [string, string]; written: Buffer[] }>((resolve) => {
        let seen: [string, string] | undefined;
        const handler = socksPasswordAuth((_stream, user, pass, cb) => {
            seen = [user, pass];
            cb(user === "alice" && pass === "secret");
        });
        handler.server(stream, (result) => resolve({ result, seen, written }));
        for (const chunk of chunks) stream.emit("data", chunk);
    });
}

describe("socks5 password auth", () => {
    it("accepts the right credential", async () => {
        const { result, seen, written } = await authenticate([authRequest("alice", "secret")]);
        expect(seen).toEqual(["alice", "secret"]);
        expect(result).toBe(true);
        expect(written).toEqual([Buffer.from([1, 0])]);
    });

    it("rejects a wrong credential", async () => {
        const { result, written } = await authenticate([authRequest("alice", "nope")]);
        expect(result).toBe(false);
        expect(written).toEqual([Buffer.from([1, 1])]);
    });

    it("handles a request split into single bytes", async () => {
        const { seen, result } = await authenticate([...authRequest("alice", "secret")].map((byte) => Buffer.from([byte])));
        expect(seen).toEqual(["alice", "secret"]);
        expect(result).toBe(true);
    });

    it("keeps concurrent logins apart", () => {
        // the parser state used to be shared between connections
        const a = authRequest("alice", "secret");
        const b = authRequest("bob", "hunter2");
        const streams = [fakeStream().stream, fakeStream().stream];
        const seen: string[][] = [[], []];
        const handler = socksPasswordAuth<PassThrough>((stream, user, pass, cb) => {
            seen[streams.indexOf(stream)] = [user, pass];
            cb(true);
        });
        streams.forEach((stream) => handler.server(stream, () => {}));
        // interleave: both usernames first, then both passwords
        streams[0].emit("data", a.subarray(0, 7));
        streams[1].emit("data", b.subarray(0, 5));
        streams[0].emit("data", a.subarray(7));
        streams[1].emit("data", b.subarray(5));
        expect(seen).toEqual([["alice", "secret"], ["bob", "hunter2"]]);
    });

    it.each([
        ["an unknown version", Buffer.from([5, 1, 0x61])],
        ["an empty username", Buffer.from([1, 0])],
        ["an empty password", Buffer.from([1, 1, 0x61, 0])],
    ])("fails cleanly on %s", async (_, request) => {
        const { result, seen } = await authenticate([request]);
        expect(result).toBeInstanceOf(Error);
        expect(seen).toBeUndefined();
    });
});
