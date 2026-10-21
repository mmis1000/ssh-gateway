import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import { pipeline, Writable } from "stream";
import zlib from "zlib";
import { decodeBody, Inspector, normalizeHeaders } from "../src/inspector";
import { InspectorEntry, Packet } from "../src/interface";
import { WsManager } from "../src/ws_manager";
import { close, listen, request } from "./helpers";

const USER = "user1";
const BODY_LIMIT = 1024;

describe("decodeBody", () => {
    const text = Buffer.from("hello ".repeat(100));

    it.each([
        ["gzip", zlib.gzipSync(text)],
        ["x-gzip", zlib.gzipSync(text)],
        ["deflate", zlib.deflateSync(text)],
        ["deflate", zlib.deflateRawSync(text)],
        ["br", zlib.brotliCompressSync(text)],
        ["GZip ", zlib.gzipSync(text)],
    ])("decodes %s", (encoding, data) => {
        const result = decodeBody(data, encoding);
        expect(result.decoded).toBe(true);
        expect(result.data.toString()).toBe(text.toString());
    });

    it("decodes the start of a truncated gzip body", () => {
        const random = Buffer.from(Array.from({ length: 20000 }, (_, i) => String(i)).join(","));
        const gz = zlib.gzipSync(random);
        const result = decodeBody(gz.subarray(0, gz.length / 2), "gzip");
        expect(result.decoded).toBe(true);
        expect(result.data.length).toBeGreaterThan(0);
        expect(random.toString().startsWith(result.data.toString())).toBe(true);
    });

    it("keeps unsupported or broken encodings as is", () => {
        expect(decodeBody(Buffer.from("abc"), "zstd")).toMatchObject({ decoded: false, encoding: "zstd" });
        expect(decodeBody(Buffer.from("not gzip"), "gzip")).toMatchObject({ decoded: false, encoding: "gzip" });
        expect(decodeBody(Buffer.from("abc"), "gzip, br")).toMatchObject({ decoded: false });
    });

    it("passes through bodies without encoding", () => {
        expect(decodeBody(text, undefined)).toMatchObject({ decoded: true, encoding: null });
        expect(decodeBody(text, "identity")).toMatchObject({ decoded: true, encoding: "identity" });
    });
});

describe("normalizeHeaders", () => {
    it("lowercases object keys", () => {
        expect(normalizeHeaders({ "Content-Type": "text/plain", "X-N": 1 })).toEqual({ "content-type": "text/plain", "x-n": 1 });
    });

    it("accepts raw header arrays", () => {
        expect(normalizeHeaders(["Content-Type", "text/plain", "X-A", "1"])).toEqual({ "content-type": "text/plain", "x-a": "1" });
        expect(normalizeHeaders([["Content-Type", "text/plain"]])).toEqual({ "content-type": "text/plain" });
    });

    it("ignores anything else", () => {
        expect(normalizeHeaders(undefined)).toEqual({});
    });
});

