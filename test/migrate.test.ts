import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "fs/promises";
import path from "path";
import { migrationTmpDir, openStore, planMigration, runMigration } from "../src/migrate";
import { createTempDir, V1User, writeV1Fixture } from "./helpers";

const mode = async (file: string) => (await stat(file)).mode & 0o777;
const exists = (file: string) => stat(file).then(() => true, () => false);

describe("storage migration", () => {
    let root: string;
    let saveDir: string;
    let legacyDir: string;
    let cleanup: () => Promise<void>;
    let users: V1User[];
    let hostKeys: Record<string, { private: string; public: string }>;
    let logs: string[];
    const log = (msg: string) => logs.push(msg);

    beforeEach(async () => {
        ({ dir: root, cleanup } = await createTempDir());
        saveDir = path.join(root, "save");
        legacyDir = path.join(root, "project");
        ({ users, hostKeys } = await writeV1Fixture(saveDir, legacyDir));
        logs = [];
    });

    afterEach(() => cleanup());

    const backups = async () => (await readdir(root)).filter((name) => name.startsWith("save.backup-v1-"));

    it("plans without changing anything", async () => {
        const plan = await planMigration(saveDir, legacyDir);
        expect(plan!.users.map((user) => user.id).sort()).toEqual(users.map((user) => user.id).sort());
        expect(plan!.hostKeys).toHaveLength(6);
        expect(plan!.warnings).toEqual([]);
        expect(await exists(path.join(saveDir, "domains"))).toBe(true);
        expect(await exists(plan!.tmpDir)).toBe(false);
        expect(await backups()).toEqual([]);
    });

    it("migrates users and host keys to the version 2 layout", async () => {
        const store = await openStore(saveDir, legacyDir, log);

        expect((await readdir(saveDir)).sort()).toEqual(["host_keys", "users", "version"]);
        for (const user of users) {
            const dir = path.join(saveDir, "users", user.id);
            expect(await readFile(path.join(dir, "client_key"), "utf8")).toBe(user.clientKey);
            expect(await readFile(path.join(dir, "client_key.pub"), "utf8")).toBe(user.clientKeyPub);
            expect(await readFile(path.join(dir, "gateway_key"), "utf8")).toBe(user.gatewayKey);
            expect(await readFile(path.join(dir, "gateway_key.pub"), "utf8")).toBe(user.gatewayKeyPub);
            expect(JSON.parse(await readFile(path.join(dir, "user.json"), "utf8"))).toMatchObject({
                id: user.id,
                domain: user.domain,
                password: user.password,
            });
            expect(await mode(dir)).toBe(0o700);
            expect(await mode(path.join(dir, "user.json"))).toBe(0o600);
            expect(await mode(path.join(dir, "gateway_key"))).toBe(0o600);

            const loaded = store.getByDomain(user.domain)!;
            expect(loaded.id).toBe(user.id);
            expect(loaded.clientKey).toBe(user.clientKey);
            expect(loaded.gatewayKeyPub).toBe(user.gatewayKeyPub);
        }

        for (const [type, pair] of Object.entries(hostKeys)) {
            expect(await readFile(path.join(saveDir, "host_keys", `ssh_host_${type}_key`), "utf8")).toBe(pair.private);
            expect(await mode(path.join(saveDir, "host_keys", `ssh_host_${type}_key`))).toBe(0o600);
        }
    });

    it("moves the old files into a backup and leaves the project root clean", async () => {
        await openStore(saveDir, legacyDir, log);

        const [backup] = await backups();
        expect(backup).toBeDefined();
        const backupDir = path.join(root, backup);
        expect((await readdir(backupDir)).sort()).toEqual([...users.map((user) => user.id), "domains", "legacy_host_keys"].sort());
        expect(await readFile(path.join(backupDir, users[0].id, "info.json"), "utf8")).toContain(users[0].password);
        expect((await readdir(path.join(backupDir, "legacy_host_keys"))).length).toBe(6);
        expect(await readdir(legacyDir)).toEqual([]);
        expect(await exists(migrationTmpDir(saveDir))).toBe(false);
        expect(logs.some((msg) => msg.includes("migrated to storage version 2"))).toBe(true);
    });

    it("does nothing on the next start", async () => {
        await openStore(saveDir, legacyDir, log);
        logs = [];
        const store = await openStore(saveDir, legacyDir, log);
        expect(store.size).toBe(users.length);
        expect(await backups()).toHaveLength(1);
        expect(logs).toEqual(["[Store] loaded 2 user(s)"]);
    });

    it("reports inconsistent v1 data and keeps what it cannot migrate in the backup", async () => {
        // index pointing nowhere, index disagreeing with info.json, unknown files, a user without keys
        await writeFile(path.join(saveDir, "domains", "lost-cat-1"), "nobody0000");
        await writeFile(path.join(saveDir, "domains", users[1].domain), users[0].id);
        await writeFile(path.join(saveDir, users[0].id, "notes.txt"), "hi");
        await writeFile(path.join(saveDir, "stray.txt"), "x");
        await mkdir(path.join(saveDir, "nokeys0000"));
        await writeFile(path.join(saveDir, "nokeys0000", "info.json"), JSON.stringify({ id: "nokeys0000", domain: "no-keys-1", password: "p" }));

        const plan = (await planMigration(saveDir, legacyDir))!;
        expect(plan.users.map((user) => user.id).sort()).toEqual(users.map((user) => user.id).sort());
        expect(plan.warnings).toEqual(expect.arrayContaining([
            expect.stringContaining(`domains/lost-cat-1: points to unknown user nobody0000`),
            expect.stringContaining(`${users[1].id}: domains/${users[1].domain} points to ${users[0].id}, using info.json`),
            expect.stringContaining(`${users[0].id}: unknown files notes.txt`),
            expect.stringContaining("stray.txt: not a user directory"),
            expect.stringContaining("nokeys0000: skipped, missing private_key"),
        ]));

        await runMigration(plan, log);
        const store = await openStore(saveDir, legacyDir, log);
        expect(store.getByDomain(users[1].domain)?.id).toBe(users[1].id);
        expect(store.getById("nokeys0000")).toBeUndefined();
        expect(await readFile(path.join(plan.backupDir, "nokeys0000", "info.json"), "utf8")).toContain("no-keys-1");
    });

    it("finishes a migration interrupted after the old directory was moved away", async () => {
        // the state after a crash between "save -> backup" and "tmp -> save"
        await openStore(saveDir, legacyDir, log);
        await rename(saveDir, migrationTmpDir(saveDir));
        logs = [];

        expect(await exists(saveDir)).toBe(false);
        const store = await openStore(saveDir, legacyDir, log);
        expect(logs).toContain("[Store] finished an interrupted migration");
        expect(store.size).toBe(users.length);
    });

    it("redoes a migration whose temporary directory was left incomplete", async () => {
        await mkdir(migrationTmpDir(saveDir));
        await writeFile(path.join(migrationTmpDir(saveDir), "partial"), "x");

        const store = await openStore(saveDir, legacyDir, log);
        expect(logs).toContain("[Store] removed an incomplete migration, it will run again");
        expect(store.size).toBe(users.length);
        expect(await exists(migrationTmpDir(saveDir))).toBe(false);
    });

    it("moves host keys of an install that never created a user", async () => {
        const fresh = path.join(root, "fresh-save");
        const store = await openStore(fresh, legacyDir, log);
        expect(store.size).toBe(0);
        expect((await readdir(path.join(fresh, "host_keys"))).length).toBe(6);
        expect(await readdir(legacyDir)).toEqual([]);
    });

    it("creates an empty store when there is nothing to migrate", async () => {
        const fresh = path.join(root, "fresh-save");
        const store = await openStore(fresh, path.join(root, "empty-project"), log);
        expect(store.size).toBe(0);
        expect(logs).toContain(`[Store] created a new store at ${fresh}`);
        expect((await readdir(root)).filter((name) => name.startsWith("fresh-save.backup"))).toEqual([]);
    });

    it("refuses storage from a newer version", async () => {
        await openStore(saveDir, legacyDir, log);
        await writeFile(path.join(saveDir, "version"), "3\n");
        await expect(openStore(saveDir, legacyDir, log)).rejects.toThrow(/storage version 3/);
    });

    it("warns about host keys left in the project root", async () => {
        await openStore(saveDir, legacyDir, log);
        await writeFile(path.join(legacyDir, "ssh_host_rsa_key"), hostKeys.rsa.private);
        logs = [];
        await openStore(saveDir, legacyDir, log);
        expect(logs.some((msg) => msg.includes("ssh_host_rsa_key") && msg.includes("are not used"))).toBe(true);
    });
});
