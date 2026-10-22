import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { Writable } from "stream";
import { finished, pipeline } from "stream/promises";
import getFastReadStream, { ReadBudget } from "../src/ssh_fast_read_stream";

interface FakeOptions {
    /** the file becomes this long right after it is opened, like a file being truncated */
    shrinkTo?: number;
    /** most bytes a single read returns, servers may return less than asked */
    maxRead?: number;
    openError?: Error;
    readError?: Error;
    /** hold read replies until release() is called */
    manual?: boolean;
}

/** an in memory sftp session that records what the stream asked for */
function fakeSftp(data: Buffer, options: FakeOptions = {}) {
    let content = data;
    const log = { opens: 0, stats: 0, closes: 0, reads: [] as { position: number; length: number }[], inFlight: 0, maxInFlight: 0 };
    const held: (() => void)[] = [];
    const sftp: any = {
        open(_path: string, _flags: string, cb: Function) {
            log.opens++;
            if (options.openError) return setImmediate(cb, options.openError);
            if (options.shrinkTo !== undefined) content = content.subarray(0, options.shrinkTo);
            setImmediate(cb, undefined, Buffer.from([log.opens]));
        },
        fstat(_handle: Buffer, cb: Function) {
            log.stats++;
            setImmediate(cb, undefined, { size: data.length });
        },
        read(_handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, cb: Function) {
            log.reads.push({ position, length });
            log.inFlight++;
            log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
            const reply = () => {
                log.inFlight--;
                if (options.readError) return cb(options.readError);
                // like ssh2, the end of the file is 0 bytes read and not an error
                const n = Math.max(0, Math.min(length, options.maxRead ?? length, content.length - position));
                if (n > 0) content.copy(buffer, offset, position, position + n);
                cb(undefined, n, buffer, position);
            };
            if (options.manual) held.push(reply);
            else setImmediate(reply);
        },
        close(_handle: Buffer, cb: Function) {
            log.closes++;
            setImmediate(cb);
        },
    };
    return { sftp, log, release: () => held.splice(0).forEach((reply) => reply()), held };
}

const DIGITS = Buffer.from("0123456789");
/** bytes 0..n-1 as a repeating pattern, so misplaced chunks show */
const pattern = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i % 251));

async function readAll(stream: NodeJS.ReadableStream) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("FastReadStream", () => {
    it("reads a whole file in order", async () => {
        const data = pattern(1000);
        const { sftp } = fakeSftp(data);
        expect(await readAll(getFastReadStream(sftp, "/f", { chunkSize: 64 }))).toEqual(data);
    });

    it.each([
        ["the first byte only (bytes=0-0)", 0, 0, "0"],
        ["a middle range", 2, 5, "2345"],
        ["the last byte", 9, 9, "9"],
        ["an end past the file", 7, 100, "789"],
    ])("reads %s", async (_, start, end, expected) => {
        const { sftp } = fakeSftp(DIGITS);
        expect((await readAll(getFastReadStream(sftp, "/f", { start, end, chunkSize: 3 }))).toString()).toBe(expected);
    });

    it("reads empty files and ranges past the end", async () => {
        expect((await readAll(getFastReadStream(fakeSftp(Buffer.alloc(0)).sftp, "/f"))).length).toBe(0);
        expect((await readAll(getFastReadStream(fakeSftp(DIGITS).sftp, "/f", { start: 20 }))).length).toBe(0);
    });

    it("skips the stat round trip when the size is known", async () => {
        const known = fakeSftp(DIGITS);
        await readAll(getFastReadStream(known.sftp, "/f", { size: 10 }));
        expect(known.log.stats).toBe(0);

        const unknown = fakeSftp(DIGITS);
        await readAll(getFastReadStream(unknown.sftp, "/f"));
        expect(unknown.log.stats).toBe(1);
    });

    it("asks again for the rest after a short read", async () => {
        const data = pattern(300);
        const { sftp, log } = fakeSftp(data, { maxRead: 7 });
        expect(await readAll(getFastReadStream(sftp, "/f", { chunkSize: 100 }))).toEqual(data);
        expect(log.reads.length).toBeGreaterThan(3);
    });

    it("fails instead of looping when the file shrinks while it is read", async () => {
        const { sftp, log } = fakeSftp(DIGITS, { shrinkTo: 4 });
        await expect(readAll(getFastReadStream(sftp, "/f", { size: 10, chunkSize: 2 }))).rejects.toThrow("/f changed while it was read");
        expect(log.reads.length).toBeLessThan(20);
        await tick();
        expect(log.closes).toBe(1);
    });

    it("passes open and read errors on, and closes an opened file once", async () => {
        const opening = fakeSftp(DIGITS, { openError: new Error("no such file") });
        await expect(readAll(getFastReadStream(opening.sftp, "/f"))).rejects.toThrow("no such file");
        expect(opening.log.closes).toBe(0);

        const reading = fakeSftp(DIGITS, { readError: new Error("permission denied") });
        await expect(readAll(getFastReadStream(reading.sftp, "/f", { chunkSize: 2 }))).rejects.toThrow("permission denied");
        await tick();
        expect(reading.log.closes).toBe(1);
    });

    it("closes the file once, also when destroyed again after the end", async () => {
        const { sftp, log } = fakeSftp(DIGITS);
        const stream = getFastReadStream(sftp, "/f", { chunkSize: 3 });
        await readAll(stream);
        stream.destroy();
        stream.destroy();
        await tick();
        expect(log.closes).toBe(1);
    });

    it("closes the file once and emits close when destroyed while reading", async () => {
        const { sftp, log, release } = fakeSftp(pattern(1000), { manual: true });
        const stream = getFastReadStream(sftp, "/f", { chunkSize: 10 });
        stream.resume();
        while (log.reads.length === 0) await tick();
        const closed = new Promise((resolve) => stream.once("close", resolve));
        stream.destroy();
        stream.destroy();
        await closed;
        // replies for reads that were in flight arrive later and must be ignored
        release();
        await tick();
        expect(log.closes).toBe(1);
        expect(stream.destroyed).toBe(true);
    });

    it("works with pipeline and finished", async () => {
        const data = pattern(500);
        const { sftp } = fakeSftp(data);
        const chunks: Buffer[] = [];
        const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
        const stream = getFastReadStream(sftp, "/f", { chunkSize: 64 });
        await pipeline(stream, sink);
        await finished(stream);
        expect(Buffer.concat(chunks)).toEqual(data);
    });

    it("keeps no more than its share of the budget in flight", async () => {
        const { sftp, log } = fakeSftp(pattern(10_000));
        const budget = new ReadBudget(1000);
        await readAll(getFastReadStream(sftp, "/f", { chunkSize: 100, budget }));
        expect(log.maxInFlight).toBe(10);
    });

    it("stops asking for more while the reader is not reading", async () => {
        const { sftp, log } = fakeSftp(pattern(100_000));
        const stream = getFastReadStream(sftp, "/f", { chunkSize: 100, budget: new ReadBudget(1000), highWaterMark: 100 });
        stream.once("data", () => stream.pause());
        await new Promise((resolve) => setTimeout(resolve, 50));
        const asked = log.reads.length;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(log.reads.length).toBe(asked);
        expect(asked).toBeLessThan(30);
        stream.destroy();
    });
});

