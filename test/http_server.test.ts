import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import path from "path";
import type { Express } from "express";
import { createHttpServer } from "../src/http_server";
import { folderView } from "../src/listing";
import { loadHostKeys } from "../src/keys";
import WebSocket from "ws";
import { close, createConfig, createTempDir, HTTP_HOST, listen, openInspector, openTestStore, request, SETUP_HOST } from "./helpers";


const basicAuth = (account: string, password: string) =>
    `Basic ${Buffer.from(`${account}:${password}`).toString("base64")}`;

describe("http server", () => {
    let router: Express;
    let server: http.Server;
    let port: number;
    let saveDir: string;
    let hostKeyDir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
        const temp = await createTempDir();
        cleanup = temp.cleanup;
        saveDir = path.join(temp.dir, "save");
        const store = await openTestStore(saveDir);
        await loadHostKeys(store.hostKeyDir, () => {});
        hostKeyDir = store.hostKeyDir;
        ({ router, server } = await createHttpServer(createConfig(saveDir), store));
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
            expect(res.body).toContain(`http://brave-otter-42-k3x9qz.${HTTP_HOST}/`);
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

            // hardened client: pinned host keys, no agent or X11 forwarding, only the issued key
            for (const type of ["rsa", "ecdsa", "ed25519"]) {
                const [keyType, key] = (await readFile(path.join(hostKeyDir, `ssh_host_${type}_key.pub`), "utf8")).split(" ");
                expect(setup.body).toContain(`[${SETUP_HOST}]:2222 ${keyType} ${key}`);
            }
            expect(setup.body).toContain('-a -x -o "IdentitiesOnly yes"');
            expect(setup.body).toContain('-o "StrictHostKeyChecking yes"');
            expect(setup.body).not.toContain("StrictHostKeyChecking no");
            expect(setup.body).toContain('"v8: register');
            expect(setup.body).toContain('"v8: check"');
            expect(setup.body).toContain("ForceCommand internal-sftp -R");
            expect(setup.body).toContain("PermitOpen localhost:* 127.0.0.1:*");

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

    describe("setup password with special characters", () => {
        it("accepts colons and percent signs in the password", async () => {
            const temp = await createTempDir();
            const otherSave = path.join(temp.dir, "save");
            const store = await openTestStore(otherSave);
            await loadHostKeys(store.hostKeyDir, () => {});
            const config = createConfig(otherSave, { setupPassword: "se:cr%et" });
            const { server: otherServer } = await createHttpServer(config, store);
            const otherPort = await listen(otherServer);
            try {
                const setup = (password: string) => request(otherPort, SETUP_HOST, "/setup", {
                    method: "POST",
                    headers: { Authorization: basicAuth("admin", password) },
                });
                expect((await setup("se:cr%et")).status).toBe(200);
                // used to be cut at the second colon
                expect((await setup("se")).status).toBe(401);
                expect((await setup("se:cr%et:")).status).toBe(401);
            } finally {
                await close(otherServer);
                await temp.cleanup();
            }
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

        it("fails for unknown user domains, with a page for browsers and text for tools", async () => {
            const res = await request(port, `no-such-user.${HTTP_HOST}`, "/index.html");
            expect(res.status).toBe(404);
            expect(res.headers["content-type"]).toMatch(/^text\/plain/);
            expect(res.body).toBe("Nothing is shared here\nNo one is sharing anything at this address.\n");

            const page = await request(port, `no-such-user.${HTTP_HOST}`, "/index.html", { headers: { Accept: "text/html,*/*;q=0.8" } });
            expect(page.status).toBe(404);
            expect(page.headers["content-type"]).toMatch(/^text\/html/);
            expect(page.headers["cache-control"]).toBe("no-store");
            expect(page.body).toContain("<h1>Nothing is shared here</h1>");
            // self contained, it is served on user domains
            expect(page.body).not.toMatch(/<(script|link)[^>]+(src|href)=/);
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
        const entry = (filename: string, mode: number, size = 0) => ({ filename, attrs: { mode, size, mtime: 1760000000 } });

        const renderFolder = (requestPath: string, files: ReturnType<typeof entry>[]) =>
            new Promise<string>((resolve, reject) => {
                const view = folderView(requestPath, files, { siteName: "brave-otter-42-k3x9qz", showHidden: false });
                router.render("folder", view, (err, html) => (err ? reject(err) : resolve(html!)));
            });

        it("renders breadcrumbs, a parent link and one row per entry", async () => {
            const html = await renderFolder("/music/live set/", [
                entry("song.mp3", 0o100644, 5_100_000),
                entry("sub dir", 0o40755),
                entry("clip.mp4", 0o100644),
                entry("readme", 0o100644),
                entry("latest", 0o120777),
            ]);

            expect(html).toContain('<li><a href="/">brave-otter-42-k3x9qz</a></li>');
            expect(html).toContain('<li><a href="/music/">music</a></li>');
            expect(html).toContain('<li aria-current="page">live set</li>');
            expect(html).toContain('<a class="row folder" href="/music/">');

            const rows = [...html.matchAll(/<a class="row (\w+)" href="([^"]+)"[^>]*>\s*<span class="name"><svg aria-hidden="true"><use href="#i-(\w+)"\/><\/svg><span>([^<]+)<\/span>/g)]
                .map(([, kind, href, icon, name]) => [name, kind, icon, href]);
            expect(rows).toEqual([
                ["Parent folder", "folder", "parent", "/music/"],
                ["sub dir", "folder", "folder", "/music/live%20set/sub%20dir/"],
                ["clip.mp4", "file", "video", "/music/live%20set/clip.mp4"],
                ["latest", "link", "link", "/music/live%20set/latest"],
                ["readme", "file", "file", "/music/live%20set/readme"],
                ["song.mp3", "file", "audio", "/music/live%20set/song.mp3"],
            ]);
            expect(html).toContain('<span class="size">4.9 MB</span>');
            // a symlink is told apart from a file by more than its icon, and only it gets the tag
            expect(html).toMatch(/title="Symbolic link[^"]*">\s*<span class="name">.*<span>latest<\/span><span class="tag">symlink<\/span>/);
            expect(html.match(/class="tag"/g)).toHaveLength(1);
            expect(html).toContain('<time datetime="2025-10-09T08:53:20.000Z">2025-10-09 08:53 UTC</time>');
        });

        it("has no parent link at the top and says when a folder is empty", async () => {
            const html = await renderFolder("/", []);
            expect(html).toContain('<li aria-current="page">brave-otter-42-k3x9qz</li>');
            expect(html).not.toContain("Parent folder");
            expect(html).toContain("This folder is empty.");
        });

        it("escapes file names", async () => {
            const html = await renderFolder("/", [entry("<script>alert(1)</script>", 0o100644)]);
            expect(html).not.toContain("<script>alert(1)</script>");
            expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        });

        it("is self contained, it is served on user domains", async () => {
            const html = await renderFolder("/", [entry("a.txt", 0o100644)]);
            expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=/);
            expect(html).not.toMatch(/https?:\/\//);
        });
    });
});
