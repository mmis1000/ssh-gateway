import http from "http";
import os from "os";
import path from "path";
import { mkdtemp, rm } from "fs/promises";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { ClientPacket, Config, InspectorEntry, Packet } from "../src/interface";

export const SETUP_HOST = "gateway.test";
export const HTTP_HOST = "ugc.test";

export async function createTempDir() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ssh-gateway-test-"));
    return {
        dir,
        cleanup: () => rm(dir, { recursive: true, force: true }),
    };
}

export function createConfig(saveDir: string, overrides: Partial<Config> = {}): Config {
    return {
        httpListen: 0,
        setupProtocol: "http",
        setupHost: SETUP_HOST,
        setupPort: 80,
        sshHost: SETUP_HOST,
        sshPort: 2222,
        sshListen: 2222,
        httpProtocol: "http",
        httpHost: HTTP_HOST,
        httpPort: 80,
        socksHost: SETUP_HOST,
        socksPort: 1080,
        socksListen: 1080,
        userListenPortLow: 30020,
        userListenPortHigh: 30099,
        trustedProxy: "localhost",
        saveDir,
        setupRequireAuth: true,
        setupAccount: "admin",
        setupPassword: "secret",
        ...overrides,
    };
}

export function listen(server: http.Server) {
    return new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
}

export function close(server: http.Server) {
    return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    });
}

export interface Response {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}

/** fetch() does not allow overriding Host, so use http.request directly */
export function request(
    port: number,
    host: string,
    urlPath: string,
    options: { method?: string; auth?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {}
) {
    return new Promise<Response>((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                path: urlPath,
                method: options.method ?? "GET",
                auth: options.auth,
                headers: { ...options.headers, Host: host },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode!,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString("utf8"),
                    })
                );
                res.on("error", reject);
            }
        );
        req.on("error", reject);
        req.end(options.body);
    });
}

/** an inspector websocket client, collects every packet it receives */
export async function openInspector(port: number, username: string, password: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__observe_requests`, { headers: { Host: SETUP_HOST } });
    const packets: Packet[] = [];
    const waiters: (() => void)[] = [];
    ws.on("message", (data) => {
        packets.push(JSON.parse(data.toString()));
        waiters.splice(0).forEach((wake) => wake());
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
    });
    ws.send(JSON.stringify([username, password]));

    /** resolves with the first packet (already received or future) matching the predicate */
    const waitFor = <T extends Packet>(predicate: (packet: Packet) => packet is T, timeoutMs = 10000) =>
        new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for packet")), timeoutMs);
            const check = () => {
                const found = packets.find(predicate);
                if (found) {
                    clearTimeout(timer);
                    resolve(found);
                } else {
                    waiters.push(check);
                }
            };
            check();
        });

    return { ws, packets, closed, waitFor, send: (packet: ClientPacket) => ws.send(JSON.stringify(packet)) };
}

export const isEntry = (predicate: (entry: InspectorEntry) => boolean) =>
    (packet: Packet): packet is Extract<Packet, { type: "entry" }> => packet.type === "entry" && predicate(packet.entry);
