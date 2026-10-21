import http from "http";
import os from "os";
import path from "path";
import { mkdtemp, rm } from "fs/promises";
import { AddressInfo } from "net";
import { Config } from "../src/interface";

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
    options: { method?: string; auth?: string; headers?: http.OutgoingHttpHeaders } = {}
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
        req.end();
    });
}
