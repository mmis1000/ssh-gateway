import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChildProcess, execFile, execFileSync, spawn } from "child_process";
import { mkdir, readFile, writeFile } from "fs/promises";
import os from "os";
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
        // a space in the home directory exercises the quoting in the script
        home = path.join(root, "fake home");
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

    async function writeScript(user: User, options: { portRange?: [number, number] } = {}) {
        const template = await readFile(path.resolve(__dirname, "../template/script.template"), "utf8");
        const knownHosts = (await knownHostsLines(store.hostKeyDir, "127.0.0.1", sshPort)).join("\n");
        const file = path.join(root, `run-${user.id}.sh`);
        await writeFile(file, renderClientScript(template, {
            sshHost: "127.0.0.1",
            sshPort,
            userListenPortLow: options.portRange?.[0] ?? 30020,
            userListenPortHigh: options.portRange?.[1] ?? 30099,
        }, user, knownHosts));
        return file;
    }

    interface StartOptions {
        folder?: boolean;
        command?: string;
        env?: Record<string, string | undefined>;
        /** answers to the port question, the last one must be valid */
        portAnswers?: string[];
        /** answers to the directory question in folder mode, the last one must be valid */
        dirAnswers?: string[];
        /** resolve after the answers instead of waiting for the tunnel */
        noWait?: boolean;
    }

    /** start run.sh in a terminal and answer its questions, resolves once the tunnel is up */
    async function start(user: User, scriptFile: string, options: StartOptions = {}) {
        const command = options.command ?? `bash '${scriptFile}'`;
        // a new pty has no size, the line editor of the port question would scroll it sideways
        const terminal = spawn("script", ["-qfec", `stty cols 200 rows 50; ${command}`, "/dev/null"], {
            cwd: root,
            env: { ...process.env, HOME: home, ...options.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        terminals.push(terminal);
        let output = "";
        terminal.stdout!.on("data", (chunk) => (output += chunk));
        terminal.stderr!.on("data", (chunk) => (output += chunk));
        const type = (text: string) => terminal.stdin!.write(text);
        const count = (text: string) => output.split(text).length - 1;
        const prompt = (text: string, times = 1) => waitFor(() => count(text) >= times, 20000, `"${text}" in the output:\n${output}`);

        await prompt("press any key");
        type("y");
        // answers are prefilled (8080, the current directory), clear them first. The line editor
        // redraws the question when typing, so count the complaints to know a question is asked again
        const answer = async (question: string, complaint: string, answers: string[]) => {
            for (const [index, text] of answers.entries()) {
                if (index === 0) await prompt(question);
                else await prompt(complaint, index);
                await new Promise((resolve) => setTimeout(resolve, 300));
                type(`\x15${text}\r`);
            }
        };
        await answer("http entry", "Please enter a port number", options.portAnswers ?? [String(options.folder ? 0 : targetPort)]);
        if (options.folder) await answer("static directory", "is not a directory.", options.dirAnswers ?? [root]);
        if (options.noWait) return { terminal, scriptPid: 0, type, output: () => output, prompt };
        await prompt("Tunnel is up. Press Ctrl+C to stop.");
        await waitFor(() => user.tunnelConnection !== null, 10000, "the tunnel");

        const [scriptPid] = await pgrep(`bash ${scriptFile}`, true);
        expect(scriptPid).toBeGreaterThan(0);
        return { terminal, scriptPid, type, output: () => output, prompt };
    }

    async function expectStopped(user: User, scriptPid: number) {
        await waitFor(async () => {
            // the script and its watchdog subshell, not a parent script that mentions the file
            const running = await pgrep(`bash ${path.join(root, `run-${user.id}.sh`)}`, true);
            return running.length === 0 && (await masters(user)).length === 0 && user.tunnelConnection === null;
        }, 15000, "the script, its watchdog, its tunnel and the gateway side of it to go away");
        expect(scriptPid).toBeGreaterThan(0);
    }

    describe.concurrent("output", { timeout: 60000 }, () => {
        it("stays quiet while the tunnel is fine", async () => {
            const user = await store.create();
            const run = await start(user, await writeScript(user));
            await new Promise((resolve) => setTimeout(resolve, 500));
            const settled = run.output();
            expect(settled).toContain("Client accepted.");
            expect(settled).not.toMatch(/Not all processes could be identified|Master running/);

            // the script checks the tunnel every second, none of it may show up
            await new Promise((resolve) => setTimeout(resolve, 4000));
            expect(run.output()).toBe(settled);
            run.type("\x03");
            await expectStopped(user, run.scriptPid);
        });

        it.each([
            ["port", false],
            ["folder", true],
        ])("reports a lost connection once and reconnects in %s mode", async (_, folder) => {
            const user = await store.create();
            const run = await start(user, await writeScript(user), { folder });
            const [sshd] = await sshds(user);
            const before = run.output().length;

            // the gateway drops the connection, like a network outage would
            user.tunnelConnection!.end();
            await waitFor(() => run.output().slice(before).includes("Tunnel is up. Press Ctrl+C to stop."), 30000, "the script to reconnect");
            await waitFor(() => user.tunnelConnection !== null, 10000, "the new tunnel");

            const printed = run.output().slice(before).replace(/\r/g, "").trim().split("\n");
            expect(printed).toEqual([
                expect.stringMatching(/^Connection lost, reconnecting\.\.\. \(details in .*reconnect\.log\)$/),
                "Tunnel is up. Press Ctrl+C to stop.",
            ]);
            // only the connection is replaced, the local sshd keeps serving the folder
            if (folder) expect(await sshds(user)).toEqual([sshd]);

            run.type("\x03");
            await expectStopped(user, run.scriptPid);
        });
    });

    describe.concurrent("setup", { timeout: 60000 }, () => {
        it("asks again for a wrong port or directory", async () => {
            const user = await store.create();
            const run = await start(user, await writeScript(user), {
                folder: true,
                portAnswers: ["http", "70000", "0"],
                dirAnswers: [path.join(root, "missing"), "~"],
            });
            expect(run.output()).toContain("Please enter a port number between 1 and 65535, or 0.");
            expect(run.output()).toContain(`${path.join(root, "missing")} is not a directory.`);
            // ~ is expanded to the home directory
            expect(user.staticDirectory).toBe(home);
            run.type("\x03");
            await expectStopped(user, run.scriptPid);
        });

        it("gives up when no port is free", async () => {
            const user = await store.create();
            const busy = net.createServer();
            const port = await new Promise<number>((resolve) => busy.listen(0, "127.0.0.1", () => resolve((busy.address() as net.AddressInfo).port)));
            try {
                // the only port in the range is taken, every attempt fails to bind
                const run = await start(user, await writeScript(user, { portRange: [port, port] }), { folder: true, noWait: true });
                await run.prompt("Could not start sshd");
                let exited = run.terminal.exitCode !== null;
                run.terminal.on("exit", () => (exited = true));
                await waitFor(() => exited, 15000, `the script to exit, output:\n${run.output()}`);
                expect(run.output()).not.toContain("Tunnel is up");
                expect(await sshds(user)).toEqual([]);
            } finally {
                busy.close();
            }
        });

        it("works without $USER", async () => {
            const user = await store.create();
            const run = await start(user, await writeScript(user), { env: { USER: undefined } });
            expect(user.remoteUser).toBe(os.userInfo().username);
            run.type("\x03");
            await expectStopped(user, run.scriptPid);
        });

        it("refuses to run twice and leaves the running copy alone", async () => {
            const user = await store.create();
            const scriptFile = await writeScript(user);
            const first = await start(user, scriptFile);
            const [master] = await masters(user);

            const terminal = spawn("script", ["-qfec", `stty cols 200 rows 50; bash '${scriptFile}'`, "/dev/null"], {
                cwd: root,
                env: { ...process.env, HOME: home },
                stdio: ["pipe", "pipe", "pipe"],
            });
            terminals.push(terminal);
            let output = "";
            terminal.stdout!.on("data", (chunk) => (output += chunk));
            await new Promise((resolve) => terminal.on("exit", resolve));
            expect(output).toContain(`This script is already running (pid ${first.scriptPid}), stop that one first.`);
            expect(output).not.toContain("press any key");

            expect(await masters(user)).toEqual([master]);
            expect(user.tunnelConnection).not.toBeNull();
            first.type("\x03");
            await expectStopped(user, first.scriptPid);
        });

        it("trims logs of earlier runs", async () => {
            const user = await store.create();
            await mkdir(workDir(user), { recursive: true });
            const log = path.join(workDir(user), "reconnect.log");
            await writeFile(log, Array.from({ length: 1000 }, (_, i) => `old line ${i}`).join("\n") + "\n");

            const run = await start(user, await writeScript(user));
            const lines = (await readFile(log, "utf8")).trim().split("\n");
            expect(lines).toHaveLength(200);
            expect(lines[199]).toBe("old line 999");
            run.type("\x03");
            await expectStopped(user, run.scriptPid);
        });
    });

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
            const run = await start(user, scriptFile, { command: `bash -c "bash '${scriptFile}'; echo PARENT-CONTINUES"` });
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
