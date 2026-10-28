import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { ChildProcess, execFile, spawn } from "child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "fs/promises";
import { readdirSync } from "fs";
import { BaseAgent, Client, ParsedKey, utils } from "ssh2";
import WebSocket, { WebSocketServer } from "ws";
import { createHttpServer } from "../src/http_server";
import { CLIENT_SCRIPT_VERSION, createSshServer, SshServerOptions } from "../src/ssh_server";
import { createSocksServer } from "../src/socks5_server";
import { Protocol, User } from "../src/user";
import { knownHostsLines, loadHostKeys } from "../src/keys";
import { openStore } from "../src/migrate";
import { UserStore } from "../src/store";
import { clientSshdConfig, close, createConfig, createTempDir, HTTP_HOST, SETUP_HOST, isEntry, listen, openInspector, request, socks5Connect, V1User, writeV1Fixture } from "./helpers";

// Drives the gateway with the real OpenSSH client the same way run.sh (template/client) does:
// a ControlMaster connection, a "v1: register" exec and a "-O forward -R 22:localhost:<port>" reverse tunnel.

const SSHD_PATH = "/usr/sbin/sshd";
const LOCAL_USER = os.userInfo().username;

interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

function run(file: string, args: string[], input?: string) {
    return new Promise<ExecResult>((resolve) => {
        const child = execFile(file, args, { timeout: 15000 }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
            resolve({ code, stdout, stderr });
        });
        if (input !== undefined) child.stdin!.end(input);
    });
}

function keygen(file: string, type = "ed25519") {
    return run("ssh-keygen", ["-q", "-N", "", "-t", type, "-f", file]);
}