describe("ReadBudget", () => {
    it("gives one stream all of it and splits it evenly between several", () => {
        const budget = new ReadBudget(1000);
        const [a, b, c] = [{}, {}, {}];
        budget.join(a);
        expect(budget.allowance(100)).toBe(10);
        budget.join(b);
        budget.join(c);
        expect(budget.allowance(100)).toBe(3);
        budget.leave(b);
        budget.leave(c);
        budget.leave(c);
        expect(budget.allowance(100)).toBe(10);
    });

    it("always allows a few chunks, so a small file never waits for a big one", () => {
        const budget = new ReadBudget(1000);
        for (let i = 0; i < 50; i++) budget.join({});
        expect(budget.allowance(100)).toBe(2);
    });

    it("lets a new stream in right away while a big one is running", async () => {
        const big = fakeSftp(pattern(100_000), { manual: true });
        const budget = new ReadBudget(1000);
        const first = getFastReadStream(big.sftp, "/big", { chunkSize: 100, budget });
        first.resume();
        while (big.log.reads.length < 10) await tick();
        expect(big.held.length).toBe(10);

        // the second stream shares the session: it gets requests out while the first holds its full share
        const second = getFastReadStream(big.sftp, "/small", { chunkSize: 100, budget, end: 199 });
        const done = readAll(second);
        while (big.log.reads.length < 12) await tick();
        big.release();
        expect((await done).length).toBe(200);
        first.destroy();
    });

    it("leaves the budget when a stream ends or is destroyed", async () => {
        const budget = new ReadBudget(1000);
        await readAll(getFastReadStream(fakeSftp(DIGITS).sftp, "/f", { budget }));
        const destroyed = getFastReadStream(fakeSftp(DIGITS, { manual: true }).sftp, "/f", { budget });
        destroyed.resume();
        await tick();
        destroyed.destroy();
        await new Promise((resolve) => destroyed.once("close", resolve));
        expect(budget.allowance(100)).toBe(10);
    });

    it("is shared by every stream of the same sftp session", async () => {
        const { sftp } = fakeSftp(DIGITS);
        const a = getFastReadStream(sftp, "/a");
        const b = getFastReadStream(sftp, "/b");
        expect(a.budget).toBe(b.budget);
        expect(getFastReadStream(fakeSftp(DIGITS).sftp, "/c").budget).not.toBe(a.budget);
        await Promise.all([readAll(a), readAll(b)]);
    });
});

describe("ssh2 channel window", () => {
    it("is raised by patches/ssh2, so sftp reads over a slow tunnel are not window bound", () => {
        const { MAX_WINDOW } = createRequire(__filename)("ssh2/lib/Channel.js");
        expect(MAX_WINDOW).toBe(8 * 1024 * 1024);
    });
});
