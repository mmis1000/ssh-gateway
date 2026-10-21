import { describe, expect, it } from "vitest";
import { formatOrigin, getContentType, parseRawData } from "../src/utils";

// mime is ESM only since v4, these make sure it still loads and resolves from the CommonJS build
describe("getContentType", () => {
    it.each([
        ["index.html", "text/html"],
        ["style.css", "text/css"],
        ["app.js", "text/javascript"],
        ["song.mp3", "audio/mpeg"],
        ["movie.mp4", "video/mp4"],
        ["photo.PNG", "image/png"],
        ["archive.tar.gz", "application/gzip"],
    ])("resolves %s to %s", (fileName, expected) => {
        expect(getContentType(fileName)).toBe(expected);
    });

    it("falls back to octet-stream for unknown extensions", () => {
        expect(getContentType("data.unknown-ext")).toBe("application/octet-stream");
    });

    it("falls back to octet-stream without an extension", () => {
        expect(getContentType("Makefile")).toBe("application/octet-stream");
        expect(getContentType(".bashrc")).toBe("application/octet-stream");
    });
});

describe("parseRawData", () => {
    it("parses buffers, buffer lists and array buffers", () => {
        const json = JSON.stringify({ a: 1 });
        expect(parseRawData(Buffer.from(json))).toEqual({ a: 1 });
        expect(parseRawData([Buffer.from(json.slice(0, 3)), Buffer.from(json.slice(3))])).toEqual({ a: 1 });
        expect(parseRawData(new TextEncoder().encode(json).buffer as ArrayBuffer)).toEqual({ a: 1 });
    });

    it("keeps the unknown payload as the error cause", () => {
        const payload = "not raw data" as never;
        expect(() => parseRawData(payload)).toThrow(expect.objectContaining({
            message: "unknown content",
            cause: payload,
        }));
    });
});

describe("formatOrigin", () => {
    it("omits default ports", () => {
        expect(formatOrigin("https", "gateway.test", 443)).toBe("https://gateway.test");
        expect(formatOrigin("http", "gateway.test", 80)).toBe("http://gateway.test");
    });

    it("keeps other ports", () => {
        expect(formatOrigin("https", "gateway.test", 8443)).toBe("https://gateway.test:8443");
        expect(formatOrigin("http", "gateway.test", 443)).toBe("http://gateway.test:443");
    });
});
