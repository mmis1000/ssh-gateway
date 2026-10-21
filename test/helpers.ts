import http from "http";
import os from "os";
import path from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { utils } from "ssh2";
import { openStore } from "../src/migrate";
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

export interface V1User {
    id: string;
    domain: string;
    password: string;
    /** private key the client logs in with (v1 private_key) */
    clientKey: string;
    clientKeyPub: string;
    /** key the gateway uses for the client sshd (v1 public_key) */
    gatewayKey: string;
    gatewayKeyPub: string;
}

/** write a storage version 1 layout like the old createUser and README setup produced */
export async function writeV1Fixture(saveDir: string, legacyHostKeyDir: string, ids: string[] = ["abc123def4", "zz9y8x7w6v"]) {
    const ecdsa = () => utils.generateKeyPairSync("ecdsa", { bits: 256, comment: "user@host" });
    await mkdir(path.join(saveDir, "domains"), { recursive: true });
    const users: V1User[] = [];
    for (const [index, id] of ids.entries()) {
        const client = ecdsa();
        const gateway = ecdsa();
        const user: V1User = {
            id,
            domain: `brave-otter-${index + 10}`,
            password: `pw${index}secret`,
            clientKey: client.private,
            clientKeyPub: client.public + "\n",
            gatewayKey: gateway.private,
            gatewayKeyPub: gateway.public + "\n",
        };
        const dir = path.join(saveDir, id);
        await mkdir(dir);
        await writeFile(path.join(dir, "info.json"), JSON.stringify({ id, domain: user.domain, password: user.password }));
        await writeFile(path.join(dir, "private_key"), user.clientKey, { mode: 0o600 });
        await writeFile(path.join(dir, "private_key.pub"), user.clientKeyPub);
        await writeFile(path.join(dir, "public_key"), user.gatewayKey, { mode: 0o600 });
        await writeFile(path.join(dir, "public_key.pub"), user.gatewayKeyPub);
        await writeFile(path.join(saveDir, "domains", user.domain), id);
        users.push(user);
    }

    await mkdir(legacyHostKeyDir, { recursive: true });
    const hostKeys: Record<string, { private: string; public: string }> = {};
    for (const [type, opts] of [["rsa", { bits: 2048 }], ["ecdsa", { bits: 256 }], ["ed25519", {}]] as const) {
        const pair = utils.generateKeyPairSync(type as any, opts as any);
        await writeFile(path.join(legacyHostKeyDir, `ssh_host_${type}_key`), pair.private, { mode: 0o600 });
        await writeFile(path.join(legacyHostKeyDir, `ssh_host_${type}_key.pub`), pair.public + "\n");
        hostKeys[type] = pair;
    }
    return { users, hostKeys };
}

/** open a store that has no legacy data to migrate */
export function openTestStore(saveDir: string) {
    return openStore(saveDir, path.join(saveDir, "..", "no-legacy-host-keys"), () => {});
}
