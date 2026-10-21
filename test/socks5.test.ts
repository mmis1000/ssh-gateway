import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import net from "net";
import path from "path";
import { AddressTypeError, parseGreeting, parseRequest, parseUserPass } from "../src/socks5";
import { createSocksServer } from "../src/socks5_server";
import { UserStore } from "../src/store";
import { User } from "../src/user";
import { createConfig, createTempDir, openTestStore } from "./helpers";

const greeting = Buffer.from([5, 1, 2]);
const auth = (user: string, pass: string) =>
    Buffer.concat([Buffer.from([1, Buffer.byteLength(user)]), Buffer.from(user), Buffer.from([Buffer.byteLength(pass)]), Buffer.from(pass)]);
const connectRequest = (port: number, host = "localhost") =>
    Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([port >> 8, port & 0xff])]);

describe("socks5 parsers", () => {
    /** every proper prefix of a message must ask for more bytes */
    const expectIncompleteUntilLast = (parse: (buf: Buffer) => unknown, message: Buffer) => {
        for (let i = 0; i < message.length; i++) expect(parse(message.subarray(0, i))).toBeNull();
    };

    it("parses greetings", () => {
        expect(parseGreeting(Buffer.from([5, 2, 0, 2, 0xaa]))).toEqual({ value: [0, 2], length: 4 });
        expectIncompleteUntilLast(parseGreeting, Buffer.from([5, 2, 0, 2]));
        expect(parseGreeting(Buffer.from([4, 1, 0]))).toBeInstanceOf(Error);
        expect(parseGreeting(Buffer.from([5, 0]))).toBeInstanceOf(Error);
    });

    it("parses username and password", () => {
        const message = auth("alice", "pässwörd");
        expect(parseUserPass(Buffer.concat([message, Buffer.from("rest")]))).toEqual({
            value: { username: "alice", password: "pässwörd" },
            length: message.length,
        });
        expectIncompleteUntilLast(parseUserPass, message);
        expect(parseUserPass(Buffer.from([2, 1, 0x61, 1, 0x62]))).toBeInstanceOf(Error);
        expect(parseUserPass(Buffer.from([1, 0]))).toBeInstanceOf(Error);
        expect(parseUserPass(Buffer.from([1, 1, 0x61, 0]))).toBeInstanceOf(Error);
    });

    it("parses connect requests for every address type", () => {
        const domain = connectRequest(8080, "example.com");
        expect(parseRequest(domain)).toEqual({ value: { command: 1, host: "example.com", port: 8080 }, length: domain.length });
        expectIncompleteUntilLast(parseRequest, domain);

        const ipv4 = Buffer.from([5, 1, 0, 1, 10, 0, 0, 7, 0x1f, 0x90]);
        expect(parseRequest(ipv4)).toEqual({ value: { command: 1, host: "10.0.0.7", port: 8080 }, length: 10 });
        expectIncompleteUntilLast(parseRequest, ipv4);

        const ipv6 = Buffer.concat([Buffer.from([5, 1, 0, 4]), Buffer.from("20010db8000000000000000000000001", "hex"), Buffer.from([0, 80])]);
        expect(parseRequest(ipv6)).toEqual({ value: { command: 1, host: "2001:db8:0:0:0:0:0:1", port: 80 }, length: 22 });

        expect(parseRequest(Buffer.from([5, 1, 0, 9, 0, 0]))).toBeInstanceOf(AddressTypeError);
        expect(parseRequest(Buffer.from([4, 1, 0, 1, 0, 0, 0, 0, 0, 0]))).toBeInstanceOf(Error);
    });
});

