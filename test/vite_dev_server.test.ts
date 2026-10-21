import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import { createServer } from "../src/vite_dev_server.mjs";
import { close, listen, request, SETUP_HOST } from "./helpers";

// the dev server loads vite and app/vite.config.ts from the app package
describe("vite dev server", () => {
    let server: http.Server;
    let vite: Awaited<ReturnType<typeof createServer>>;
    let port: number;

    beforeAll(async () => {
        server = http.createServer();
        vite = await createServer(server, [SETUP_HOST]);
        server.on("request", vite.middlewares);
        port = await listen(server);
    });

    afterAll(async () => {
        await vite.close();
        await close(server);
    });

    it("serves the app under /app", async () => {
        const res = await request(port, SETUP_HOST, "/app/");
        expect(res.status).toBe(200);
        expect(res.body).toContain('<div id="app">');
        expect(res.body).toContain("/app/@vite/client");
    });

    it("compiles vue single file components", async () => {
        const res = await request(port, SETUP_HOST, "/app/src/App.vue");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/javascript/);
        expect(res.body).toContain("export default");
    });

    it("blocks hosts other than the setup host", async () => {
        const res = await request(port, "evil.test", "/app/");
        expect(res.status).toBe(403);
    });
});
