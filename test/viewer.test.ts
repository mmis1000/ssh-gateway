import { afterEach, describe, expect, it, vi } from "vitest";
import { fileUrlFromHash, looksLikeText, openRemoteFile, readRange, RemoteFileError } from "../app/src/viewer/remote";

const FILE_URL = "http://brave-otter-42-k3x9qz.ugc.test/sub%20dir/a%23b.txt";

describe("file viewer", () => {
    afterEach(() => vi.unstubAllGlobals());

    describe("fileUrlFromHash", () => {
        it("takes the file from the fragment, also when the whole url was encoded", () => {
            expect(fileUrlFromHash(`#${FILE_URL}`).href).toBe(FILE_URL);
            expect(fileUrlFromHash(`#${encodeURIComponent(FILE_URL)}`).href).toBe(FILE_URL);
        });

        it.each(["", "#", "#not a url", "#javascript:alert(1)", "#data:text/plain,hi", "#file:///etc/passwd"])("refuses %j", (hash) => {
            expect(() => fileUrlFromHash(hash)).toThrow(RemoteFileError);
        });
    });

    describe("looksLikeText", () => {
        const bytes = (text: string) => new TextEncoder().encode(text);

        it("takes UTF-8 as text, binary and NUL bytes as not", () => {
            expect(looksLikeText(bytes("hello, 世界\n"), true)).toBe(true);
            expect(looksLikeText(new Uint8Array(0), true)).toBe(true);
            expect(looksLikeText(new Uint8Array([0x68, 0x00, 0x69]), true)).toBe(false);
            expect(looksLikeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), true)).toBe(false);
        });

        it("forgives a character cut in half at the end of a sample only", () => {
            const cut = bytes("ab世").slice(0, 4);
            expect(looksLikeText(cut, false)).toBe(true);
            expect(looksLikeText(cut, true)).toBe(false);
        });
    });

    describe("reading", () => {
        const respond = (status: number, headers: Record<string, string>, body = "") =>
            vi.fn(async (_url: string, _init?: RequestInit) => new Response(status === 204 || body === "" ? null : body, { status, headers }));
        const file = { url: FILE_URL, name: "a#b.txt", size: 10, etag: '"1-a"' };

        it("opens a file and reads its start in one request, with the password the browser has", async () => {
            const fetch = respond(206, { "Content-Range": "bytes 0-3/10", ETag: '"1-a"' }, "0123");
            vi.stubGlobal("fetch", fetch);
            const { file: opened, sample } = await openRemoteFile(new URL(FILE_URL), 4);
            expect(opened).toEqual(file);
            expect(new TextDecoder().decode(sample)).toBe("0123");
            expect(fetch).toHaveBeenCalledWith(FILE_URL, { headers: { Range: "bytes=0-3" }, credentials: "include", cache: "no-store" });
        });

        it("opens empty files, which have no first byte to ask for", async () => {
            vi.stubGlobal("fetch", respond(416, { "Content-Range": "bytes */0" }, "Range not satisfiable"));
            const { file: opened, sample } = await openRemoteFile(new URL(FILE_URL), 4);
            expect(opened.size).toBe(0);
            expect(sample).toHaveLength(0);
        });

        it("takes the size from a whole file sent instead of a range", async () => {
            vi.stubGlobal("fetch", respond(200, {}, "012"));
            const { file: opened, sample } = await openRemoteFile(new URL(FILE_URL), 4);
            expect(opened.size).toBe(3);
            expect(sample).toHaveLength(3);
        });

        it.each([
            [401, "auth"],
            [404, "missing"],
            [403, "forbidden"],
            [502, "offline"],
            [500, "failed"],
        ])("tells status %i apart", async (status, kind) => {
            vi.stubGlobal("fetch", respond(status, {}));
            await expect(openRemoteFile(new URL(FILE_URL), 4)).rejects.toMatchObject({ kind });
        });

        it("says when it can not reach the share at all", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
            await expect(openRemoteFile(new URL(FILE_URL), 4)).rejects.toMatchObject({ kind: "unreachable" });
        });

        it("reads a range", async () => {
            const fetch = respond(206, { ETag: '"1-a"', "Content-Range": "bytes 2-5/10" }, "2345");
            vi.stubGlobal("fetch", fetch);
            expect(new TextDecoder().decode(await readRange(file, 2, 6))).toBe("2345");
            expect(fetch.mock.calls[0][1]?.headers).toEqual({ Range: "bytes=2-5" });
        });

        it("takes the part it asked for from a whole file", async () => {
            vi.stubGlobal("fetch", respond(200, { ETag: '"1-a"' }, "0123456789"));
            expect(new TextDecoder().decode(await readRange(file, 2, 6))).toBe("2345");
        });

        it("notices the file changed while it was open", async () => {
            vi.stubGlobal("fetch", respond(206, { ETag: '"2-b"' }, "2345"));
            await expect(readRange(file, 2, 6)).rejects.toMatchObject({ kind: "changed" });
            vi.stubGlobal("fetch", respond(416, { "Content-Range": "bytes */4" }));
            await expect(readRange(file, 2, 6)).rejects.toMatchObject({ kind: "changed" });
        });

        it("does not ask for nothing", async () => {
            const fetch = respond(206, {});
            vi.stubGlobal("fetch", fetch);
            expect(await readRange(file, 0, 0)).toHaveLength(0);
            expect(fetch).not.toHaveBeenCalled();
        });
    });
});
