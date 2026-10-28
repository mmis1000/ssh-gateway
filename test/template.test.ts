import { spawnSync } from "child_process";
import { readdir } from "fs/promises";
import { describe, expect, it } from "vitest";
import { CLIENT_TEMPLATE_DIR, readClientTemplate, renderClientScript } from "../src/template";
import { CLIENT_SCRIPT_VERSION } from "../src/ssh_server";
import { User } from "../src/user";

describe("client script template", () => {
    async function rendered() {
        const user = {
            id: "test-user",
            clientKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
            gatewayKeyPub: "ssh-ed25519 AAAA gateway",
        } as User;
        return renderClientScript(await readClientTemplate(), {
            sshHost: "gateway.example",
            sshPort: 2222,
            userListenPortLow: 30020,
            userListenPortHigh: 30099,
        }, user, "[gateway.example]:2222 ssh-ed25519 AAAA");
    }

    it("renders to a script bash can parse", async () => {
        const script = await rendered();
        expect(script.startsWith("#! /bin/bash\n")).toBe(true);
        expect(script).not.toMatch(/\*[A-Z_]+\*/);
        const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
    });

    it("names every part above it, in order", async () => {
        const names = (await readdir(CLIENT_TEMPLATE_DIR)).filter(name => name.endsWith(".sh")).sort();
        const markers = [...(await rendered()).matchAll(/^# ===== (\S+) =====$/gm)].map(match => match[1]);
        expect(markers).toEqual(names.slice(1));
    });

    it("lists every part in the table of contents of the header", async () => {
        const names = (await readdir(CLIENT_TEMPLATE_DIR)).filter(name => name.endsWith(".sh")).sort();
        const listed = [...(await readClientTemplate()).matchAll(/^#   (\S+\.sh) /gm)].map(match => match[1]);
        expect(listed).toEqual(names);
    });

    it("sends the version the gateway hands out", async () => {
        expect(await rendered()).toContain(`\nSCRIPT_VERSION=${CLIENT_SCRIPT_VERSION}\n`);
    });

    it("runs main as the last line", async () => {
        expect((await rendered()).trimEnd().split("\n").pop()).toBe('main "$@"; exit');
    });
});