function freePort() {
    return new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
        server.on("error", reject);
    });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < end) {
        try {
            const result = await fn();
            if (result !== undefined) return result;
        } catch (err) {
            lastError = err;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting: ${lastError}`);
}

interface Gateway {
    saveDir: string;
    store: UserStore;
    /** users and host keys from the storage version 1 data the gateway was started from */
    v1Users: V1User[];
    v1HostKeys: Record<string, { private: string; public: string }>;
    sshPort: number;
    httpPort: number;
    socksPort: number;
    /** open ssh connections on the gateway side */
    sshConnections(): Promise<number>;
    stop(): Promise<void>;
}

async function startGateway(sshOptions: SshServerOptions = {}): Promise<Gateway> {
    const { dir, cleanup } = await createTempDir();
    const saveDir = path.join(dir, "save");
    const legacyDir = path.join(dir, "project");
    const { users: v1Users, hostKeys: v1HostKeys } = await writeV1Fixture(saveDir, legacyDir);

    // start like server.ts does: migrate, then load host keys
    const store = await openStore(saveDir, legacyDir, () => {});
    const hostKeys = await loadHostKeys(store.hostKeyDir, () => {});

    const config = createConfig(saveDir);
    const sshServer = createSshServer(config, store, hostKeys, sshOptions);
    const sshPort = await new Promise<number>((resolve) => {
        sshServer.listen(0, "127.0.0.1", () => resolve((sshServer.address() as net.AddressInfo).port));
    });
    const { server: httpServer } = await createHttpServer(config, store);
    const httpPort = await listen(httpServer);
    const socksServer = createSocksServer(config, store);
    await new Promise<void>((resolve) => socksServer.listen(0, "127.0.0.1", resolve));
    const socksPort = (socksServer.address() as net.AddressInfo).port;

    return {
        saveDir,
        store,
        v1Users,
        v1HostKeys,
        sshPort,
        httpPort,
        socksPort,
        sshConnections: () => new Promise<number>((resolve) => sshServer.getConnections((_err: unknown, count: number) => resolve(count))),
        async stop() {
            await close(httpServer);
            await new Promise<void>((resolve) => socksServer.close(() => resolve()));
            await new Promise((resolve) => sshServer.close(resolve));
            await cleanup();
        },
    };
}

/** an OpenSSH client session for one gateway user, mirrors what run.sh does */
class ClientSession {
    master: ChildProcess | null = null;

    private constructor(
        public gateway: Gateway,
        public user: User,
        public workDir: string,
        public identity: string
    ) {}

    static async create(gateway: Gateway, user: User, identity?: string) {
        const workDir = path.join(gateway.saveDir, "..", `client-${user.id}`);
        await mkdir(workDir, { recursive: true });
        if (!identity) {
            identity = path.join(workDir, "id_rsa");
            await writeFile(identity, user.clientKey!);
            await chmod(identity, 0o600);
        }
        return new ClientSession(gateway, user, workDir, identity);
    }

    /** run.sh uses one control socket, a second session stands for a respawned client */
    controlName = "control.sock";
    /** connect through something else than the gateway port, like a relay */
    port: number | null = null;

    get controlSock() {
        return path.join(this.workDir, this.controlName);
    }

    args(extra: string[] = []) {
        return [
            "-F", "/dev/null",
            "-i", this.identity,
            "-p", String(this.port ?? this.gateway.sshPort),
            "-o", "IdentitiesOnly yes",
            "-o", "BatchMode yes",
            "-o", "StrictHostKeyChecking no",
            "-o", "UserKnownHostsFile /dev/null",
            "-o", "LogLevel ERROR",
            "-S", this.controlSock,
            ...extra,
            `${this.user.id}@127.0.0.1`,
        ];
    }

    exec(command: string, input?: string) {
        return run("ssh", [...this.args(), command], input);
    }

    async connect() {
        this.master = spawn("ssh", this.args(["-N", "-M", "-o", "ControlPersist no", "-o", "ClearAllForwardings yes"]), {
            stdio: "ignore",
        });
        await waitFor(async () => ((await run("ssh", this.args(["-O", "check"]))).code === 0 ? true : undefined));
    }

    /** auth is sent on stdin like run.sh --auth does */
    register(port: number, staticDirectory?: string, auth?: string, flags: string[] = []) {
        const args = [`v${CLIENT_SCRIPT_VERSION}:`, "register", LOCAL_USER, String(port), staticDirectory ?? "null", ...flags];
        if (auth !== undefined) args.push("--auth");
        return this.exec(args.map((arg) => `'${arg}'`).join(" "), auth === undefined ? undefined : `${auth}\n`);
    }

    forward(localPort: number) {
        return run("ssh", this.args(["-O", "forward", "-R", `22:localhost:${localPort}`]));
    }

    async disconnect() {
        await run("ssh", this.args(["-O", "exit"]));
        this.master?.kill();
        this.master = null;
    }
}

/**
 * Log in presenting the user's real public key but a signature that does not match,
 * resolves with the error level, or "authenticated" if the server accepted it.
 */
async function loginWithForgedSignature(gateway: Gateway, user: User) {
    const publicKey = utils.parseKey(user.clientKeyPub!) as ParsedKey;
    // well formed signatures that do not match the data, ecdsa ones are DER (r = 1, s = 1)
    const signature = publicKey.type === "ssh-ed25519" ? Buffer.alloc(64, 1) : Buffer.from("3006020101020101", "hex");
    class ForgingAgent extends BaseAgent {
        getIdentities(cb: (err: Error | undefined, keys?: ParsedKey[]) => void) {
            cb(undefined, [publicKey]);
        }
        sign(_key: ParsedKey, _data: Buffer, ...args: any[]) {
            args[args.length - 1](undefined, signature);
        }
    }

    const client = new Client();
    const result = await new Promise<string>((resolve) => {
        client.on("ready", () => resolve("authenticated"));
        client.on("error", (err: Error & { level?: string }) => resolve(err.level ?? err.message));
        client.connect({
            host: "127.0.0.1",
            port: gateway.sshPort,
            username: user.id!,
            agent: new ForgingAgent(),
            readyTimeout: 10000,
        });
    });
    client.end();
    return result;
}

describe("ssh server", () => {
    let gateway: Gateway;

    beforeAll(async () => {
        gateway = await startGateway();
    });

    afterAll(() => gateway.stop());

    describe("data migrated from storage version 1", () => {
        it("serves the same host keys as before the migration", async () => {
            const res = await run("ssh-keyscan", ["-p", String(gateway.sshPort), "-t", "rsa,ecdsa,ed25519", "127.0.0.1"]);
            const served = res.stdout.trim().split("\n").map((line) => line.split(" ").slice(1, 3).join(" ")).sort();
            const before = Object.values(gateway.v1HostKeys).map((pair) => pair.public.split(" ").slice(0, 2).join(" ")).sort();
            expect(served).toHaveLength(3);
            expect(served).toEqual(before);
        });

        it("lets a migrated user log in with the original key", async () => {
            const original = gateway.v1Users[0];
            const user = gateway.store.getById(original.id)!;
            expect(user.clientKey).toBe(original.clientKey);

            const session = await ClientSession.create(gateway, user);
            const res = await session.register(8080);
            expect(res.stdout).toContain("Client accepted.");
            expect(res.stdout).toContain(`http://${original.domain}.${HTTP_HOST}:80/`);
        });

        it("rejects a forged signature for a migrated ecdsa key", async () => {
            const user = gateway.store.getById(gateway.v1Users[1].id)!;
            expect(user.clientKeyPub).toMatch(/^ecdsa-sha2-nistp256 /);
            expect(await loginWithForgedSignature(gateway, user)).toBe("client-authentication");
        });
    });

    describe("authentication", () => {
        let user: User;

        beforeAll(async () => {
            user = await gateway.store.create();
        });

        it("accepts the generated client key", async () => {
            const session = await ClientSession.create(gateway, user);
            const res = await session.exec("register");
            expect(res.stderr).not.toContain("Permission denied");
            expect(res.stderr).toContain("bad register command");
        });

        it("rejects a different key", async () => {
            const session = await ClientSession.create(gateway, user);
            const otherKey = path.join(session.workDir, "other_key");
            await keygen(otherKey, "ecdsa");
            const res = await run("ssh", [...(await ClientSession.create(gateway, user, otherKey)).args(), "true"]);
            expect(res.code).toBe(255);
            expect(res.stderr).toContain("Permission denied");
        });

        it("rejects a valid public key with a forged signature", async () => {
            expect(await loginWithForgedSignature(gateway, user)).toBe("client-authentication");
        });

        it("is only trusted with the host keys handed out in the script", async () => {
            const session = await ClientSession.create(gateway, user);
            const strict = (knownHosts: string) => run("ssh", [
                "-F", "/dev/null", "-i", session.identity, "-p", String(gateway.sshPort),
                "-o", "IdentitiesOnly yes", "-o", "BatchMode yes", "-o", "LogLevel ERROR",
                "-o", "StrictHostKeyChecking yes", "-o", `UserKnownHostsFile ${knownHosts}`,
                `${user.id}@127.0.0.1`, "true",
            ]);

            const pinned = path.join(session.workDir, "known_hosts");
            await writeFile(pinned, (await knownHostsLines(gateway.store.hostKeyDir, "127.0.0.1", gateway.sshPort)).join("\n") + "\n");
            const trusted = await strict(pinned);
            expect(trusted.stderr).not.toContain("Host key verification failed");
            expect(trusted.stderr).toContain("bad register command");

            // someone else answering on the gateway address
            const impostor = path.join(session.workDir, "known_hosts_other");
            const other = utils.generateKeyPairSync("ed25519");
            await writeFile(impostor, `[127.0.0.1]:${gateway.sshPort} ${other.public}\n`);
            const refused = await strict(impostor);
            expect(refused.code).toBe(255);
            expect(refused.stderr).toContain("Host key verification failed");
        });

        it("rejects unknown users", async () => {
            const session = await ClientSession.create(gateway, user);
            const args = session.args();
            args[args.length - 1] = "no-such-user@127.0.0.1";
            const res = await run("ssh", [...args, "true"]);
            expect(res.code).toBe(255);
            expect(res.stderr).toContain("Permission denied");
        });
    });

    describe("update command", () => {
        let user: User;
        let session: ClientSession;

        beforeAll(async () => {
            user = await gateway.store.create();
            session = await ClientSession.create(gateway, user);
        });

        it("sends the same script as the /update page", async () => {
            const res = await session.exec(`'v${CLIENT_SCRIPT_VERSION}:' update`);
            expect(res.code).toBe(0);
            expect(res.stderr).toBe("");
            const page = await request(gateway.httpPort, SETUP_HOST, "/update", {
                headers: { Authorization: `Basic ${Buffer.from(`${user.id}:${user.password}`).toString("base64")}` },
            });
            expect(page.status).toBe(200);
            expect(res.stdout).toBe(page.body);
            expect(res.stdout).toContain(`export TARGET_USER="${user.id}"`);
        });

        it("leaves the protocol of a registered tunnel alone", async () => {
            await session.exec(`register ${LOCAL_USER} 8080`);
            expect(user.protocolVersion).toBe(Protocol.V0);
            await session.exec(`'v${CLIENT_SCRIPT_VERSION}:' update`);
            await session.exec(`'v${CLIENT_SCRIPT_VERSION}:' check`);
            expect(user.protocolVersion).toBe(Protocol.V0);
            await session.register(8080);
            expect(user.protocolVersion).toBe(Protocol.V1);
        });
    });

    describe("register command", () => {
        let user: User;
        let session: ClientSession;

        beforeAll(async () => {
            user = await gateway.store.create();
            session = await ClientSession.create(gateway, user);
        });

        it("accepts a forward registration from the current script", async () => {
            const res = await session.register(8080);
            expect(res.stdout).toMatch(/^Client accepted\./);
            expect(res.stdout).not.toContain("Please update");
            expect(res.stdout).toContain(`Forward server is opened at http://${user.domainName}.${HTTP_HOST}:80/`);
            expect(res.stdout).toContain(`socks5://${user.id}:${user.socksPassword}@`);
            expect(user.socksPassword).not.toBe(user.password);
            expect(user.httpPort).toBe(8080);
            expect(user.remoteUser).toBe(LOCAL_USER);
        });

        it.each([
            ["v0 (no header)", `register ${LOCAL_USER} 8080`],
            ["v1", `v1: register ${LOCAL_USER} 8080`],
            ["v2", `v2: register ${LOCAL_USER} 8080`],
            ["v3", `v3: register ${LOCAL_USER} 8080`],
            ["v4", `v4: register ${LOCAL_USER} 8080`],
            ["v5", `v5: register ${LOCAL_USER} 8080 null`],
            ["v6", `v6: register ${LOCAL_USER} 8080 null`],
            ["v7", `v7: register ${LOCAL_USER} 8080 null`],
            ["v8", `v8: register ${LOCAL_USER} 8080 null`],
        ])("asks %s scripts to update and still accepts them", async (_, command) => {
            const res = await session.exec(command);
            expect(res.stdout).toMatch(/^Please update this script, a newer version with fixes is available:\n/);
            expect(res.stdout).toContain(`curl -u '${user.id}:${user.password}' http://gateway.test/update > run.sh`);
            expect(res.stdout).toContain("Client accepted.");
        });

        it("tells current scripts to update with --update, not with the password", async () => {
            const res = await session.register(8080);
            expect(res.stdout).toContain("To get a new version of this script later, run it with --update\n");
            expect(res.stdout).not.toContain("/update");
            expect(res.stdout).not.toContain("curl");
        });

        it("normalizes the static directory", async () => {
            const res = await session.register(0, "/srv/www/../site/");
            expect(res.stdout).toContain("Client accepted.");
            expect(user.httpPort).toBe(0);
            expect(user.staticDirectory).toBe("/srv/site");
        });

        it("takes the visitor password from stdin, and clears it on the next register", async () => {
            const res = await session.register(8080, undefined, "alice:pa ss:word");
            expect(res.stdout).toContain("Client accepted.");
            expect(res.stdout).toContain("Visitors are asked for the user name alice and the password given with --auth.");
            expect(res.stdout).not.toContain("pa ss:word");
            expect(user.publicAuth).toEqual({ account: "alice", password: "pa ss:word" });

            expect((await session.register(8080)).stdout).not.toContain("Visitors are asked");
            expect(user.publicAuth).toBeNull();
        });

        it("takes --dotfiles and clears it on the next register", async () => {
            expect(user.serveDotfiles).toBe(false);
            expect((await session.register(0, "/srv/www", undefined, ["--dotfiles", "--list"])).stdout).toContain("Client accepted.");
            expect(user.serveDotfiles).toBe(true);
            expect(user.serveIndex).toBe(false);
            expect((await session.register(0, "/srv/www")).stdout).toContain("Client accepted.");
            expect(user.serveDotfiles).toBe(false);
        });

        it("takes --list, also together with --auth, and clears it on the next register", async () => {
            expect(user.serveIndex).toBe(true);
            expect((await session.register(0, "/srv/www", undefined, ["--list"])).stdout).toContain("Client accepted.");
            expect(user.serveIndex).toBe(false);
            expect((await session.register(0, "/srv/www", "alice:secret", ["--list"])).stdout).toContain("Client accepted.");
            expect(user.serveIndex).toBe(false);
            expect(user.publicAuth).toEqual({ account: "alice", password: "secret" });
            expect((await session.register(0, "/srv/www")).stdout).toContain("Client accepted.");
            expect(user.serveIndex).toBe(true);
            expect(user.publicAuth).toBeNull();
        });

        it.each([
            ["no colon", "alice\n", "bad --auth value"],
            ["an empty user name", ":secret\n", "bad --auth value"],
            ["an empty password", "alice:\n", "bad --auth value"],
            ["a control character", "alice:se\tcret\n", "bad --auth value"],
            ["nothing", "", "bad --auth value"],
            ["a line that never ends", "a".repeat(2000), "no --auth value received, line too long"],
        ])("rejects --auth with %s", async (_, input, message) => {
            const res = await session.exec(`'v${CLIENT_SCRIPT_VERSION}:' register ${LOCAL_USER} 8080 null --auth`, input);
            expect(res.stderr).toContain(message);
            expect(res.stdout).not.toContain("Client accepted.");
        });

        it.each([
            ["missing port", `v1: register ${LOCAL_USER}`],
            ["non numeric port", `v1: register ${LOCAL_USER} http`],
            ["leading zero port", `v1: register ${LOCAL_USER} 080`],
            ["unknown command", `v1: unregister ${LOCAL_USER} 8080`],
            ["an unknown flag", `v6: register ${LOCAL_USER} 8080 null --verbose`],
            ["a repeated flag", `v6: register ${LOCAL_USER} 0 /srv --list --list`],
        ])("rejects %s", async (_, command) => {
            const res = await session.exec(command);
            expect(res.stderr).toContain("bad register command");
            expect(res.stdout).not.toContain("Client accepted.");
        });
    });

    describe("forward mode", () => {
        let user: User;
        let session: ClientSession;
        let target: http.Server;
        const targetHits: string[] = [];
        const host = () => `${user.domainName}.${HTTP_HOST}`;
        let targetPortNumber: number;
        const targetPort = () => targetPortNumber;

        beforeAll(async () => {
            target = http.createServer((req, res) => {
                const chunks: Buffer[] = [];
                req.on("data", (chunk) => chunks.push(chunk));
                if (req.url === "/slow") {
                    res.writeHead(200, { "Content-Type": "text/plain" });
                    res.write("first chunk");
                    const timer = setInterval(() => res.write("."), 50);
                    res.on("close", () => clearInterval(timer));
                    return;
                }
                req.on("end", () => {
                    targetHits.push(`${req.method} ${req.url}`);
                    const status = /^\/status\/(\d+)$/.exec(req.url!);
                    res.writeHead(status ? Number(status[1]) : 200, {
                        "Content-Type": "application/json",
                        "X-Target": "yes",
                    });
                    res.end(JSON.stringify({
                        method: req.method,
                        url: req.url,
                        headers: req.headers,
                        body: Buffer.concat(chunks).toString("utf8"),
                    }));
                });
            });
            const targetPort = targetPortNumber = await listen(target);

            user = await gateway.store.create();
            session = await ClientSession.create(gateway, user);
            await session.connect();
            expect((await session.register(targetPort)).stdout).toContain("Client accepted.");
            expect((await session.forward(targetPort)).code).toBe(0);
        });

        afterAll(async () => {
            await session.disconnect();
            await close(target);
        });

        it("proxies requests through the reverse tunnel", async () => {
            const res = await request(gateway.httpPort, host(), "/hello/world?q=1");
            expect(res.status).toBe(200);
            expect(res.headers["x-target"]).toBe("yes");
            // the user id is also the login name, do not expose it to visitors
            expect(res.headers["x-proxy-user"]).toBeUndefined();

            const echoed = JSON.parse(res.body);
            expect(echoed.method).toBe("GET");
            expect(echoed.url).toBe("/hello/world?q=1");
            expect(echoed.headers.host).toBe(host());
            expect(echoed.headers["x-forwarded-for"]).toMatch(/127\.0\.0\.1 127\.0\.0\.1$/);
        });

        it("uses the client address from a trusted local proxy", async () => {
            const inspector = await openInspector(gateway.httpPort, user.id!, user.password!);
            try {
                const res = await request(gateway.httpPort, host(), "/behind-proxy", {
                    headers: { "X-Forwarded-For": "203.0.113.9" },
                });
                expect(JSON.parse(res.body).headers["x-forwarded-for"]).toBe("203.0.113.9 127.0.0.1");
                const done = await inspector.waitFor(isEntry((entry) => entry.path === "/behind-proxy" && entry.state === "complete"));
                expect(done.entry.remoteAddress).toBe("203.0.113.9");
            } finally {
                inspector.ws.close();
            }
        });

        it("forwards request bodies", async () => {
            const body = JSON.stringify({ hello: "world".repeat(1000) });
            const res = await request(gateway.httpPort, host(), "/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
                body,
            });
            const echoed = JSON.parse(res.body);
            expect(echoed.method).toBe("POST");
            expect(echoed.body).toBe(body);
        });

        it("passes through status codes", async () => {
            const res = await request(gateway.httpPort, host(), "/status/418");
            expect(res.status).toBe(418);
        });

        it("says nothing answered, without internals, when the shared port is closed", async () => {
            // its own tunnel, a second forward on the shared session would not replace the first
            const closedPort = await freePort();
            const other = await gateway.store.create();
            const otherSession = await ClientSession.create(gateway, other);
            await otherSession.connect();
            try {
                expect((await otherSession.register(closedPort)).stdout).toContain("Client accepted.");
                expect((await otherSession.forward(closedPort)).code).toBe(0);
                const res = await request(gateway.httpPort, `${other.domainName}.${HTTP_HOST}`, "/");
                expect(res.status).toBe(502);
                expect(res.body).toBe("Nothing answered\nThe computer sharing this address is connected, but the app it shares did not answer.\n");
            } finally {
                await otherSession.disconnect();
            }
        });

        it("streams requests to the inspector and replays them", async () => {
            const inspector = await openInspector(gateway.httpPort, user.id!, user.password!);
            try {
                const authenticated = await inspector.waitFor((p): p is Extract<typeof p, { type: "authenticated" }> => p.type === "authenticated");
                expect(authenticated.url).toBe(`http://${host()}:80/`);
                const history = await inspector.waitFor((p): p is Extract<typeof p, { type: "history" }> => p.type === "history");
                expect(history.entries.some((entry) => entry.path === "/hello/world?q=1")).toBe(true);

                const body = JSON.stringify({ inspect: "me" });
                await request(gateway.httpPort, host(), "/inspect-me", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });

                const pending = await inspector.waitFor(isEntry((entry) => entry.path === "/inspect-me" && entry.state === "pending"));
                const done = await inspector.waitFor(isEntry((entry) => entry.path === "/inspect-me" && entry.state === "complete"));
                expect(done.entry.id).toBe(pending.entry.id);
                expect(done.entry.status).toBe(200);
                expect(done.entry.responseHeaders?.["x-target"]).toBe("yes");
                expect(Buffer.from(done.entry.requestBody!.data, "base64").toString()).toBe(body);
                expect(JSON.parse(Buffer.from(done.entry.responseBody!.data, "base64").toString())).toMatchObject({ body });

                const hitsBefore = targetHits.filter((hit) => hit === "POST /inspect-me").length;
                inspector.send({ type: "replay", id: done.entry.id });
                const replayed = await inspector.waitFor(isEntry((entry) => entry.replayOf === done.entry.id && entry.state === "complete"));
                expect(replayed.entry.status).toBe(200);
                expect(Buffer.from(replayed.entry.requestBody!.data, "base64").toString()).toBe(body);
                expect(targetHits.filter((hit) => hit === "POST /inspect-me").length).toBe(hitsBefore + 1);

                inspector.send({ type: "replay", id: 99999 });
                const failed = await inspector.waitFor((p): p is Extract<typeof p, { type: "replay-failed" }> => p.type === "replay-failed");
                expect(failed.message).toContain("no longer in history");
            } finally {
                inspector.ws.close();
            }
        });

        it("proxies websockets through the tunnel", async () => {
            const echo = new WebSocketServer({ noServer: true });
            const onUpgrade = (req: http.IncomingMessage, socket: any, head: Buffer) => {
                echo.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(`echo: ${data}`)));
            };
            target.on("upgrade", onUpgrade);

            const ws = new WebSocket(`ws://127.0.0.1:${gateway.httpPort}/socket`, { headers: { Host: host() } });
            try {
                await new Promise((resolve, reject) => {
                    ws.once("open", resolve);
                    ws.once("error", reject);
                });
                ws.send("hello");
                const reply = await new Promise<string>((resolve) => ws.once("message", (data) => resolve(data.toString())));
                expect(reply).toBe("echo: hello");
            } finally {
                ws.close();
                target.off("upgrade", onUpgrade);
                echo.close();
            }
        });

        describe("with --auth", () => {
            const authorization = (credential: string) => `Basic ${Buffer.from(credential).toString("base64")}`;

            beforeAll(async () => {
                expect((await session.register(targetPort(), undefined, "alice:open sesame")).stdout).toContain("Client accepted.");
            });

            afterAll(async () => {
                expect((await session.register(targetPort())).stdout).toContain("Client accepted.");
            });

            it("asks visitors for the user name and password", async () => {
                const hitsBefore = targetHits.length;
                for (const headers of [{}, { Authorization: authorization("alice:wrong") }, { Authorization: authorization("bob:open sesame") }]) {
                    const res = await request(gateway.httpPort, host(), "/private", { headers });
                    expect(res.status).toBe(401);
                    expect(res.headers["www-authenticate"]).toBe('Basic realm="Protected forward", charset="UTF-8"');
                }
                expect(targetHits.length).toBe(hitsBefore);

                const res = await request(gateway.httpPort, host(), "/private", { headers: { Authorization: authorization("alice:open sesame") } });
                expect(res.status).toBe(200);
                expect(JSON.parse(res.body).url).toBe("/private");
            });

            it("keeps refused visitors out of the inspector, and still replays the others", async () => {
                const inspector = await openInspector(gateway.httpPort, user.id!, user.password!);
                try {
                    await inspector.waitFor((packet) => packet.type === "history");
                    await request(gateway.httpPort, host(), "/refused");
                    const ok = await request(gateway.httpPort, host(), "/allowed", { headers: { Authorization: authorization("alice:open sesame") } });
                    expect(ok.status).toBe(200);
                    const done = await inspector.waitFor(isEntry((entry) => entry.path === "/allowed" && entry.state === "complete"));
                    expect(inspector.packets.some((packet) => packet.type === "entry" && packet.entry.path === "/refused")).toBe(false);

                    inspector.send({ type: "replay", id: done.entry.id });
                    const replayed = await inspector.waitFor(isEntry((entry) => entry.replayOf === done.entry.id && entry.state === "complete"));
                    expect(replayed.entry.status).toBe(200);
                } finally {
                    inspector.ws.close();
                }
            });

            it("asks websocket visitors too", async () => {
                const refused = new WebSocket(`ws://127.0.0.1:${gateway.httpPort}/socket`, { headers: { Host: host() } });
                const status = await new Promise<number>((resolve) => {
                    refused.once("unexpected-response", (_req, res) => resolve(res.statusCode!));
                    refused.once("error", () => resolve(-1));
                });
                expect(status).toBe(401);

                const echo = new WebSocketServer({ noServer: true });
                const onUpgrade = (req: http.IncomingMessage, socket: any, head: Buffer) => {
                    echo.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(`echo: ${data}`)));
                };
                target.on("upgrade", onUpgrade);
                const ws = new WebSocket(`ws://127.0.0.1:${gateway.httpPort}/socket`, {
                    headers: { Host: host(), Authorization: authorization("alice:open sesame") },
                });
                try {
                    await new Promise((resolve, reject) => {
                        ws.once("open", resolve);
                        ws.once("error", reject);
                    });
                    ws.send("hello");
                    expect(await new Promise<string>((resolve) => ws.once("message", (data) => resolve(data.toString())))).toBe("echo: hello");
                } finally {
                    ws.close();
                    target.off("upgrade", onUpgrade);
                    echo.close();
                }
            });
        });

        it("closes forwarded channels after each request", async () => {
            // every request opens a forwarded channel, which the ssh client turns into a
            // socket to the local app; macOS allows only 256 open files per process by default
            const sshFds = () => readdirSync(`/proc/${session.master!.pid}/fd`).length;
            const targetConnections = () => new Promise<number>((resolve) => target.getConnections((_, count) => resolve(count)));

            await request(gateway.httpPort, host(), "/warmup");
            await new Promise((resolve) => setTimeout(resolve, 300));
            const before = { fds: sshFds(), connections: await targetConnections() };

            for (let i = 0; i < 60; i++) {
                const res = await request(gateway.httpPort, host(), `/leak/${i}`);
                expect(res.status).toBe(200);
            }

            // visitors that go away before the response finished
            for (let i = 0; i < 10; i++) {
                await new Promise<void>((resolve) => {
                    const req = http.request({ host: "127.0.0.1", port: gateway.httpPort, path: "/slow", headers: { Host: host() } }, (res) => {
                        res.once("data", () => {
                            if (i % 2) req.destroy();
                            else req.socket!.resetAndDestroy();
                            resolve();
                        });
                    });
                    req.on("error", () => {});
                    req.end();
                });
            }

            // websockets opened and closed from either side
            const echo = new WebSocketServer({ noServer: true });
            const onUpgrade = (req: http.IncomingMessage, socket: any, head: Buffer) => {
                echo.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => {
                    if (String(data) === "bye") ws.close();
                    else ws.send(String(data));
                }));
            };
            target.on("upgrade", onUpgrade);
            for (let i = 0; i < 20; i++) {
                const ws = new WebSocket(`ws://127.0.0.1:${gateway.httpPort}/socket`, { headers: { Host: host() } });
                await new Promise((resolve, reject) => {
                    ws.once("open", resolve);
                    ws.once("error", reject);
                });
                const closed = new Promise((resolve) => ws.once("close", resolve));
                if (i % 3 === 0) ws.send("bye");
                else if (i % 3 === 1) ws.terminate();
                // a visitor whose connection is reset
                else (ws as any)._socket.resetAndDestroy();
                await closed;
            }
            target.off("upgrade", onUpgrade);
            echo.close();

            await new Promise((resolve) => setTimeout(resolve, 1000));
            const after = { fds: sshFds(), connections: await targetConnections() };

            expect(after.fds - before.fds).toBeLessThan(5);
            expect(after.connections - before.connections).toBeLessThan(5);
        });

        it("handles concurrent requests", async () => {
            const results = await Promise.all(
                Array.from({ length: 10 }, (_, i) => request(gateway.httpPort, host(), `/concurrent/${i}`))
            );
            expect(results.map((res) => JSON.parse(res.body).url)).toEqual(
                Array.from({ length: 10 }, (_, i) => `/concurrent/${i}`)
            );
        });
    });

    describe("dead connections", () => {
        let quick: Gateway;

        beforeAll(async () => {
            // short keepalive, ssh2 defaults to a ping every 15 s and gives up after 3
            quick = await startGateway({ keepaliveInterval: 200, keepaliveCountMax: 2 });
        });

        afterAll(() => quick.stop());

        it("releases a connection whose client vanished without closing it", async () => {
            // a relay that can go silent like a laptop going to sleep: no FIN, no RST
            const frozen: net.Socket[] = [];
            let freeze = () => {};
            const relay = net.createServer((incoming) => {
                const outgoing = net.connect(quick.sshPort, "127.0.0.1");
                incoming.pipe(outgoing).pipe(incoming);
                const swallow = () => {};
                incoming.on("error", swallow);
                outgoing.on("error", swallow);
                freeze = () => {
                    incoming.unpipe(outgoing);
                    outgoing.unpipe(incoming);
                    incoming.removeAllListeners("end").removeAllListeners("close");
                    outgoing.removeAllListeners("end").removeAllListeners("close");
                    outgoing.pause();
                    outgoing.on("end", swallow);
                    frozen.push(outgoing);
                };
            });
            relay.listen(0, "127.0.0.1");
            await new Promise((resolve) => relay.once("listening", resolve));

            try {
                const user = await quick.store.create();
                const session = await ClientSession.create(quick, user);
                session.port = (relay.address() as net.AddressInfo).port;
                await session.connect();
                expect((await session.register(8080)).stdout).toContain("Client accepted.");
                expect((await session.forward(8080)).code).toBe(0);
                expect(await quick.sshConnections()).toBe(1);

                freeze();
                session.master!.kill("SIGKILL");

                // keepalive notices after about 2 x 200 ms, the socket must then really close
                await waitFor(async () => ((await quick.sshConnections()) === 0 ? true : undefined), 8000);
                expect(user.tunnelConnection).toBeNull();
            } finally {
                frozen.forEach((socket) => socket.destroy());
                relay.close();
            }
        });
    });

    describe("reconnecting", () => {
        let user: User;
        let target: http.Server;
        let targetPort: number;

        beforeAll(async () => {
            target = http.createServer((_req, res) => res.end("still here"));
            targetPort = await listen(target);
            user = await gateway.store.create();
        });

        afterAll(() => close(target));

        it("keeps the new tunnel when the replaced connection closes", async () => {
            const first = await ClientSession.create(gateway, user);
            await first.connect();
            expect((await first.register(targetPort)).stdout).toContain("Client accepted.");
            expect((await first.forward(targetPort)).code).toBe(0);

            // what run.sh does after it decided the first connection is dead
            const second = await ClientSession.create(gateway, user);
            second.controlName = "control-2.sock";
            await second.connect();
            expect((await second.register(targetPort)).stdout).toContain("Client accepted.");
            expect((await second.forward(targetPort)).code).toBe(0);

            // the gateway closes the replaced connection, its close must not take the new tunnel down
            await waitFor(async () => (first.master!.exitCode !== null ? true : undefined));
            await new Promise((resolve) => setTimeout(resolve, 500));

            expect(second.master!.exitCode).toBeNull();
            const res = await request(gateway.httpPort, `${user.domainName}.${HTTP_HOST}`, "/");
            expect(res.body).toBe("still here");

            await first.disconnect();
            await second.disconnect();
        });
    });

    describe.skipIf(!SSHD_PATH)("static directory mode", () => {
        let user: User;
        let session: ClientSession;
        let sshd: ChildProcess;
        let sshdPort: number;
        let root: string;
        let www: string;
        const host = () => `${user.domainName}.${HTTP_HOST}`;
        const get = (urlPath: string, headers?: http.OutgoingHttpHeaders) =>
            request(gateway.httpPort, host(), urlPath, { headers });

        beforeAll(async () => {
            user = await gateway.store.create();
            session = await ClientSession.create(gateway, user);

            // the files to serve, with a secret next to (not inside) the served directory
            root = path.join(session.workDir, "files");
            www = path.join(root, "www");
            await mkdir(path.join(www, "sub dir"), { recursive: true });
            await writeFile(path.join(www, "index.html"), "<h1>hello</h1>");
            await writeFile(path.join(www, "style.css"), "body {}");
            await writeFile(path.join(www, "digits.txt"), "0123456789");
            await writeFile(path.join(www, "sub dir", "nested file.txt"), "nested");
            await symlink("sub dir/nested file.txt", path.join(www, "link-inside"));
            await symlink(path.join(root, "secret.txt"), path.join(www, "link-outside"));
            await writeFile(path.join(root, "secret.txt"), "top secret");

            // the client side sshd exactly as run.sh configures it
            sshdPort = await freePort();
            const sshdDir = path.join(session.workDir, "sshd");
            await mkdir(sshdDir);
            for (const type of ["rsa", "ecdsa", "ed25519"]) await keygen(path.join(sshdDir, `ssh_host_${type}_key`), type);
            await writeFile(path.join(sshdDir, "authorized_keys"), user.gatewayKeyPub!);
            await chmod(path.join(sshdDir, "authorized_keys"), 0o600);
            await writeFile(path.join(sshdDir, "sshd_config"), await clientSshdConfig({
                LISTEN_PORT: sshdPort,
                WORKDIR: sshdDir,
                CURRENT_USER: LOCAL_USER,
            }));
            sshd = spawn(SSHD_PATH, ["-D", "-e", "-f", path.join(sshdDir, "sshd_config")], { stdio: "ignore" });
            await waitFor(() => new Promise<true | undefined>((resolve) => {
                const socket = net.connect(sshdPort, "127.0.0.1", () => {
                    socket.destroy();
                    resolve(true);
                });
                socket.on("error", () => resolve(undefined));
            }));

            await session.connect();
            expect((await session.register(0, www)).stdout).toContain("Client accepted.");
            expect((await session.forward(sshdPort)).code).toBe(0);
        });

        afterAll(async () => {
            await session.disconnect();
            sshd.kill();
        });

        it("serves files with content type and length", async () => {
            const html = await get("/index.html");
            expect(html.status).toBe(200);
            expect(html.body).toBe("<h1>hello</h1>");
            expect(html.headers["content-type"]).toMatch(/^text\/html/);
            expect(html.headers["content-length"]).toBe("14");
            expect(html.headers["accept-ranges"]).toBe("bytes");

            const css = await get("/style.css");
            expect(css.headers["content-type"]).toMatch(/^text\/css/);
        });

        it("serves file names that need encoding", async () => {
            const res = await get("/sub%20dir/nested%20file.txt");
            expect(res.status).toBe(200);
            expect(res.body).toBe("nested");
        });

        it("serves byte ranges", async () => {
            const res = await get("/digits.txt", { Range: "bytes=2-5" });
            expect(res.status).toBe(206);
            expect(res.body).toBe("2345");
            expect(res.headers["content-range"]).toBe("bytes 2-5/10");
            expect(res.headers["content-length"]).toBe("4");

            const suffix = await get("/digits.txt", { Range: "bytes=-3" });
            expect(suffix.status).toBe(206);
            expect(suffix.body).toBe("789");

            // players and download tools probe with this, it used to send the whole file
            const first = await get("/digits.txt", { Range: "bytes=0-0" });
            expect(first.status).toBe(206);
            expect(first.body).toBe("0");
            expect(first.headers["content-length"]).toBe("1");
            expect(first.headers["content-range"]).toBe("bytes 0-0/10");
        });

        it("serves files larger than one read request", async () => {
            const big = Buffer.from(Array.from({ length: 300 * 1024 + 7 }, (_, i) => i % 251));
            await writeFile(path.join(www, "big.bin"), big);
            const res = await new Promise<Buffer>((resolve, reject) => {
                http.get({ host: "127.0.0.1", port: gateway.httpPort, path: "/big.bin", headers: { Host: host() } }, (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (chunk) => chunks.push(chunk));
                    res.on("end", () => resolve(Buffer.concat(chunks)));
                }).on("error", reject);
            });
            expect(res.equals(big)).toBe(true);
        });

        it("rejects unsatisfiable ranges", async () => {
            const res = await get("/digits.txt", { Range: "bytes=20-30" });
            expect(res.status).toBe(416);
            expect(res.headers["content-range"]).toBe("bytes */10");
            expect(res.headers.etag).toBeUndefined();
        });

        it("redirects directories to a trailing slash", async () => {
            const res = await get("/sub%20dir");
            expect(res.status).toBe(302);
            expect(res.headers.location).toBe("/sub%20dir/");
        });

        it("lists directories without an index.html", async () => {
            const res = await get("/sub%20dir/");
            expect(res.status).toBe(200);
            expect(res.headers["content-type"]).toMatch(/^text\/html/);
            expect(res.body).toContain("nested%20file.txt");
        });

        it("serves the index.html of a directory instead of the list", async () => {
            const res = await get("/");
            expect(res.status).toBe(200);
            expect(res.headers["content-type"]).toMatch(/^text\/html/);
            expect(res.body).toBe("<h1>hello</h1>");
            expect(res.headers.etag).toBe((await get("/index.html")).headers.etag);
        });

        it("lists directories with an index.html after --list", async () => {
            user.serveIndex = false;
            try {
                const res = await get("/");
                expect(res.status).toBe(200);
                expect(res.body).toContain('href="/sub%20dir/"');
                expect(res.body).toContain('href="/digits.txt"');
                expect(res.body).toContain('href="/link-inside"');
                expect(res.body).toContain('href="/index.html"');
            } finally {
                user.serveIndex = true;
            }
        });

        describe("hidden files", () => {
            beforeAll(async () => {
                await writeFile(path.join(www, ".env"), "SECRET=1");
                await mkdir(path.join(www, ".git"), { recursive: true });
                await writeFile(path.join(www, ".git", "config"), "[core]");
                await symlink(".env", path.join(www, "env-link"));
            });

            it("are not listed and answer 404, as if they did not exist", async () => {
                user.serveIndex = false;
                try {
                    const res = await get("/");
                    expect(res.body).not.toContain(".env");
                    expect(res.body).not.toContain(".git");
                } finally {
                    user.serveIndex = true;
                }
                for (const hidden of ["/.env", "/.git/config", "/.git/", "/%2Eenv"]) {
                    const res = await get(hidden);
                    expect(res.status, hidden).toBe(404);
                    expect(res.body).not.toContain("SECRET");
                }
                // a symlink to one leads to the same 404
                const viaLink = await get("/env-link");
                expect(viaLink.status).toBe(302);
                expect((await get(viaLink.headers.location!)).status).toBe(404);
            });

            it("are listed and served with --dotfiles", async () => {
                user.serveDotfiles = true;
                user.serveIndex = false;
                try {
                    expect((await get("/")).body).toContain('href="/.git/"');
                    const env = await get("/.env");
                    expect(env.status).toBe(200);
                    expect(env.body).toBe("SECRET=1");
                } finally {
                    user.serveDotfiles = false;
                    user.serveIndex = true;
                }
            });
        });

        it("does not follow a symlinked index.html", async () => {
            const dir = path.join(www, "linked-index");
            await mkdir(dir);
            await symlink(path.join(root, "secret.txt"), path.join(dir, "index.html"));
            const res = await get("/linked-index/");
            expect(res.status).toBe(200);
            expect(res.body).not.toContain("top secret");
            expect(res.body).toContain("index.html");
        });

        describe("caching", () => {
            it("sends validators that make browsers check back", async () => {
                const res = await get("/digits.txt");
                expect(res.headers.etag).toMatch(/^"[0-9a-f]+-a"$/);
                expect(new Date(res.headers["last-modified"]!).getTime()).toBeGreaterThan(0);
                expect(res.headers["cache-control"]).toBe("no-cache");
            });

            it("answers 304 to a matching If-None-Match or If-Modified-Since", async () => {
                const first = await get("/digits.txt");
                for (const headers of [{ "If-None-Match": first.headers.etag }, { "If-Modified-Since": first.headers["last-modified"] }]) {
                    const res = await get("/digits.txt", headers);
                    expect(res.status).toBe(304);
                    expect(res.body).toBe("");
                    expect(res.headers.etag).toBe(first.headers.etag);
                }
                expect((await get("/digits.txt", { "If-None-Match": '"other"' })).status).toBe(200);
            });

            it("changes the etag when the file changes", async () => {
                const file = path.join(www, "changing.txt");
                await writeFile(file, "one");
                const before = await get("/changing.txt");
                await writeFile(file, "three");
                const after = await get("/changing.txt", { "If-None-Match": before.headers.etag });
                expect(after.status).toBe(200);
                expect(after.body).toBe("three");
                expect(after.headers.etag).not.toBe(before.headers.etag);
            });

            it("only sends a range of the version the client has", async () => {
                const { etag } = (await get("/digits.txt")).headers;
                const same = await get("/digits.txt", { Range: "bytes=2-5", "If-Range": etag });
                expect(same.status).toBe(206);
                expect(same.body).toBe("2345");

                const changed = await get("/digits.txt", { Range: "bytes=2-5", "If-Range": '"older"' });
                expect(changed.status).toBe(200);
                expect(changed.body).toBe("0123456789");
            });

            it("answers HEAD without reading the file", async () => {
                const res = await request(gateway.httpPort, host(), "/digits.txt", { method: "HEAD" });
                expect(res.status).toBe(200);
                expect(res.headers["content-length"]).toBe("10");
                expect(res.body).toBe("");
            });
        });

        it("records static responses for the inspector", async () => {
            const inspector = await openInspector(gateway.httpPort, user.id!, user.password!);
            try {
                await inspector.waitFor((p): p is Extract<typeof p, { type: "history" }> => p.type === "history");
                await get("/style.css");
                const done = await inspector.waitFor(isEntry((entry) => entry.path === "/style.css" && entry.state === "complete"));
                expect(done.entry.status).toBe(200);
                expect(done.entry.responseHeaders?.["content-type"]).toMatch(/^text\/css/);
                expect(Buffer.from(done.entry.responseBody!.data, "base64").toString()).toBe("body {}");
            } finally {
                inspector.ws.close();
            }
        });

        describe("socks5", () => {
            let echo: net.Server;
            let echoPort: number;
            const echoConnections = () => new Promise<number>((resolve) => echo.getConnections((_, count) => resolve(count)));

            beforeAll(async () => {
                echo = net.createServer((socket) => socket.pipe(socket));
                echoPort = await new Promise<number>((resolve) => echo.listen(0, "127.0.0.1", () => resolve((echo.address() as net.AddressInfo).port)));
            });

            afterAll(() => new Promise<void>((resolve) => echo.close(() => resolve())));

            it("reaches ports on the client machine", async () => {
                const socket = await socks5Connect(gateway.socksPort, user.id!, user.socksPassword!, "localhost", echoPort);
                socket.write("ping");
                const reply = await new Promise<string>((resolve) => socket.once("data", (data) => resolve(String(data))));
                expect(reply).toBe("ping");
                socket.end();
            });

            it("keeps data sent together with the request through the tunnel", async () => {
                const user_ = Buffer.from(user.id!);
                const pass = Buffer.from(user.socksPassword!);
                const socket = net.connect(gateway.socksPort, "127.0.0.1");
                let data = Buffer.alloc(0);
                socket.on("data", (chunk) => (data = Buffer.concat([data, chunk])));
                await new Promise((resolve) => socket.on("connect", resolve));
                // greeting, login, request and payload in one packet, without waiting for replies
                socket.write(Buffer.concat([
                    Buffer.from([5, 1, 2]),
                    Buffer.from([1, user_.length]), user_, Buffer.from([pass.length]), pass,
                    Buffer.from([5, 1, 0, 3, 9]), Buffer.from("localhost"), Buffer.from([echoPort >> 8, echoPort & 0xff]),
                    Buffer.from("early"),
                ]));
                await waitFor(async () => (data.includes(Buffer.from("early")) ? true : undefined), 5000);
                expect(data.subarray(0, 4)).toEqual(Buffer.from([5, 2, 1, 0]));
                expect(data.subarray(4, 6)).toEqual(Buffer.from([5, 0]));
                socket.end();
            });

            it("rejects a wrong password", async () => {
                await expect(socks5Connect(gateway.socksPort, user.id!, "wrong", "localhost", echoPort)).rejects.toThrow(/auth rejected/);
            });

            it("rejects the account password, which must never be sent unencrypted", async () => {
                await expect(socks5Connect(gateway.socksPort, user.id!, user.password!, "localhost", echoPort)).rejects.toThrow(/auth rejected/);
            });

            it("closes the tunneled connections", async () => {
                for (let i = 0; i < 40; i++) {
                    const socket = await socks5Connect(gateway.socksPort, user.id!, user.socksPassword!, "localhost", echoPort);
                    socket.write(`hello ${i}`);
                    await new Promise((resolve) => socket.once("data", resolve));
                    // most end politely, some are reset (RST, no end event on the gateway)
                    if (i % 4 === 0) socket.resetAndDestroy();
                    else socket.end();
                }
                let open = await echoConnections();
                for (let i = 0; i < 30 && open > 0; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    open = await echoConnections();
                }
                expect(open).toBe(0);
            });
        });

        describe("client sshd", () => {
            // what the gateway can do with its key on the user's machine, using the real run.sh config
            let gatewayKeyFile: string;
            const asGateway = (extra: string[], command?: string) => run("ssh", [
                "-F", "/dev/null", "-i", gatewayKeyFile, "-p", String(sshdPort),
                "-o", "IdentitiesOnly yes", "-o", "BatchMode yes",
                "-o", "StrictHostKeyChecking no", "-o", "UserKnownHostsFile /dev/null", "-o", "LogLevel ERROR",
                ...extra, `${LOCAL_USER}@127.0.0.1`, ...(command ? [command] : []),
            ]);
            const sftp = (commands: string) => new Promise<ExecResult>((resolve) => {
                const child = execFile("sftp", [
                    "-F", "/dev/null", "-i", gatewayKeyFile, "-P", String(sshdPort), "-b", "-",
                    "-o", "IdentitiesOnly yes", "-o", "BatchMode yes",
                    "-o", "StrictHostKeyChecking no", "-o", "UserKnownHostsFile /dev/null", "-o", "LogLevel ERROR",
                    `${LOCAL_USER}@127.0.0.1`,
                ], { timeout: 15000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr }));
                child.stdin!.end(commands);
            });

            beforeAll(async () => {
                gatewayKeyFile = path.join(session.workDir, "gateway_key");
                await writeFile(gatewayKeyFile, user.gatewayKey!, { mode: 0o600 });
            });

            it("reads the shared folder", async () => {
                const target = path.join(session.workDir, "fetched.html");
                const res = await sftp(`get "${path.join(www, "index.html")}" "${target}"\n`);
                expect(res.code).toBe(0);
                expect(await readFile(target, "utf8")).toBe("<h1>hello</h1>");
            });

            it("cannot run commands or get a terminal", async () => {
                const command = await asGateway([], "echo EXECUTED");
                expect(command.stdout).not.toContain("EXECUTED");
                expect(command.stdout + command.stderr).toContain("This service allows sftp connections only");

                const terminal = await asGateway(["-tt"], "echo EXECUTED");
                expect(terminal.stdout).not.toContain("EXECUTED");
            });

            it("cannot write files", async () => {
                const source = path.join(session.workDir, "planted.src");
                await writeFile(source, "planted");
                const res = await sftp(`put "${source}" "${path.join(www, "planted.txt")}"\n`);
                expect(res.code).not.toBe(0);
                await expect(readFile(path.join(www, "planted.txt"), "utf8")).rejects.toThrow();
            });

            it("only reaches local ports, and cannot listen on the user's machine", async () => {
                // the same channel the gateway opens for socks, straight against the client sshd
                const client = new Client();
                await new Promise<void>((resolve, reject) => {
                    client.on("ready", () => resolve());
                    client.on("error", reject);
                    client.connect({ host: "127.0.0.1", port: sshdPort, username: LOCAL_USER, privateKey: user.gatewayKey! });
                });
                const open = (host: string, port: number) => new Promise<string>((resolve) => {
                    client.forwardOut("127.0.0.1", 0, host, port, (err, channel) => {
                        if (err) return resolve(`refused: ${err.message}`);
                        channel.destroy();
                        resolve("opened");
                    });
                });
                const listen = () => new Promise<string>((resolve) => {
                    client.forwardIn("127.0.0.1", 0, (err) => resolve(err ? `refused: ${err.message}` : "listening"));
                });

                try {
                    expect(await open("localhost", sshdPort)).toBe("opened");
                    expect(await open("127.0.0.1", sshdPort)).toBe("opened");
                    expect(await open("127.0.0.2", sshdPort)).toMatch(/^refused/);
                    expect(await open("example.com", 80)).toMatch(/^refused/);
                    expect(await listen()).toMatch(/^refused/);
                } finally {
                    client.end();
                }
            });
        });

        it("returns 404 for missing files, without internals", async () => {
            const res = await get("/missing.txt");
            expect(res.status).toBe(404);
            expect(res.body).toBe("Not found\nThere is no file at this address.\n");
        });

        it("returns 403 for files the user can not read, without internals", async () => {
            const file = path.join(www, "private.txt");
            await writeFile(file, "private");
            await chmod(file, 0o000);
            try {
                const res = await get("/private.txt");
                expect(res.status).toBe(403);
                expect(res.body).toBe("Not available\nThis file can not be shared.\n");
                // the file's own length, set before the read failed, must not stay
                expect(res.headers["content-length"]).not.toBe("7");
            } finally {
                await chmod(file, 0o644);
            }
        });

        describe("check", () => {
            const check = (target: ClientSession) => target.exec(`'v${CLIENT_SCRIPT_VERSION}:' check`);

            it("passes when the gateway logs in to the client sshd and can read the folder", async () => {
                const res = await check(session);
                expect(res.code).toBe(0);
                expect(res.stdout).toBe("ok\n");
            });

            it("says why when the folder can not be read", async () => {
                expect((await session.register(0, path.join(root, "missing"))).stdout).toContain("Client accepted.");
                try {
                    const res = await check(session);
                    expect(res.code).toBe(3);
                    expect(res.stderr).toContain(`the gateway can not read ${path.join(root, "missing")}: No such file`);
                } finally {
                    expect((await session.register(0, www)).stdout).toContain("Client accepted.");
                }
            });

            it("says why, right away, when the client sshd refuses the gateway", async () => {
                // another user's gateway key, which this sshd does not have in authorized_keys
                const stranger = await gateway.store.create();
                const strangerSession = await ClientSession.create(gateway, stranger);
                await strangerSession.connect();
                try {
                    expect((await strangerSession.register(0, www)).stdout).toContain("Client accepted.");
                    expect((await strangerSession.forward(sshdPort)).code).toBe(0);
                    const started = Date.now();
                    const res = await check(strangerSession);
                    expect(res.code).toBe(3);
                    expect(res.stderr).toContain("the gateway could not log in to the sshd of this script: All configured authentication methods failed");
                    // not the 25 s queue timeout
                    expect(Date.now() - started).toBeLessThan(10000);

                    // visitors get the offline page right away too, and the next request tries again
                    for (let i = 0; i < 2; i++) {
                        const page = await request(gateway.httpPort, `${stranger.domainName}.${HTTP_HOST}`, "/");
                        expect(page.status).toBe(502);
                        expect(page.body).not.toContain("authentication");
                    }
                } finally {
                    await strangerSession.disconnect();
                }
            });

            it("passes in port mode, where the gateway needs no login", async () => {
                const portUser = await gateway.store.create();
                const portSession = await ClientSession.create(gateway, portUser);
                expect((await check(portSession)).stderr).toContain("register first");
                expect((await portSession.register(8080)).stdout).toContain("Client accepted.");
                expect((await check(portSession)).code).toBe(0);
            });
        });

        it("asks visitors for the --auth password before listing anything", async () => {
            user.publicAuth = { account: "alice", password: "secret" };
            try {
                expect((await get("/")).status).toBe(401);
                expect((await get("/", { Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}` })).status).toBe(200);
            } finally {
                user.publicAuth = null;
            }
        });

        it("redirects symlinks inside the directory", async () => {
            const res = await get("/link-inside");
            expect(res.status).toBe(302);
            expect(res.headers.location).toBe("/sub%20dir/nested%20file.txt");
        });

        it("refuses symlinks pointing outside the directory", async () => {
            const res = await get("/link-outside");
            expect(res.status).toBe(403);
            expect(res.body).not.toContain("top secret");
            expect(res.body).not.toContain(root);
        });

        it.each([
            ["encoded dots", "/%2e%2e/secret.txt"],
            ["encoded slash", "/..%2fsecret.txt"],
        ])("does not serve files outside the directory via %s", async (_, urlPath) => {
            const res = await get(urlPath);
            expect(res.body).not.toContain("top secret");
            expect(res.status).toBeGreaterThanOrEqual(400);
        });
    });
});