describe("socks5 server", () => {
    let store: UserStore;
    let user: User;
    let cleanup: () => Promise<void>;
    let server: net.Server;
    let port: number;
    let echo: net.Server;
    let echoPort: number;
    /** channels handed out by the fake ssh client */
    let channels: net.Socket[];

    const echoConnections = () => new Promise<number>((resolve) => echo.getConnections((_, count) => resolve(count)));

    beforeAll(async () => {
        const temp = await createTempDir();
        cleanup = temp.cleanup;
        const saveDir = path.join(temp.dir, "save");
        store = await openTestStore(saveDir);
        user = await store.create();

        echo = net.createServer((socket) => socket.pipe(socket));
        echoPort = await new Promise((resolve) => echo.listen(0, "127.0.0.1", () => resolve((echo.address() as net.AddressInfo).port)));

        // stand in for the ssh connection to the client: forwardOut gives a tcp connection to the echo server
        channels = [];
        user.getClient = (() => Promise.resolve({
            forwardOut(_srcHost: string, _srcPort: number, _dstHost: string, dstPort: number, cb: (err: Error | undefined, channel?: net.Socket) => void) {
                if (dstPort !== echoPort) return cb(new Error("connection refused"));
                const channel = net.connect(echoPort, "127.0.0.1", () => cb(undefined, channel));
                channels.push(channel);
            },
        })) as any;

        server = createSocksServer(createConfig(saveDir), store, { handshakeTimeout: 300 });
        port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => echo.close(resolve));
        await cleanup();
    });

    afterEach(() => {
        channels.forEach((channel) => channel.destroy());
        channels.length = 0;
    });

    /**
     * send `writes` one after another, resolve with everything received once the server closed
     * the connection or `waitMs` passed
     */
    const exchange = (writes: Buffer[], waitMs = 200, waitForClose = false) =>
        new Promise<{ data: Buffer; closed: boolean }>((resolve) => {
            const socket = net.connect(port, "127.0.0.1");
            let data = Buffer.alloc(0);
            let closed = false;
            const finish = () => {
                resolve({ data, closed });
                socket.destroy();
            };
            socket.on("data", (chunk) => (data = Buffer.concat([data, chunk])));
            socket.on("error", () => {});
            socket.on("close", () => {
                closed = true;
                if (waitForClose) finish();
            });
            socket.on("connect", async () => {
                for (const write of writes) {
                    socket.write(write);
                    await new Promise((r) => setTimeout(r, 1));
                }
                setTimeout(finish, waitMs);
            });
        });
    /** for exchanges the server is expected to end */
    const refused = (writes: Buffer[]) => exchange(writes, 3000, true);

    const handshakeReplies = Buffer.from([5, 2, 1, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

    it("tunnels a connection", async () => {
        const { data } = await exchange([greeting, auth(user.id!, user.password!), connectRequest(echoPort), Buffer.from("ping")]);
        expect(data).toEqual(Buffer.concat([handshakeReplies, Buffer.from("ping")]));
    });

    it("handles everything arriving one byte at a time", async () => {
        const all = Buffer.concat([greeting, auth(user.id!, user.password!), connectRequest(echoPort), Buffer.from("ping")]);
        const { data } = await exchange([...all].map((byte) => Buffer.from([byte])), 400);
        expect(data).toEqual(Buffer.concat([handshakeReplies, Buffer.from("ping")]));
    });

    it("keeps data sent together with the request", async () => {
        // optimistic clients do not wait for the reply, the bytes must survive the async channel setup
        const all = Buffer.concat([greeting, auth(user.id!, user.password!), connectRequest(echoPort), Buffer.from("early data")]);
        const { data } = await exchange([all]);
        expect(data).toEqual(Buffer.concat([handshakeReplies, Buffer.from("early data")]));
    });

    it("rejects a wrong password and unknown users", async () => {
        for (const credential of [auth(user.id!, "wrong"), auth("nobody", user.password!), auth("../etc", "x")]) {
            const { data, closed } = await refused([greeting, credential]);
            expect(data).toEqual(Buffer.from([5, 2, 1, 1]));
            expect(closed).toBe(true);
        }
    });

    it("refuses clients that do not offer username and password", async () => {
        const { data, closed } = await refused([Buffer.from([5, 1, 0])]);
        expect(data).toEqual(Buffer.from([5, 0xff]));
        expect(closed).toBe(true);
    });

    it("refuses other commands and address types", async () => {
        const bind = Buffer.from(connectRequest(echoPort));
        bind[1] = 2;
        const unsupportedCommand = await refused([greeting, auth(user.id!, user.password!), bind]);
        expect(unsupportedCommand.data.subarray(4, 6)).toEqual(Buffer.from([5, 7]));
        expect(unsupportedCommand.closed).toBe(true);

        const badAddress = await refused([greeting, auth(user.id!, user.password!), Buffer.from([5, 1, 0, 9, 0, 0])]);
        expect(badAddress.data.subarray(4, 6)).toEqual(Buffer.from([5, 8]));
    });

    it("reports ports it cannot reach", async () => {
        const { data, closed } = await refused([greeting, auth(user.id!, user.password!), connectRequest(1)]);
        expect(data.subarray(4, 6)).toEqual(Buffer.from([5, 5]));
        expect(closed).toBe(true);
    });

    it("closes clients that never finish the handshake", async () => {
        const { closed } = await refused([greeting.subarray(0, 1)]);
        expect(closed).toBe(true);
    });

    it("does not wait for a refused client to close its side", async () => {
        // a client that keeps its side open after the refusal
        const socket = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
        socket.on("error", () => {});
        await new Promise((resolve) => socket.on("connect", resolve));
        socket.write(Buffer.concat([greeting, auth(user.id!, "wrong")]));
        await new Promise((resolve) => socket.once("data", resolve));

        const serverConnections = () => new Promise<number>((resolve) => server.getConnections((_, count) => resolve(count)));
        let open = await serverConnections();
        for (let i = 0; i < 30 && open > 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            open = await serverConnections();
        }
        expect(open).toBe(0);
        socket.destroy();
    });

    it("drops garbage without crashing", async () => {
        const { data, closed } = await refused([Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n")]);
        expect(data.length).toBe(0);
        expect(closed).toBe(true);
    });

    it("closes the channel when the visitor ends or is reset", async () => {
        for (let i = 0; i < 10; i++) {
            const socket = net.connect(port, "127.0.0.1");
            socket.on("error", () => {});
            await new Promise((resolve) => socket.on("connect", resolve));
            socket.write(Buffer.concat([greeting, auth(user.id!, user.password!), connectRequest(echoPort)]));
            await new Promise((resolve) => socket.once("data", resolve));
            if (i % 2) socket.end();
            else socket.resetAndDestroy();
        }
        let open = await echoConnections();
        for (let i = 0; i < 20 && open > 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            open = await echoConnections();
        }
        expect(open).toBe(0);
    });
});