describe("Inspector", () => {
    let server: http.Server;
    let port: number;
    let inspector: Inspector;
    let broadcasts: Packet[];
    /** set per test, receives the request after tracking started */
    let handler: (req: http.IncomingMessage, res: http.ServerResponse, tap: () => NodeJS.ReadWriteStream) => void;

    beforeAll(async () => {
        const wsManager = new WsManager<Packet>();
        wsManager.broadcast = (_room, packet) => {
            broadcasts.push(structuredClone(packet));
        };
        server = http.createServer((req, res) => {
            const tracker = inspector.track(USER, req, res, { remoteAddress: "1.2.3.4" });
            handler(req, res, tracker.requestTap);
        });
        port = await listen(server);
        inspector = new Inspector(wsManager, () => port, BODY_LIMIT, 5);
    });

    afterEach(() => {
        broadcasts = [];
    });

    afterAll(() => close(server));

    broadcasts = [];

    const entryUpdates = (id: number) =>
        broadcasts.flatMap((packet) => (packet.type === "entry" && packet.entry.id === id ? [packet.entry] : []));

    const lastEntry = () => {
        const history = inspector.getHistory(USER);
        return history[history.length - 1];
    };

    /** wait for the server side "finish" handler, which runs after the client got the response */
    const settled = async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return lastEntry();
    };

    it("records request and response with writeHead headers", async () => {
        handler = (_req, res) => {
            res.writeHead(201, { "Content-Type": "application/json", "X-Custom": "1" });
            res.write('{"a":');
            res.end("1}");
        };
        await request(port, "example.test", "/path?x=1", { method: "PUT", headers: { "X-Req": "yes" } });
        const entry = await settled();

        expect(entry).toMatchObject<Partial<InspectorEntry>>({
            state: "complete",
            method: "PUT",
            path: "/path?x=1",
            remoteAddress: "1.2.3.4",
            status: 201,
            replayOf: null,
        });
        expect(entry.requestHeaders["x-req"]).toBe("yes");
        expect(entry.responseHeaders).toMatchObject({ "content-type": "application/json", "x-custom": "1" });
        expect(entry.responseBody).toMatchObject({ size: 7, truncated: false, decoded: true, encoding: null });
        expect(Buffer.from(entry.responseBody!.data, "base64").toString()).toBe('{"a":1}');
        expect(entry.duration).toBeGreaterThanOrEqual(0);
        expect(entry.requestBody).toBeNull();

        const updates = entryUpdates(entry.id);
        expect(updates.map((update) => update.state)).toEqual(["pending", "complete"]);
        expect(updates[0].status).toBeNull();
    });

    it("records headers set with setHeader and implicit writeHead", async () => {
        handler = (_req, res) => {
            res.statusCode = 404;
            res.setHeader("Content-Type", "text/plain");
            res.end("not found");
        };
        await request(port, "example.test", "/missing");
        const entry = await settled();
        expect(entry.status).toBe(404);
        expect(entry.responseHeaders?.["content-type"]).toBe("text/plain");
    });

    it("captures request bodies through the tap", async () => {
        handler = (req, res, tap) => {
            const chunks: Buffer[] = [];
            pipeline(req, tap(), new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(chunk);
                    callback();
                },
            }), () => res.end(`got ${Buffer.concat(chunks).length}`));
        };
        const body = "x".repeat(3000);
        const res = await request(port, "example.test", "/upload", { method: "POST", body });
        expect(res.body).toBe("got 3000");

        const entry = await settled();
        expect(entry.requestBody).toMatchObject({ size: 3000, truncated: true });
        expect(Buffer.from(entry.requestBody!.data, "base64").length).toBe(BODY_LIMIT);
    });

    it("truncates large responses and decodes gzip", async () => {
        const text = "line of text\n".repeat(500);
        const gz = zlib.gzipSync(text);
        handler = (_req, res) => {
            res.writeHead(200, { "Content-Encoding": "gzip", "Content-Type": "text/plain" });
            res.end(gz);
        };
        await request(port, "example.test", "/big");
        const entry = await settled();
        expect(entry.responseBody).toMatchObject({ size: gz.length, decoded: true, encoding: "gzip", truncated: true });
        const shown = Buffer.from(entry.responseBody!.data, "base64").toString();
        expect(shown.length).toBe(BODY_LIMIT);
        expect(text.startsWith(shown)).toBe(true);
    });

    it("marks requests aborted when the connection closes before the response ends", async () => {
        let aborted!: () => void;
        const done = new Promise<void>((resolve) => (aborted = resolve));
        handler = (_req, res) => {
            res.writeHead(200);
            res.write("partial");
            res.on("close", () => setTimeout(aborted, 10));
        };
        const req = http.request({ host: "127.0.0.1", port, path: "/stream" }, (res) => {
            res.once("data", () => req.destroy());
        });
        req.on("error", () => {});
        req.end();
        await done;

        const entry = lastEntry();
        expect(entry.state).toBe("aborted");
        expect(entry.status).toBe(200);
        expect(Buffer.from(entry.responseBody!.data, "base64").toString()).toBe("partial");
    });

    it("keeps a limited history with increasing ids", async () => {
        handler = (_req, res) => res.end("ok");
        for (let i = 0; i < 7; i++) {
            await request(port, "example.test", `/n/${i}`);
        }
        await settled();
        const history = inspector.getHistory(USER);
        expect(history).toHaveLength(5);
        expect(history.map((entry) => entry.path)).toEqual(["/n/2", "/n/3", "/n/4", "/n/5", "/n/6"]);
        const ids = history.map((entry) => entry.id);
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
        expect(inspector.getHistory("someone-else")).toEqual([]);
    });

    describe("replay", () => {
        let received: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[];

        beforeAll(() => {
            handler = (req, res, tap) => {
                const chunks: Buffer[] = [];
                pipeline(req, tap(), new Writable({
                    write(chunk, _encoding, callback) {
                        chunks.push(chunk);
                        callback();
                    },
                }), () => {
                    received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
                    res.end("ok");
                });
            };
        });

        afterEach(() => {
            received = [];
        });
        received = [];

        it("sends the request again and links the new entry", async () => {
            await request(port, "app.example.test", "/api?q=1", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Token": "abc" },
                body: '{"hello":"world"}',
            });
            const original = await settled();

            await inspector.replay(USER, original.id);
            const replayed = await settled();

            expect(received).toHaveLength(2);
            expect(received[1]).toMatchObject({ method: "POST", url: "/api?q=1", body: '{"hello":"world"}' });
            expect(received[1].headers).toMatchObject({ host: "app.example.test", "x-token": "abc", "content-type": "application/json" });
            // the internal marker never reaches the target
            expect(received[1].headers["x-gateway-replay"]).toBeUndefined();

            expect(replayed.id).not.toBe(original.id);
            expect(replayed.replayOf).toBe(original.id);
            expect(replayed.requestHeaders["x-gateway-replay"]).toBeUndefined();
        });

        it("ignores replay markers sent by clients", async () => {
            await request(port, "example.test", "/forged", { headers: { "X-Gateway-Replay": "guess:1" } });
            const entry = await settled();
            expect(entry.replayOf).toBeNull();
            expect(received[0].headers["x-gateway-replay"]).toBeUndefined();
        });

        it("refuses requests whose body was truncated", async () => {
            await request(port, "example.test", "/upload", { method: "POST", body: "x".repeat(BODY_LIMIT + 1) });
            const entry = await settled();
            await expect(inspector.replay(USER, entry.id)).rejects.toThrow(/not fully captured/);
        });

        it("refuses unknown entries", async () => {
            await expect(inspector.replay(USER, 99999)).rejects.toThrow(/no longer in history/);
        });
    });
});
