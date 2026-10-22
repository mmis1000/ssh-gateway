import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChildProcess, execFile, execFileSync, spawn } from "child_process";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
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

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 20000, what: string | (() => string) = "condition") {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
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

    const workDir = (user: User) => path.join(home, ".ssh-gateway", "127.0.0.1", user.id!);
    const scriptFileOf = (user: User) => path.join(root, `run-${user.id}.sh`);
    const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    /** the script and its watchdog subshell, with or without options, not a parent that mentions the file */
    const scriptProcesses = (file: string) => pgrep(`^bash ${escapeRegex(file)}( |$)`);
    const masters = (user: User, ofHome = home) => pgrep(`ssh -N -M .*${path.join(ofHome, ".ssh-gateway", `${user.id}.sock`)}`);
    const sshds = (user: User) => pgrep(`sshd -D -f ${workDir(user)}/sshd_config`);

    async function writeScript(user: User, options: { portRange?: [number, number] } = {}) {
        const template = await readFile(path.resolve(__dirname, "../template/script.template"), "utf8");
        const knownHosts = (await knownHostsLines(store.hostKeyDir, "127.0.0.1", sshPort)).join("\n");
        const file = scriptFileOf(user);
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
        /** answer to the index.html question in folder mode, default is yes */
        indexAnswer?: string;
        /** answers to the visitor user name and password questions, default is no password */
        authAnswers?: string[];
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
        if (options.folder) {
            await answer("static directory", "is not a directory.", options.dirAnswers ?? [root]);
            await prompt("Show index.html of folders");
            await new Promise((resolve) => setTimeout(resolve, 300));
            type(`${options.indexAnswer ?? ""}\r`);
        }
        // a user name, followed by a password unless the name is refused, an empty name ends the questions
        let complaints = 0;
        let passwordsAsked = 0;
        for (const [index, text] of (options.authAnswers ?? [""]).entries()) {
            if (index > 0 && count("Password for ") > passwordsAsked) {
                await prompt("Password for ", ++passwordsAsked);
            } else if (index === 0) {
                await prompt("Ask visitors for a user name");
            } else {
                // the user name question is redrawn while typing, count the complaints instead
                await prompt("Try again, ", ++complaints);
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
            type(`${text}\r`);
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (options.noWait) return { terminal, scriptPid: 0, type, output: () => output, prompt };
        await prompt("Press Ctrl+C to stop.");
        await waitFor(() => user.tunnelConnection !== null, 10000, "the tunnel");

        const [scriptPid] = await scriptProcesses(scriptFile);
        expect(scriptPid).toBeGreaterThan(0);
        return { terminal, scriptPid, type, output: () => output, prompt };
    }

    /** run the script without a terminal, stdin closed, like cron or a service would */
    function runWithoutTerminal(scriptFile: string, args: string[], env: Record<string, string> = {}) {
        const child = spawn("bash", [scriptFile, ...args], {
            cwd: root,
            env: { ...process.env, HOME: home, ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        terminals.push(child);
        let output = "";
        child.stdout!.on("data", (chunk) => (output += chunk));
        child.stderr!.on("data", (chunk) => (output += chunk));
        const exited = new Promise<number | null>((resolve) => {
            if (child.exitCode !== null) resolve(child.exitCode);
            child.on("exit", (code) => resolve(code));
        });
        return { child, output: () => output, exited };
    }

    async function expectStopped(user: User, scriptPid: number) {
        await waitFor(async () => {
            // the script and its watchdog subshell, not a parent script that mentions the file
            const running = await scriptProcesses(scriptFileOf(user));
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
            await waitFor(() => run.output().slice(before).includes("Tunnel is up again"), 30000, "the script to reconnect");
            await waitFor(() => user.tunnelConnection !== null, 10000, "the new tunnel");

            const printed = run.output().slice(before).replace(/\r/g, "").trim().split("\n");
            expect(printed).toEqual([
                expect.stringMatching(/^Connection lost at \d\d:\d\d, reconnecting\.\.\. \(details in .*reconnect\.log\)$/),
                expect.stringMatching(/^Tunnel is up again since \d\d:\d\d, it was down for \d+m \d+s\.$/),
            ]);
            // only the connection is replaced, the local sshd keeps serving the folder
            if (folder) expect(await sshds(user)).toEqual([sshd]);

            run.type("\x03");
            await expectStopped(user, run.scriptPid);
        });
    });

    describe.concurrent("options", { timeout: 60000 }, () => {
        it("prints usage with -h and touches nothing", async () => {
            const user = await store.create();
            for (const flag of ["-h", "--help"]) {
                const run = runWithoutTerminal(await writeScript(user), [flag]);
                expect(await run.exited).toBe(0);
                expect(run.output()).toMatch(/^Usage: run-\w+\.sh \[options\]/);
                expect(run.output()).toContain("-p, --port PORT");
                expect(run.output()).toContain("-a, --auth USER:PASSWORD");
                expect(run.output()).toContain("-l, --list");
                expect(run.output()).toContain("Opens a tunnel from 127.0.0.1 to this computer.");
            }
            await expect(readFile(path.join(workDir(user), "known_hosts"))).rejects.toThrow();
        });

        it.each([
            ["no options", [], "No terminal to ask to accept the notice, use --yes (see --help)"],
            ["only --yes", ["--yes"], "No terminal to ask what to share, use --port or --dir (see --help)"],
            ["an unknown option", ["--verbose"], "Unknown option --verbose, see --help"],
            ["--port without a value", ["--port"], "--port needs a port, see --help"],
            ["both --port and --dir", ["-p", "8080", "-d", "/tmp"], "Use either --port or --dir, not both"],
            ["a bad port", ["-y", "-p", "http"], "--port needs a port number between 1 and 65535"],
            ["port 0", ["-y", "-p", "0"], "Use --dir to share a directory"],
            ["a missing directory", ["-y", "-d", "/no/such/dir"], "/no/such/dir is not a directory"],
            ["--auth without a value", ["--auth"], "--auth needs USER:PASSWORD, see --help"],
            ["--auth without a colon", ["-y", "-p", "8080", "--auth", "alice"], "--auth needs USER:PASSWORD, the user name without a colon"],
            ["--auth with an empty password", ["-y", "-p", "8080", "-a", "alice:"], "--auth needs USER:PASSWORD, the user name without a colon"],
        ])("stops with a message for %s", async (_, args, message) => {
            const user = await store.create();
            const run = runWithoutTerminal(await writeScript(user), args);
            expect(await run.exited).toBe(2);
            expect(run.output()).toContain(message);
            expect(await masters(user)).toEqual([]);
            expect(user.tunnelConnection).toBeNull();
        });

        it("explains when HOME is too long for the control socket", async () => {
            const user = await store.create();
            const longHome = path.join(root, "a-very-long-home-directory-name-".repeat(3));
            const run = runWithoutTerminal(await writeScript(user), ["-p", String(targetPort), "-y"], { HOME: longHome });
            expect(await run.exited).toBe(1);
            expect(run.output()).toContain("is too long for a unix socket");
            expect(user.tunnelConnection).toBeNull();
        });

        it("shares a port without asking", async () => {
            const user = await store.create();
            const scriptFile = await writeScript(user);
            const run = runWithoutTerminal(scriptFile, ["--port", String(targetPort), "--yes"]);
            await waitFor(() => run.output().includes("Press Ctrl+C to stop."), 30000, `the tunnel, output:\n${run.output()}`);
            expect(run.output()).not.toContain("EULA");
            expect(user.httpPort).toBe(targetPort);
            process.kill(run.child.pid!, "SIGTERM");
            await expectStopped(user, run.child.pid!);
        });

        it("asks visitors for a password with --auth", async () => {
            const user = await store.create();
            const run = runWithoutTerminal(await writeScript(user), ["-p", String(targetPort), "-y", "-a", "alice:pa ss:word"]);
            await waitFor(() => run.output().includes("Press Ctrl+C to stop."), 30000, `the tunnel, output:\n${run.output()}`);
            expect(run.output()).toContain("Visitors are asked for the user name alice");
            expect(user.publicAuth).toEqual({ account: "alice", password: "pa ss:word" });
            process.kill(run.child.pid!, "SIGTERM");
            await expectStopped(user, run.child.pid!);
        });

        it("takes the password from GATEWAY_AUTH and keeps it out of ps", async () => {
            const user = await store.create();
            const secret = `env-secret-${user.id}`;
            const run = runWithoutTerminal(await writeScript(user), ["-p", String(targetPort), "-y"], { GATEWAY_AUTH: `alice:${secret}` });
            await waitFor(() => run.output().includes("Press Ctrl+C to stop."), 30000, `the tunnel, output:\n${run.output()}`);
            expect(user.publicAuth).toEqual({ account: "alice", password: secret });
            expect(await pgrep(secret)).toEqual([]);
            process.kill(run.child.pid!, "SIGTERM");
            await expectStopped(user, run.child.pid!);
        });

        it("shows the file list instead of index.html with --list", async () => {
            const user = await store.create();
            const run = runWithoutTerminal(await writeScript(user), ["-d", "~", "-y", "--list"]);
            await waitFor(() => run.output().includes("Press Ctrl+C to stop."), 30000, `the tunnel, output:\n${run.output()}`);
            expect(user.serveIndex).toBe(false);
            process.kill(run.child.pid!, "SIGTERM");
            await expectStopped(user, run.child.pid!);
        });

        it("shares a directory without asking, ~ expanded", async () => {
            const user = await store.create();
            const scriptFile = await writeScript(user);
            const run = runWithoutTerminal(scriptFile, ["-d", "~", "-y"]);
            await waitFor(() => run.output().includes("Press Ctrl+C to stop."), 30000, `the tunnel, output:\n${run.output()}`);
            expect(user.httpPort).toBe(0);
            expect(user.staticDirectory).toBe(home);
            expect(await sshds(user)).toHaveLength(1);
            process.kill(run.child.pid!, "SIGTERM");
            await expectStopped(user, run.child.pid!);
            expect(await sshds(user)).toEqual([]);
        });
    });

    describe.concurrent("work folder", { timeout: 60000 }, () => {
        const oldWorkDir = (user: User) => path.join(home, ".gateway-mmis1000", user.id!);

        it("keeps its files private in ~/.ssh-gateway/<host>/<id>", async () => {
            const user = await store.create();
            const run = runWithoutTerminal(await writeScript(user), ["-p", String(targetPort), "-y"]);
            await waitFor(() => run.output().includes("Press Ctrl+C to stop."), 30000, "the tunnel");
            expect((await stat(workDir(user))).mode & 0o777).toBe(0o700);
            expect((await stat(path.join(home, ".ssh-gateway"))).mode & 0o777).toBe(0o700);
            expect(await readFile(path.join(workDir(user), "known_hosts"), "utf8")).toContain(`[127.0.0.1]:${sshPort}`);
            process.kill(run.child.pid!, "SIGTERM");
            await expectStopped(user, run.child.pid!);
        });

        it("moves its own folder from older scripts and leaves other tunnels alone", async () => {
            const user = await store.create();
            const other = path.join(home, ".gateway-mmis1000", "othertunnel");
            await mkdir(oldWorkDir(user), { recursive: true });
            await mkdir(other, { recursive: true });
            await writeFile(path.join(oldWorkDir(user), "ssh_host_rsa_key"), "kept host key");
            await writeFile(path.join(other, "id_rsa"), "another tunnel");

            const run = runWithoutTerminal(await writeScript(user), ["-p", String(targetPort), "-y"]);
            await waitFor(() => run.output().includes("Press Ctrl+C to stop."), 30000, "the tunnel");
            expect(await readFile(path.join(workDir(user), "ssh_host_rsa_key"), "utf8")).toBe("kept host key");
            await expect(stat(oldWorkDir(user))).rejects.toThrow();
            // an older script of another tunnel keeps its folder, and with it the parent
            expect(await readFile(path.join(other, "id_rsa"), "utf8")).toBe("another tunnel");
            process.kill(run.child.pid!, "SIGTERM");
            await expectStopped(user, run.child.pid!);
        });

        it("removes the old parent folder once it is empty", async () => {
            // its own home, so other tests can not leave folders in the shared parent
            const user = await store.create();
            const ownHome = path.join(root, `home-${user.id}`);
            await mkdir(path.join(ownHome, ".gateway-mmis1000", user.id!), { recursive: true });

            const run = runWithoutTerminal(await writeScript(user), ["-p", String(targetPort), "-y"], { HOME: ownHome });
            await waitFor(() => run.output().includes("Press Ctrl+C to stop."), 30000, () => `the tunnel, output:\n${run.output()}`);
            await expect(stat(path.join(ownHome, ".gateway-mmis1000"))).rejects.toThrow();
            expect((await stat(path.join(ownHome, ".ssh-gateway", "127.0.0.1", user.id!))).isDirectory()).toBe(true);
            process.kill(run.child.pid!, "SIGTERM");
            await waitFor(async () => (await scriptProcesses(scriptFileOf(user))).length === 0 && user.tunnelConnection === null, 15000, "the script to stop");
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
            expect(user.serveIndex).toBe(true);
            run.type("\x03");
            await expectStopped(user, run.scriptPid);
        });

        it("asks for a visitor password and does not echo it", async () => {
            const user = await store.create();
            const run = await start(user, await writeScript(user), {
                // a colon in the user name and an empty password are asked again
                authAnswers: ["al:ice", "alice", "", "alice", "pa ss:word"],
            });
            expect(run.output()).toContain("Try again, the user name can not contain a colon.");
            expect(run.output()).toContain("Try again, the password can not be empty.");
            expect(run.output()).not.toContain("pa ss:word");
            expect(run.output()).toContain("Visitors are asked for the user name alice");
            expect(user.publicAuth).toEqual({ account: "alice", password: "pa ss:word" });
            run.type("\x03");
            await expectStopped(user, run.scriptPid);
        });

        it("shows the file list when index.html is turned down", async () => {
            const user = await store.create();
            const run = await start(user, await writeScript(user), { folder: true, indexAnswer: "n" });
            expect(user.serveIndex).toBe(false);
            run.type("\x03");
            await expectStopped(user, run.scriptPid);
        });

        it("does not ask for a visitor password when it is given already", async () => {
            const user = await store.create();
            const run = await start(user, await writeScript(user), { env: { GATEWAY_AUTH: "alice:secret" }, authAnswers: [] });
            expect(run.output()).not.toContain("Ask visitors for a user name");
            expect(user.publicAuth).toEqual({ account: "alice", password: "secret" });
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
            for (const pid of await scriptProcesses(scriptFile)) process.kill(pid, "SIGKILL");
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
