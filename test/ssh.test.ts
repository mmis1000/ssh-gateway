import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { ChildProcess, execFile, spawn } from "child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "fs/promises";
import { BaseAgent, Client, ParsedKey, utils } from "ssh2";
import { createHttpServer } from "../src/http_server";
import { createSshServer } from "../src/ssh_server";
import { createUser, User } from "../src/user";
import { close, createConfig, createTempDir, HTTP_HOST, isEntry, listen, openInspector, request } from "./helpers";

// Drives the gateway with the real OpenSSH client the same way template/script.template does:
// a ControlMaster connection, a "v1: register" exec and a "-O forward -R 22:localhost:<port>" reverse tunnel.

const SSHD_PATH = "/usr/sbin/sshd";
const SFTP_SERVER_PATH = "/usr/lib/openssh/sftp-server";
const LOCAL_USER = os.userInfo().username;

interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

function run(file: string, args: string[]) {
    return new Promise<ExecResult>((resolve) => {
        execFile(file, args, { timeout: 15000 }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
            resolve({ code, stdout, stderr });
        });
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
    sshPort: number;
    httpPort: number;
    stop(): Promise<void>;
}

async function startGateway(): Promise<Gateway> {
    const { dir, cleanup } = await createTempDir();
    const saveDir = path.join(dir, "save");
    const hostKey = path.join(dir, "host_key");
    await keygen(hostKey);

    const config = createConfig(saveDir);
    const sshServer = createSshServer(config, [await readFile(hostKey)]);
    const sshPort = await new Promise<number>((resolve) => {
        sshServer.listen(0, "127.0.0.1", () => resolve((sshServer.address() as net.AddressInfo).port));
    });
    const { server: httpServer } = await createHttpServer(config);
    const httpPort = await listen(httpServer);

    return {
        saveDir,
        sshPort,
        httpPort,
        async stop() {
            await close(httpServer);
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
            await writeFile(identity, user.privateKey!);
            await chmod(identity, 0o600);
        }
        return new ClientSession(gateway, user, workDir, identity);
    }

    get controlSock() {
        return path.join(this.workDir, "control.sock");
    }

    args(extra: string[] = []) {
        return [
            "-F", "/dev/null",
            "-i", this.identity,
            "-p", String(this.gateway.sshPort),
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

    exec(command: string) {
        return run("ssh", [...this.args(), command]);
    }

    async connect() {
        this.master = spawn("ssh", this.args(["-N", "-M", "-o", "ControlPersist no", "-o", "ClearAllForwardings yes"]), {
            stdio: "ignore",
        });
        await waitFor(async () => ((await run("ssh", this.args(["-O", "check"]))).code === 0 ? true : undefined));
    }

    register(port: number, staticDirectory?: string) {
        const args = ["v1:", "register", LOCAL_USER, String(port)];
        if (staticDirectory) args.push(staticDirectory);
        return this.exec(args.map((arg) => `'${arg}'`).join(" "));
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

describe("ssh server", () => {
    let gateway: Gateway;

    beforeAll(async () => {
        gateway = await startGateway();
    });

    afterAll(() => gateway.stop());

    describe("authentication", () => {
        let user: User;

        beforeAll(async () => {
            user = await createUser(gateway.saveDir);
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
            // knowing the public key must not be enough, the signature has to be checked
            const publicKey = utils.parseKey(user.privateKey_pub!) as ParsedKey;
            class ForgingAgent extends BaseAgent {
                getIdentities(cb: (err: Error | undefined, keys?: ParsedKey[]) => void) {
                    cb(undefined, [publicKey]);
                }
                sign(_key: ParsedKey, _data: Buffer, ...args: any[]) {
                    const cb = args[args.length - 1];
                    // well formed ECDSA signature (DER sequence of r = 1, s = 1) that does not match the data
                    cb(undefined, Buffer.from("3006020101020101", "hex"));
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
            expect(result).toBe("client-authentication");
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

    describe("register command", () => {
        let user: User;
        let session: ClientSession;

        beforeAll(async () => {
            user = await createUser(gateway.saveDir);
            session = await ClientSession.create(gateway, user);
        });

        it("accepts a v1 forward registration", async () => {
            const res = await session.register(8080);
            expect(res.stdout).toContain("Client accepted.");
            expect(res.stdout).not.toContain("Please update client");
            expect(res.stdout).toContain(`Forward server is opened at http://${user.domainName}.${HTTP_HOST}:80/`);
            expect(res.stdout).toContain(`socks5://${user.id}:${user.password}@`);
            expect(user.httpPort).toBe(8080);
            expect(user.remoteUser).toBe(LOCAL_USER);
        });

        it("asks v0 clients to update", async () => {
            const res = await session.exec(`register ${LOCAL_USER} 8080`);
            expect(res.stdout).toMatch(/^Please update client!!!\nClient accepted\./);
        });

        it("normalizes the static directory", async () => {
            const res = await session.register(0, "/srv/www/../site/");
            expect(res.stdout).toContain("Client accepted.");
            expect(user.httpPort).toBe(0);
            expect(user.staticDirectory).toBe("/srv/site");
        });

        it.each([
            ["missing port", `v1: register ${LOCAL_USER}`],
            ["non numeric port", `v1: register ${LOCAL_USER} http`],
            ["leading zero port", `v1: register ${LOCAL_USER} 080`],
            ["unknown command", `v1: unregister ${LOCAL_USER} 8080`],
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

        beforeAll(async () => {
            target = http.createServer((req, res) => {
                const chunks: Buffer[] = [];
                req.on("data", (chunk) => chunks.push(chunk));
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
            const targetPort = await listen(target);

            user = await createUser(gateway.saveDir);
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

        it("handles concurrent requests", async () => {
            const results = await Promise.all(
                Array.from({ length: 10 }, (_, i) => request(gateway.httpPort, host(), `/concurrent/${i}`))
            );
            expect(results.map((res) => JSON.parse(res.body).url)).toEqual(
                Array.from({ length: 10 }, (_, i) => `/concurrent/${i}`)
            );
        });
    });

    describe.skipIf(!SSHD_PATH)("static directory mode", () => {
        let user: User;
        let session: ClientSession;
        let sshd: ChildProcess;
        let root: string;
        let www: string;
        const host = () => `${user.domainName}.${HTTP_HOST}`;
        const get = (urlPath: string, headers?: http.OutgoingHttpHeaders) =>
            request(gateway.httpPort, host(), urlPath, { headers });

        beforeAll(async () => {
            user = await createUser(gateway.saveDir);
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

            // a client side sshd like run.sh starts
            const sshdPort = await freePort();
            const sshdDir = path.join(session.workDir, "sshd");
            await mkdir(sshdDir);
            await keygen(path.join(sshdDir, "ssh_host_ed25519_key"));
            await writeFile(path.join(sshdDir, "authorized_keys"), user.publicKey_pub!);
            await chmod(path.join(sshdDir, "authorized_keys"), 0o600);
            await writeFile(path.join(sshdDir, "sshd_config"), [
                `Port ${sshdPort}`,
                "ListenAddress 127.0.0.1",
                `HostKey ${path.join(sshdDir, "ssh_host_ed25519_key")}`,
                `AllowUsers ${LOCAL_USER}`,
                "PermitRootLogin no",
                `AuthorizedKeysFile ${path.join(sshdDir, "authorized_keys")}`,
                `PidFile ${path.join(sshdDir, "sshd.pid")}`,
                "PasswordAuthentication no",
                "KbdInteractiveAuthentication no",
                "UsePAM no",
                // the test directory lives under the system temp dir
                "StrictModes no",
                `Subsystem sftp ${SFTP_SERVER_PATH}`,
                "",
            ].join("\n"));
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
        });

        it("rejects unsatisfiable ranges", async () => {
            const res = await get("/digits.txt", { Range: "bytes=20-30" });
            expect(res.status).toBe(416);
        });

        it("redirects directories to a trailing slash", async () => {
            const res = await get("/sub%20dir");
            expect(res.status).toBe(302);
            expect(res.headers.location).toBe("/sub%20dir/");
        });

        it("lists directories", async () => {
            const res = await get("/");
            expect(res.status).toBe(200);
            expect(res.headers["content-type"]).toMatch(/^text\/html/);
            expect(res.body).toContain('href="/sub%20dir"');
            expect(res.body).toContain('href="/digits.txt"');
            expect(res.body).toContain('href="/link-inside"');
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

        it("returns 404 for missing files", async () => {
            const res = await get("/missing.txt");
            expect(res.status).toBe(404);
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
