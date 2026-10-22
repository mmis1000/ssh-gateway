import { describe, expect, it } from "vitest";
import { formatOrigin, getContentType, parseBasicAuth, parseRawData, secretEquals } from "../src/utils";

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

describe("parseBasicAuth", () => {
    const header = (text: string) => `Basic ${Buffer.from(text).toString("base64")}`;

    it("splits on the first colon only", () => {
        expect(parseBasicAuth(header("admin:se:cr:et"))).toEqual({ account: "admin", password: "se:cr:et" });
        expect(parseBasicAuth(header("admin:"))).toEqual({ account: "admin", password: "" });
    });

    it("keeps percent signs as they are", () => {
        expect(parseBasicAuth(header("admin:100%"))).toEqual({ account: "admin", password: "100%" });
    });

    it("accepts any case of the scheme", () => {
        expect(parseBasicAuth(header("a:b").replace("Basic", "basic"))).toEqual({ account: "a", password: "b" });
    });

    it.each([
        ["no header", undefined],
        ["another scheme", "Bearer abc"],
        ["no colon", header("admin")],
        ["no credential", "Basic"],
        ["a scheme that only starts with Basic", `Basicx ${Buffer.from("a:b").toString("base64")}`],
    ])("returns null for %s", (_, value) => {
        expect(parseBasicAuth(value)).toBeNull();
    });
});

describe("secretEquals", () => {
    it("compares secrets of any length", () => {
        expect(secretEquals("secret", "secret")).toBe(true);
        expect(secretEquals("secret", "secre")).toBe(false);
        expect(secretEquals("secret", "secret!")).toBe(false);
        expect(secretEquals("", "")).toBe(true);
    });

    it("never matches a missing secret", () => {
        expect(secretEquals(null, "")).toBe(false);
        expect(secretEquals(undefined, "")).toBe(false);
    });
});
