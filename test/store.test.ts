import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import { utils } from "ssh2";
import { STORE_VERSION, UserStore } from "../src/store";
import { User } from "../src/user";
import { createTempDir, openTestStore } from "./helpers";

const mode = async (file: string) => (await stat(file)).mode & 0o777;

describe("UserStore", () => {
    let saveDir: string;
    let cleanup: () => Promise<void>;
    let store: UserStore;
    let created: User;

    beforeAll(async () => {
        const temp = await createTempDir();
        cleanup = temp.cleanup;
        saveDir = path.join(temp.dir, "save");
        store = await openTestStore(saveDir);
        created = await store.create();
    });

    afterAll(() => cleanup());

    it("creates the version 2 layout in a new directory", async () => {
        expect((await readFile(path.join(saveDir, "version"), "utf8")).trim()).toBe(String(STORE_VERSION));
        expect((await readdir(saveDir)).sort()).toEqual(["host_keys", "users", "version"]);
        expect(await mode(path.join(saveDir, "users"))).toBe(0o700);
    });

    it("writes the user directory with private permissions", async () => {
        const dir = path.join(saveDir, "users", created.id!);
        expect((await readdir(dir)).sort()).toEqual(["client_key", "client_key.pub", "gateway_key", "gateway_key.pub", "user.json"]);
        expect(await mode(dir)).toBe(0o700);
        expect(await mode(path.join(dir, "user.json"))).toBe(0o600);
        expect(await mode(path.join(dir, "client_key"))).toBe(0o600);
        expect(await mode(path.join(dir, "gateway_key"))).toBe(0o600);
        expect(await mode(path.join(dir, "client_key.pub"))).toBe(0o644);

        const record = JSON.parse(await readFile(path.join(dir, "user.json"), "utf8"));
        expect(record).toEqual({
            id: created.id,
            domain: created.domainName,
            password: created.password,
            socksPassword: created.socksPassword,
            createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        });
        expect(created.id).toMatch(/^[a-z0-9]{10}$/);
        expect(created.password).toMatch(/^[a-z0-9]{16}$/);
        expect(created.socksPassword).toMatch(/^[a-z0-9]{16}$/);
        expect(created.socksPassword).not.toBe(created.password);
        expect(created.domainName).toMatch(/^[a-z]+-[a-z]+-\d+-[a-z0-9]{6}$/);
    });

    it("generates matching ed25519 key pairs without ssh-keygen", () => {
        for (const [privateKey, publicKey] of [
            [created.clientKey!, created.clientKeyPub!],
            [created.gatewayKey!, created.gatewayKeyPub!],
        ]) {
            const parsedPrivate = utils.parseKey(privateKey);
            const parsedPublic = utils.parseKey(publicKey);
            if (parsedPrivate instanceof Error || parsedPublic instanceof Error) throw new Error("bad key");
            expect(parsedPrivate.type).toBe("ssh-ed25519");
            expect(parsedPrivate.getPublicSSH().equals(parsedPublic.getPublicSSH())).toBe(true);
        }
        expect(created.clientKey).not.toBe(created.gatewayKey);
    });

    it("finds users by id and domain, also after reloading", async () => {
        expect(store.getById(created.id)).toBe(created);
        expect(store.getByDomain(created.domainName)).toBe(created);

        const reloaded = await openTestStore(saveDir);
        expect(reloaded.getById(created.id)?.password).toBe(created.password);
        expect(reloaded.getByDomain(created.domainName)?.clientKey).toBe(created.clientKey);
    });

    it.each([
        ["path traversal", "../save"],
        ["the users directory", "users"],
        ["the old domains directory", "domains"],
        ["upper case", "ABCDEF1234"],
        ["empty", ""],
        ["non string", { toString: (): string => "x" }],
    ])("treats %s as unknown", async (_, name) => {
        expect(store.getById(name)).toBeUndefined();
        expect(store.getByDomain(name)).toBeUndefined();
        await expect(store.findById(name)).rejects.toThrow(/unknown user/);
    });

    it("creates unique users", async () => {
        const users = await Promise.all(Array.from({ length: 5 }, () => store.create()));
        expect(new Set(users.map((user) => user.id)).size).toBe(5);
        expect(new Set(users.map((user) => user.domainName)).size).toBe(5);
    });

    it("gives users from before the SOCKS5 password one and keeps it", async () => {
        const user = await store.create();
        const file = path.join(saveDir, "users", user.id!, "user.json");
        const { socksPassword: _, ...oldRecord } = JSON.parse(await readFile(file, "utf8"));
        await writeFile(file, JSON.stringify(oldRecord));

        const logs: string[] = [];
        const reloaded = new UserStore(saveDir, (msg) => logs.push(msg));
        await reloaded.load();
        const added = reloaded.getById(user.id)!.socksPassword;
        expect(added).toMatch(/^[a-z0-9]{16}$/);
        expect(added).not.toBe(user.password);
        expect(logs).toContain(`${user.id}: [Store] added a SOCKS5 password, the old one stops working for SOCKS5`);

        const saved = JSON.parse(await readFile(file, "utf8"));
        expect(saved).toEqual({ ...oldRecord, socksPassword: added });
        expect(await mode(file)).toBe(0o600);
        expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
        expect((await openTestStore(saveDir)).getById(user.id)!.socksPassword).toBe(added);
    });

    it("keeps the highest script version a user registered with, also after reloading", async () => {
        const user = await store.create();
        const file = path.join(saveDir, "users", user.id!, "user.json");
        // records from before it was kept have none
        expect(JSON.parse(await readFile(file, "utf8")).highestScriptVersion).toBeUndefined();
        expect(user.highestScriptVersion).toBe(0);

        await store.noteScriptVersion(user, 9);
        await store.noteScriptVersion(user, 7);
        await Promise.all([store.noteScriptVersion(user, 11), store.noteScriptVersion(user, 10)]);
        expect(user.highestScriptVersion).toBe(11);
        expect(JSON.parse(await readFile(file, "utf8")).highestScriptVersion).toBe(11);
        expect(await mode(file)).toBe(0o600);
        expect((await openTestStore(saveDir)).getById(user.id)!.highestScriptVersion).toBe(11);
    });

    it("skips broken user directories and leftover temporary directories", async () => {
        await mkdir(path.join(saveDir, "users", "brokenuser"));
        await writeFile(path.join(saveDir, "users", "brokenuser", "user.json"), "{ not json");
        await mkdir(path.join(saveDir, "users", ".tmp-abandoned"));

        const logs: string[] = [];
        const reloaded = new UserStore(saveDir, (msg) => logs.push(msg));
        await reloaded.load();
        expect(reloaded.size).toBe(store.size);
        expect(reloaded.getById("brokenuser")).toBeUndefined();
        expect(logs.some((msg) => msg.includes("skipped user brokenuser"))).toBe(true);
        expect(logs.some((msg) => msg.includes(".tmp-abandoned"))).toBe(false);
    });
});
