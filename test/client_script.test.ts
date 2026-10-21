import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChildProcess, execFile, execFileSync, spawn } from "child_process";
import { readFile, writeFile } from "fs/promises";
import net from "net";
import path from "path";
import { renderClientScript } from "../src/http_server";
import { knownHostsLines, loadHostKeys } from "../src/keys";
import { createSshServer } from "../src/ssh_server";
import { UserStore } from "../src/store";
import { User } from "../src/user";
import { createConfig, createTempDir, openTestStore } from "./helpers";

// Runs the real run.sh in a pseudo terminal (util-linux `script`), types the answers like a
// user and checks what is left after ctrl+c, closing the terminal, kill and so on.

const hasScript = (() => {
    try {
        execFileSync("script", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
})();

const pgrep = (pattern: string, exact = false) => new Promise<number[]>((resolve) => {
    execFile("pgrep", [exact ? "-fx" : "-f", pattern], (_err, stdout) => resolve(stdout.split("\n").filter(Boolean).map(Number)));
});

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 20000, what = "condition") {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!hasScript)("client script", () => {
    let root: string;
    let home: string;
    let cleanup: () => Promise<void>;
    let store: UserStore;
    let sshServer: ReturnType<typeof createSshServer>;
    let sshPort: number;
    let target: net.Server;
    let targetPort: number;
    const terminals: ChildProcess[] = [];

    beforeAll(async () => {
        ({ dir: root, cleanup } = await createTempDir());
        home = path.join(root, "home");
        const saveDir = path.join(root, "save");
        store = await openTestStore(saveDir);
        const hostKeys = await loadHostKeys(store.hostKeyDir, () => {});
        sshServer = createSshServer(createConfig(saveDir), store, hostKeys);
        sshPort = await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", () => resolve((sshServer.address() as net.AddressInfo).port)));
        // something to forward, the gateway never connects to it in these tests
        target = net.createServer((socket) => socket.end());
        targetPort = await new Promise((resolve) => target.listen(0, "127.0.0.1", () => resolve((target.address() as net.AddressInfo).port)));
    });

    afterAll(async () => {
        terminals.forEach((terminal) => terminal.kill("SIGKILL"));
        // nothing a test started may survive it
        for (const pid of await pgrep(home)) {
            try { process.kill(pid, "SIGKILL"); } catch {}
        }
        await new Promise((resolve) => sshServer.close(resolve));
        await new Promise((resolve) => target.close(resolve));
        await cleanup();
    });

    const workDir = (user: User) => path.join(home, ".gateway-mmis1000", user.id!);
    const masters = (user: User) => pgrep(`ssh -N -M .*${workDir(user)}/control.sock`);
    const sshds = (user: User) => pgrep(`sshd -D -f ${workDir(user)}/sshd_config`);

    async function writeScript(user: User) {
        const template = await readFile(path.resolve(__dirname, "../template/script.template"), "utf8");
        const knownHosts = (await knownHostsLines(store.hostKeyDir, "127.0.0.1", sshPort)).join("\n");
        const file = path.join(root, `run-${user.id}.sh`);
        await writeFile(file, renderClientScript(template, {
            sshHost: "127.0.0.1",
            sshPort,
            userListenPortLow: 30020,
            userListenPortHigh: 30099,
        }, user, knownHosts));
        return file;
    }

    /** start run.sh in a terminal and answer its questions, resolves once the tunnel is up */
    async function start(user: User, scriptFile: string, options: { folder?: boolean; command?: string } = {}) {
        const command = options.command ?? `bash ${scriptFile}`;
        // a new pty has no size, the line editor of the port question would scroll it sideways
        const terminal = spawn("script", ["-qfec", `stty cols 200 rows 50; ${command}`, "/dev/null"], {
            cwd: root,
            env: { ...process.env, HOME: home },
            stdio: ["pipe", "pipe", "pipe"],
        });
        terminals.push(terminal);
        let output = "";
        terminal.stdout!.on("data", (chunk) => (output += chunk));
        terminal.stderr!.on("data", (chunk) => (output += chunk));
        const type = (text: string) => terminal.stdin!.write(text);
        const prompt = (text: string) => waitFor(() => output.includes(text), 20000, `"${text}" in the output:\n${output}`);

        await prompt("press any key");
        type("y");
        await prompt("http entry");
        // the answer is prefilled with 8080, clear it first
        type(`\x15${options.folder ? 0 : targetPort}\r`);
        if (options.folder) {
            await prompt("static directory");
            type(`\x15${root}\r`);
        }
        await prompt("starting to check alive");
        await waitFor(() => user.tunnelConnection !== null, 10000, "the tunnel");

        const [scriptPid] = await pgrep(`bash ${scriptFile}`, true);
        expect(scriptPid).toBeGreaterThan(0);
        return { terminal, scriptPid, type, output: () => output };
    }

    async function expectStopped(user: User, scriptPid: number) {
        await waitFor(async () => {
            // the script and its watchdog subshell, not a parent script that mentions the file
            const running = await pgrep(`bash ${path.join(root, `run-${user.id}.sh`)}`, true);
            return running.length === 0 && (await masters(user)).length === 0 && user.tunnelConnection === null;
        }, 15000, "the script, its watchdog, its tunnel and the gateway side of it to go away");
        expect(scriptPid).toBeGreaterThan(0);
    }

    // the script sleeps about 6 s before the tunnel is up
    describe.concurrent("stopping", { timeout: 60000 }, () => {
        it.each([
            ["ctrl+c", "\x03"],
            ["ctrl+\\", "\x1c"],
        ])("cleans up on %s", async (_, key) => {
            const user = await store.create();
            const run = await start(user, await writeScript(user));
            run.type(key);
            await expectStopped(user, run.scriptPid);
            expect(run.output()).toContain("Exited!");
        });

        it("cleans up when the terminal is closed", async () => {
            const user = await store.create();
            const run = await start(user, await writeScript(user));
            // the terminal emulator going away hangs up the session
            run.terminal.kill("SIGKILL");
            await expectStopped(user, run.scriptPid);
        });

        it("cleans up on kill", async () => {
            const user = await store.create();
            const run = await start(user, await writeScript(user));
            process.kill(run.scriptPid, "SIGTERM");
            await expectStopped(user, run.scriptPid);
            expect(run.output()).toContain("Exited!");
        });

        it("leaves the script that started it alone", async () => {
            // kill 0 used to take the whole process group down, including a parent script
            const user = await store.create();
            const scriptFile = await writeScript(user);
            const run = await start(user, scriptFile, { command: `bash -c 'bash ${scriptFile}; echo PARENT-CONTINUES'` });
            process.kill(run.scriptPid, "SIGTERM");
            await expectStopped(user, run.scriptPid);
            await waitFor(() => run.output().includes("PARENT-CONTINUES"), 5000, "the parent script to continue");
        });

        it.each([
            ["port", false],
            ["folder", true],
        ])("cleans up after kill -9 of the script in %s mode", async (_, folder) => {
            const user = await store.create();
            const run = await start(user, await writeScript(user), { folder });
            if (folder) expect(await sshds(user)).toHaveLength(1);

            // traps do not run on -9, the watchdog notices within a few seconds
            process.kill(run.scriptPid, "SIGKILL");
            await expectStopped(user, run.scriptPid);
            await waitFor(async () => (await sshds(user)).length === 0, 10000, "the sshd to stop");
        });

        it.each([
            ["port", false],
            ["folder", true],
        ])("next start removes what a run killed together with its watchdog left in %s mode", async (_, folder) => {
            const user = await store.create();
            const scriptFile = await writeScript(user);
            const first = await start(user, scriptFile, { folder });
            const [oldMaster] = await masters(user);
            const [oldSshd] = await sshds(user);
            expect(oldMaster).toBeGreaterThan(0);
            if (folder) expect(oldSshd).toBeGreaterThan(0);

            // the script and its watchdog subshell share the command line
            for (const pid of await pgrep(`bash ${scriptFile}`, true)) process.kill(pid, "SIGKILL");
            first.terminal.kill("SIGKILL");
            await new Promise((resolve) => setTimeout(resolve, 3000));
            expect(await masters(user)).toContain(oldMaster);
            if (folder) expect(await sshds(user)).toContain(oldSshd);

            const second = await start(user, scriptFile, { folder });
            expect(await masters(user)).not.toContain(oldMaster);
            if (folder) {
                const running = await sshds(user);
                expect(running).not.toContain(oldSshd);
                expect(running).toHaveLength(1);
            }
            second.type("\x03");
            await expectStopped(user, second.scriptPid);
            expect(await sshds(user)).toEqual([]);
        });
    });
});
