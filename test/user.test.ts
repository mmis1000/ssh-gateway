import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import { createUser, getUserWithDomain, getUserWithName, User } from "../src/user";
import { createTempDir } from "./helpers";

// covers the fs-extra calls (ensureDir, outputFile, outputJson, readJson, readFile)
describe("user storage", () => {
    let saveDir: string;
    let cleanup: () => Promise<void>;
    let created: User;

    beforeAll(async () => {
        ({ dir: saveDir, cleanup } = await createTempDir());
        created = await createUser(saveDir);
    });

    afterAll(() => cleanup());

    it("writes the user directory with info and key pairs", async () => {
        const dataDir = path.resolve(saveDir, created.id!);
        expect((await readdir(dataDir)).sort()).toEqual([
            "info.json",
            "private_key",
            "private_key.pub",
            "public_key",
            "public_key.pub",
        ]);

        const info = JSON.parse(await readFile(path.resolve(dataDir, "info.json"), "utf8"));
        expect(info).toEqual({
            id: created.id,
            domain: created.domainName,
            password: created.password,
        });
    });

    it("writes the domain to id mapping", async () => {
        const mapping = path.resolve(saveDir, "domains", created.domainName!);
        expect((await stat(mapping)).isFile()).toBe(true);
        expect(await readFile(mapping, "utf8")).toBe(created.id);
    });

    it("loads keys into the user", () => {
        expect(created.privateKey).toContain("PRIVATE KEY");
        expect(created.publicKey_pub).toMatch(/^ecdsa-sha2-/);
    });

    it("finds the user by name and by domain", async () => {
        const byName = await getUserWithName(saveDir, created.id!);
        const byDomain = await getUserWithDomain(saveDir, created.domainName!);
        expect(byName.id).toBe(created.id);
        expect(byDomain.id).toBe(created.id);
        expect(byDomain.password).toBe(created.password);
    });

    it("rejects unknown users", async () => {
        await expect(getUserWithName(saveDir, "no-such-user")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(getUserWithDomain(saveDir, "no-such-domain")).rejects.toMatchObject({ code: "ENOENT" });
    });
});
