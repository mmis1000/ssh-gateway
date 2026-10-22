import { describe, expect, it } from "vitest";
import { folderView, formatSize, hasHiddenSegment } from "../src/listing";

const FILE = 0o100644;
const DIR = 0o40755;
const LINK = 0o120777;
const entry = (filename: string, mode: number, size = 0, mtime = 1760000000) => ({ filename, attrs: { mode, size, mtime } });
const view = (requestPath: string, files: ReturnType<typeof entry>[], showHidden = false) =>
    folderView(requestPath, files, { siteName: "site", showHidden });

describe("folderView", () => {
    it("puts folders first and sorts names the way people count, ignoring case", () => {
        const names = view("/", [
            entry("file10.txt", FILE), entry("README.md", FILE), entry("Demo video.mp4", FILE), entry("file2.txt", FILE),
            entry("archive.tar.gz", FILE), entry("src", DIR), entry("Docs", DIR), entry("latest", LINK), entry("assets", DIR),
        ]).entries.map((e) => e.name);
        expect(names).toEqual([
            "assets", "Docs", "src",
            "archive.tar.gz", "Demo video.mp4", "file2.txt", "file10.txt", "latest", "README.md",
        ]);
    });

    it("hides names starting with a dot unless they are shared", () => {
        const files = [entry(".git", DIR), entry(".env", FILE), entry("index.html", FILE), entry(".", DIR), entry("..", DIR)];
        expect(view("/", files).entries.map((e) => e.name)).toEqual(["index.html"]);
        expect(view("/", files, true).entries.map((e) => e.name)).toEqual([".git", ".env", "index.html"]);
    });

    it("links folders with a trailing slash, which saves a redirect", () => {
        const { entries } = view("/a b/", [entry("sub dir", DIR), entry("x#1.txt", FILE), entry("link", LINK)]);
        expect(entries.map((e) => e.href)).toEqual(["/a%20b/sub%20dir/", "/a%20b/link", "/a%20b/x%231.txt"]);
    });

    it("picks an icon by type", () => {
        const icons = Object.fromEntries(view("/", [
            entry("photo.JPG", FILE), entry("clip.mp4", FILE), entry("song.mp3", FILE), entry("backup.tar.gz", FILE),
            entry("notes.md", FILE), entry("data.json", FILE), entry("paper.pdf", FILE), entry("Makefile", FILE),
            entry("dir", DIR), entry("link", LINK),
        ]).entries.map((e) => [e.name, e.icon]));
        expect(icons).toEqual({
            "photo.JPG": "image", "clip.mp4": "video", "song.mp3": "audio", "backup.tar.gz": "archive",
            "notes.md": "text", "data.json": "text", "paper.pdf": "pdf", Makefile: "file", dir: "folder", link: "link",
        });
    });

    it("shows sizes of files only, and dates in UTC until the page converts them", () => {
        const [folder, file] = view("/", [entry("dir", DIR, 4096), entry("a.bin", FILE, 1536)]).entries;
        expect(folder.sizeText).toBe("");
        expect(file.sizeText).toBe("1.5 KB");
        expect(file.modified).toBe("2025-10-09T08:53:20.000Z");
        expect(file.modifiedText).toBe("2025-10-09 08:53 UTC");
    });

    it("builds breadcrumbs and the parent link", () => {
        const nested = view("/music/live set/", []);
        expect(nested.breadcrumbs).toEqual([
            { name: "site", href: "/" },
            { name: "music", href: "/music/" },
            { name: "live set", href: "/music/live%20set/" },
        ]);
        expect(nested.parent).toBe("/music/");
        expect(nested.title).toBe("live set · site");

        const top = view("/", []);
        expect(top.breadcrumbs).toEqual([{ name: "site", href: "/" }]);
        expect(top.parent).toBeNull();
        expect(top.title).toBe("site");
    });
});

describe("formatSize", () => {
    it.each([
        [0, "0 B"], [1023, "1023 B"], [1024, "1.0 KB"], [1536, "1.5 KB"], [10 * 1024, "10 KB"],
        [5_100_000, "4.9 MB"], [120 * 1024 * 1024, "120 MB"], [3 * 1024 ** 4, "3.0 TB"], [5000 * 1024 ** 4, "5000 TB"],
    ])("formats %d bytes as %s", (bytes, text) => {
        expect(formatSize(bytes)).toBe(text);
    });
});

describe("hasHiddenSegment", () => {
    it.each([
        ["/.env", true], ["/.git/config", true], ["/a/.hidden/b.txt", true], ["/a/../b", true],
        ["/", false], ["/a.b/c.txt", false], ["/index.html", false], ["/dir/", false],
    ])("%s is hidden: %s", (requestPath, hidden) => {
        expect(hasHiddenSegment(requestPath)).toBe(hidden);
    });
});
