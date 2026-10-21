import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { readdir, readFile, stat, unlink } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { utils } from "ssh2";
import { fingerprint, generateKeyPair, loadHostKeys } from "../src/keys";
import { createTempDir } from "./helpers";

const mode = async (file: string) => (await stat(file)).mode & 0o777;

describe("loadHostKeys", () => {
    let dir: string;
    let cleanup: () => Promise<void>;
    let logs: string[];

    beforeAll(async () => {
        const temp = await createTempDir();
        cleanup = temp.cleanup;
        dir = path.join(temp.dir, "host_keys");
        logs = [];
    });

    afterAll(() => cleanup());

    it("generates all host keys when none exist", async () => {
        const keys = await loadHostKeys(dir, (msg) => logs.push(msg));
        expect((await readdir(dir)).sort()).toEqual([
            "ssh_host_ecdsa_key", "ssh_host_ecdsa_key.pub",
            "ssh_host_ed25519_key", "ssh_host_ed25519_key.pub",
            "ssh_host_rsa_key", "ssh_host_rsa_key.pub",
        ]);
        expect(await mode(dir)).toBe(0o700);
        expect(await mode(path.join(dir, "ssh_host_rsa_key"))).toBe(0o600);
        expect(await mode(path.join(dir, "ssh_host_rsa_key.pub"))).toBe(0o644);

        expect(keys.map((key) => (utils.parseKey(key) as any).type)).toEqual(["ssh-rsa", "ecdsa-sha2-nistp256", "ssh-ed25519"]);
        expect(logs).toHaveLength(3);
        expect(logs[0]).toMatch(/generated rsa host key SHA256:/);
    });

    it("keeps existing keys", async () => {
        const before = await readFile(path.join(dir, "ssh_host_ed25519_key"));
        logs.length = 0;
        const keys = await loadHostKeys(dir, (msg) => logs.push(msg));
        expect(keys[2].equals(before)).toBe(true);
        expect(logs).toEqual([]);
    });

    it("only generates the missing ones", async () => {
        const rsa = await readFile(path.join(dir, "ssh_host_rsa_key"));
        await unlink(path.join(dir, "ssh_host_ecdsa_key"));
        await unlink(path.join(dir, "ssh_host_ecdsa_key.pub"));
        logs.length = 0;
        const keys = await loadHostKeys(dir, (msg) => logs.push(msg));
        expect(keys[0].equals(rsa)).toBe(true);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatch(/generated ecdsa host key/);
    });

    it("prints fingerprints like ssh-keygen", async () => {
        const pub = path.join(dir, "ssh_host_ed25519_key.pub");
        const { stdout } = await promisify(execFile)("ssh-keygen", ["-lf", pub]);
        expect(stdout.split(" ")[1]).toBe(fingerprint(await readFile(pub, "utf8")));
    });
});

describe("generateKeyPair", () => {
    // ssh2 drops a leading zero byte of ed25519 keys, about 1 in 256 keys came out malformed
    it("only returns keys that parse, over many ed25519 keys", async () => {
        const pairs = await Promise.all(Array.from({ length: 1500 }, () => generateKeyPair("ed25519", "test")));
        const broken = pairs.filter((pair) => {
            const parsedPrivate = utils.parseKey(pair.private);
            const parsedPublic = utils.parseKey(pair.public);
            return parsedPrivate instanceof Error || parsedPublic instanceof Error
                || !parsedPrivate.getPublicSSH().equals(parsedPublic.getPublicSSH());
        });
        expect(broken).toHaveLength(0);
    });
});
