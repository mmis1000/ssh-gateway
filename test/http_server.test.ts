import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import path from "path";
import type { Express } from "express";
import ssh2_streams from "ssh2-streams";
import { createHttpServer } from "../src/http_server";
import WebSocket from "ws";
import { close, createConfig, createTempDir, HTTP_HOST, listen, openInspector, openTestStore, request, SETUP_HOST } from "./helpers";

const SFTPStream = ssh2_streams.SFTPStream as any;

const basicAuth = (account: string, password: string) =>
    `Basic ${Buffer.from(`${account}:${password}`).toString("base64")}`;

describe("http server", () => {
    let router: Express;
    let server: http.Server;
    let port: number;
    let saveDir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
        const temp = await createTempDir();
        cleanup = temp.cleanup;
        saveDir = path.join(temp.dir, "save");
        ({ router, server } = await createHttpServer(createConfig(saveDir), await openTestStore(saveDir)));
        port = await listen(server);
    });

    afterAll(async () => {
        await close(server);
        await cleanup();
    });

    describe("setup host", () => {
        it("shows the setup instructions", async () => {
            const res = await request(port, SETUP_HOST, "/");
            expect(res.status).toBe(200);
            expect(res.body).toContain(`curl -X POST -u 'username:password' http://${SETUP_HOST}:80/setup > run.sh`);
        });

        it("keeps plain text instructions for curl", async () => {
            const res = await request(port, SETUP_HOST, "/", { headers: { Accept: "*/*", "User-Agent": "curl/8.5.0" } });
            expect(res.headers["content-type"]).toMatch(/^text\/plain/);
            expect(res.body).toContain("Run following command to setup the forward");
        });

        it("shows the landing page to browsers", async () => {
            const res = await request(port, SETUP_HOST, "/", {
                headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
            });
            expect(res.status).toBe(200);
            expect(res.headers["content-type"]).toMatch(/^text\/html/);
            expect(res.body).toContain(`<title>SSH Gateway · ${SETUP_HOST}</title>`);
            // default port dropped, quotes escaped in the page and in the copy button
            expect(res.body).toContain(`curl -X POST -u &#39;username:password&#39; http://${SETUP_HOST}/setup &gt; run.sh`);
            expect(res.body).toContain(`data-copy="curl -X POST -u &#39;username:password&#39; http://${SETUP_HOST}/setup &gt; run.sh"`);
            expect(res.body).toContain("chmod +x run.sh &amp;&amp; ./run.sh");
            expect(res.body).toContain("This gateway is private");
            expect(res.body).toContain(`http://brave-otter-42.${HTTP_HOST}/`);
            expect(res.body).toContain('href="/app/"');
            // self contained, no third party requests
            expect(res.body).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/);
        });

        it("ignores the port in the host header", async () => {
            const res = await request(port, `${SETUP_HOST}:8080`, "/");
            expect(res.body).toContain("Run following command to setup the forward");
        });

        it("asks for credential on setup without auth", async () => {
            const res = await request(port, SETUP_HOST, "/setup", { method: "POST" });
            expect(res.status).toBe(401);
            expect(res.headers["www-authenticate"]).toBe('Basic realm="Not authenticated"');
        });

        it("rejects setup with bad credential", async () => {
            const res = await request(port, SETUP_HOST, "/setup", {
                method: "POST",
                headers: { Authorization: basicAuth("admin", "wrong") },
            });
            expect(res.status).toBe(401);
            expect(res.body).toBe("bad credential");
        });

        it("creates a user and returns the script, which can be updated with the user credential", async () => {
            const setup = await request(port, SETUP_HOST, "/setup", {
                method: "POST",
                headers: { Authorization: basicAuth("admin", "secret") },
            });
            expect(setup.status).toBe(200);
            expect(setup.headers["content-type"]).toMatch(/^application\/x-sh/);
            expect(setup.body).toMatch(/^#! \/bin\/bash/);
            expect(setup.body).not.toMatch(/\*[A-Z_]+\*/);

            const userIds = (await readdir(path.join(saveDir, "users"))).filter((name) => !name.startsWith("."));
            expect(userIds).toHaveLength(1);
            const info = JSON.parse(await readFile(path.resolve(saveDir, "users", userIds[0], "user.json"), "utf8"));
            expect(setup.body).toContain(info.id);

            const update = await request(port, SETUP_HOST, "/update", {
                headers: { Authorization: basicAuth(info.id, info.password) },
            });
            expect(update.status).toBe(200);
            expect(update.body).toBe(setup.body);
        });

        it("rejects update with bad password", async () => {
            const res = await request(port, SETUP_HOST, "/update", {
                headers: { Authorization: basicAuth("nobody", "wrong") },
            });
            expect(res.status).toBe(401);
            expect(res.headers["www-authenticate"]).toBe('Basic realm="Not authenticated"');
        });

        it("asks for credential on update without auth, and keeps serving", async () => {
            const res = await request(port, SETUP_HOST, "/update");
            expect(res.status).toBe(401);
            expect(res.headers["www-authenticate"]).toBe('Basic realm="Not authenticated"');

            // the rejected lookup used to write headers again and crash the process
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect((await request(port, SETUP_HOST, "/")).status).toBe(200);
        });
    });

    describe("public gateway", () => {
        it("leaves out the account on the landing page", async () => {
            const temp = await createTempDir();
            const publicSave = path.join(temp.dir, "save");
            const config = createConfig(publicSave, { setupRequireAuth: false, setupPort: 8443, setupProtocol: "https" });
            const { server: publicServer } = await createHttpServer(config, await openTestStore(publicSave));
            const publicPort = await listen(publicServer);
            try {
                const res = await request(publicPort, SETUP_HOST, "/", { headers: { Accept: "text/html" } });
                expect(res.body).toContain(`curl -X POST https://${SETUP_HOST}:8443/setup &gt; run.sh`);
                expect(res.body).not.toContain("username:password");
                expect(res.body).not.toContain("This gateway is private");
            } finally {
                await close(publicServer);
                await temp.cleanup();
            }
        });
    });

    describe("inspector websocket", () => {
        it.each([
            ["unknown user", "no-such-user", "x"],
            ["malformed login", "", ""],
        ])("closes with the auth failed code for %s", async (_, username, password) => {
            const inspector = await openInspector(port, username, password);
            expect(await inspector.closed).toEqual({ code: 4001, reason: "bad username or password" });
        });

        it("closes with the auth failed code for a wrong password", async () => {
            const userIds = (await readdir(path.join(saveDir, "users"))).filter((name) => !name.startsWith("."));
            expect(userIds.length).toBeGreaterThan(0);
            const inspector = await openInspector(port, userIds[0], "wrong");
            expect((await inspector.closed).code).toBe(4001);
        });

        it("ignores websocket upgrades on other hosts", async () => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/__observe_requests`, { headers: { Host: HTTP_HOST } });
            const result = await new Promise((resolve) => {
                ws.on("open", () => resolve("open"));
                ws.on("error", () => resolve("error"));
            });
            expect(result).toBe("error");
            ws.terminate();
        });
    });

    describe("user content host", () => {
        it("shows a notice on the bare host", async () => {
            const res = await request(port, HTTP_HOST, "/");
            expect(res.body).toBe("This is a domain that serves user content.");
        });

        it("disallows robots on user domains", async () => {
            const res = await request(port, `someone.${HTTP_HOST}`, "/robots.txt");
            expect(res.body).toContain("Disallow: /");
        });

        it("fails for unknown user domains", async () => {
            const res = await request(port, `no-such-user.${HTTP_HOST}`, "/index.html");
            expect(res.status).toBe(404);
            expect(res.body).toBe("No forward is registered for this domain");
        });
    });

    describe.skipIf(!existsSync("app/dist/index.html"))("profiler app", () => {
        it("serves the built app", async () => {
            const res = await request(port, SETUP_HOST, "/app/");
            expect(res.status).toBe(200);
            expect(res.body).toContain('<div id="app">');
        });

        it("falls back to index.html for client side routes", async () => {
            const res = await request(port, SETUP_HOST, "/app/some/deep/route");
            expect(res.status).toBe(200);
            expect(res.body).toContain('<div id="app">');
        });
    });

    describe("folder view", () => {
        const entry = (filename: string, mode: number) => ({
            filename,
            attrs: new SFTPStream.Stats({ mode }),
        });

        const renderFolder = (locals: object) =>
            new Promise<string>((resolve, reject) => {
                router.render("folder", locals, (err, html) => (err ? reject(err) : resolve(html!)));
            });

        it("renders the listing with the app locals", async () => {
            const html = await renderFolder({
                path: "/music/live set/",
                files: [
                    entry("song.mp3", 0o100644),
                    entry("sub dir", 0o40755),
                    entry("clip.mp4", 0o100644),
                    entry("readme", 0o100644),
                    entry("latest", 0o120777),
                ],
            });

            expect(html).toContain('<a href=/music/live%20set/>live set &gt;</a>');
            expect(html).toContain('href="/music/live%20set/sub%20dir"');
            expect(html).toContain('<a href="../"');

            const icons = [...html.matchAll(/material-icons">(\w+)<\/i> ([^\n<]+)/g)]
                .map(([, icon, name]) => [name.trim(), icon]);
            expect(icons).toEqual([
                ["../", "arrow_back"],
                ["latest", "link"],
                ["sub dir", "folder"],
                ["clip.mp4", "video_library"],
                ["readme", "insert_drive_file"],
                ["song.mp3", "audiotrack"],
            ]);
        });

        it("escapes file names", async () => {
            const html = await renderFolder({
                path: "/",
                files: [entry("<script>alert(1)</script>", 0o100644)],
            });
            expect(html).not.toContain("<script>alert(1)</script>");
            expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
            expect(html).not.toContain('<a href="../"');
        });
    });
});
