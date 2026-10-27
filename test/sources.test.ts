import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, linkSync, statSync, utimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesPolicy } from "../src/hub/path-policy.ts";
import { processSignature } from "@staix/agent-mem/platform";
import * as platform from "@staix/agent-mem/platform";
import { checkSourceUrl, MAX_META_BYTES, MAX_ORIGINS, MAX_ORIGIN_CHARS, MAX_SOURCE_TEXT, fetchSourceUrl, MAX_REDIRECTS, MAX_SOURCE_BYTES, MAX_SOURCES, publicSourceView, screenRegistration, sha256Of, SourceRegistry, sourceId, validSourceId } from "../src/hub/sources.ts";
import { MAX_PROJECTION_INPUT } from "../src/hub/text-projection.ts";

// agent-hub #508 (hub task #329): the source registry core. Spec: "Sources (#508)".
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const state = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-sources-")); dirs.push(dir); return dir; };
const bytes = (text: string) => Buffer.from(text);

test("the id is src: plus the first 16 hex digits of the snapshot's SHA-256, and the cap is the text-projection input cap", () => {
  const data = bytes("hello source\n");
  const sha = sha256Of(data);
  expect(sha).toBe("e5d53b3ad5222924d553116e1e5a18dabd3b17f04ca0ddd74297a0bc3586234f");
  expect(sourceId(sha)).toBe("src:e5d53b3ad5222924");
  expect(MAX_SOURCE_BYTES).toBe(MAX_PROJECTION_INPUT);
  expect(MAX_SOURCE_BYTES).toBe(16 * 1024 * 1024);
  for (const bad of ["", "abc", "E5D53B3AD5222924D553116E1E5A18DABD3B17F04CA0DDD74297A0BC3586234F", `${sha}0`, "z".repeat(64)]) expect(() => sourceId(bad)).toThrow();
  for (const ok of ["src:e5d53b3ad5222924"]) expect(validSourceId(ok)).toBe(true);
  for (const bad of ["src:E5D53B3AD5222924", "src:e5d53b3ad522292", "src:e5d53b3ad52229244", "e5d53b3ad5222924", "src:../../etc/pass", 5, undefined]) expect(validSourceId(bad)).toBe(false);
});

test("a snapshot lives under sources/<id>/ as meta.json, raw and text; adding the same bytes twice returns the existing id", () => {
  const dir = state(), registry = new SourceRegistry(dir);
  const first = registry.add({ bytes: bytes("hello source\n"), kind: "file", origin: "/notes/a.txt", private: false, text: "hello source\n", now: 1000 });
  expect(first).toEqual({ id: "src:e5d53b3ad5222924", created: true, private: false, upgraded: false, text: true });
  const folder = join(dir, "sources", "src-e5d53b3ad5222924");
  expect(readdirSync(folder).sort()).toEqual(["meta.json", "raw", "text"]);
  expect(readFileSync(join(folder, "raw"))).toEqual(bytes("hello source\n"));
  expect(readFileSync(join(folder, "text"), "utf8")).toBe("hello source\n");
  const meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8"));
  expect(meta).toMatchObject({ id: "src:e5d53b3ad5222924", kind: "file", origin: "/notes/a.txt", sha256: sha256Of(bytes("hello source\n")), bytes: 13, added_at: 1000, private: false });
  const second = registry.add({ bytes: bytes("hello source\n"), kind: "file", origin: "/notes/a.txt", private: false, now: 2000 });
  expect(second).toMatchObject({ id: first.id, created: false });
  expect(registry.list()).toHaveLength(1);
  expect(registry.get(first.id)!.added_at).toBe(1000); // the first registration's time stays
  expect(registry.readRaw(first.id)).toEqual(bytes("hello source\n"));
  expect(registry.readText(first.id)).toBe("hello source\n");
});

test("bytes with no text projection store no text file, and the meta says so", () => {
  const dir = state(), registry = new SourceRegistry(dir);
  const added = registry.add({ bytes: Buffer.from([0, 1, 2, 3]), kind: "file", origin: "/x/blob.bin", private: false });
  expect(added.text).toBe(false);
  expect(existsSync(join(dir, "sources", `src-${added.id.slice(4)}`, "text"))).toBe(false);
  expect(registry.readText(added.id)).toBeUndefined();
});

test("privacy is monotonic, public then private: the second add returns the same id and the record is private", () => {
  const registry = new SourceRegistry(state());
  const a = registry.add({ bytes: bytes("shared bytes"), kind: "file", origin: "/public/a.txt", private: false, now: 1 });
  expect(a.private).toBe(false);
  const b = registry.add({ bytes: bytes("shared bytes"), kind: "file", origin: "/data/private/b.txt", private: true, now: 2 });
  expect(b).toMatchObject({ id: a.id, created: false, private: true, upgraded: true });
  expect(registry.get(a.id)!.private).toBe(true);
  expect(registry.list()).toHaveLength(1);
});

test("privacy is monotonic, private then public: the second add returns the same id and the record stays private", () => {
  const registry = new SourceRegistry(state());
  const a = registry.add({ bytes: bytes("shared bytes"), kind: "file", origin: "/data/private/b.txt", private: true, now: 1 });
  expect(a.private).toBe(true);
  const b = registry.add({ bytes: bytes("shared bytes"), kind: "file", origin: "/public/a.txt", private: false, now: 2 });
  expect(b).toMatchObject({ id: a.id, created: false, private: true, upgraded: false });
  expect(registry.get(a.id)!.private).toBe(true); // never downgraded
  // however many public re-registrations follow
  for (let n = 3; n < 8; n++) registry.add({ bytes: bytes("shared bytes"), kind: "url", origin: `https://example.com/${n}`, private: false, now: n });
  expect(registry.get(a.id)!.private).toBe(true);
});

test("every origin is kept, deduplicated, and the first origin stays the record's origin", () => {
  const registry = new SourceRegistry(state());
  registry.add({ bytes: bytes("same"), kind: "file", origin: "/a.txt", private: false, now: 1 });
  registry.add({ bytes: bytes("same"), kind: "url", origin: "https://example.com/a", private: false, now: 2 });
  registry.add({ bytes: bytes("same"), kind: "file", origin: "/a.txt", private: false, now: 3 }); // exact repeat: no new origin
  registry.add({ bytes: bytes("same"), kind: "file", origin: "/private/a.txt", private: true, now: 4 });
  const meta = registry.get("src:" + sha256Of(bytes("same")).slice(0, 16))!;
  expect(meta.origin).toBe("/a.txt");
  expect(meta.origins.map(o => `${o.kind}:${o.origin}:${o.private}`)).toEqual(["file:/a.txt:false", "url:https://example.com/a:false", "file:/private/a.txt:true"]);
  expect(meta.private).toBe(true);
});

test("a private record shows no origin to anyone but the person", () => {
  const registry = new SourceRegistry(state());
  const added = registry.add({ bytes: bytes("secret"), kind: "file", origin: "/data/patients/p.txt", private: true });
  const meta = registry.get(added.id)!;
  expect(publicSourceView(meta)).toEqual({ id: added.id, kind: "file", private: true });
  expect(JSON.stringify(publicSourceView(meta))).not.toContain("patients");
  const open = registry.add({ bytes: bytes("open"), kind: "file", origin: "/docs/o.txt", private: false });
  expect(publicSourceView(registry.get(open.id)!)).toMatchObject({ origin: "/docs/o.txt" });
});

test("a damaged record is no source: a flag lower than one of its origins, a bad id, a tampered raw, a wrong hash", () => {
  const dir = state(), registry = new SourceRegistry(dir);
  const added = registry.add({ bytes: bytes("payload"), kind: "file", origin: "/p.txt", private: true, now: 1 });
  const folder = join(dir, "sources", `src-${added.id.slice(4)}`), metaPath = join(folder, "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  writeFileSync(metaPath, JSON.stringify({ ...meta, private: false })); // a downgrade written by hand
  expect(registry.get(added.id)).toBeUndefined();
  writeFileSync(metaPath, JSON.stringify(meta));
  expect(registry.get(added.id)).toBeDefined();
  writeFileSync(join(folder, "raw"), "tampered");
  expect(registry.readRaw(added.id)).toBeUndefined(); // no longer matches its id
  writeFileSync(metaPath, JSON.stringify({ ...meta, id: "src:0000000000000000" }));
  expect(registry.get(added.id)).toBeUndefined();
  writeFileSync(metaPath, "not json");
  expect(registry.get(added.id)).toBeUndefined();
  expect(registry.list()).toEqual([]);
  expect(registry.get("src:../../x")).toBeUndefined();
});

test("a raw file that is a link or has several names is never read as a snapshot", () => {
  const dir = state(), registry = new SourceRegistry(dir);
  const added = registry.add({ bytes: bytes("payload"), kind: "file", origin: "/p.txt", private: false });
  const folder = join(dir, "sources", `src-${added.id.slice(4)}`);
  const outside = join(dir, "outside.txt"); writeFileSync(outside, "payload");
  rmSync(join(folder, "raw")); symlinkSync(outside, join(folder, "raw"));
  expect(registry.readRaw(added.id)).toBeUndefined();
  rmSync(join(folder, "raw")); writeFileSync(join(folder, "raw"), "payload"); linkSync(join(folder, "raw"), join(dir, "second-name"));
  expect(registry.readRaw(added.id)).toBeUndefined();
});

test("an input over the cap is refused with the cap in the reason, and nothing is stored or truncated", () => {
  const dir = state(), registry = new SourceRegistry(dir);
  expect(() => registry.add({ bytes: Buffer.alloc(MAX_SOURCE_BYTES + 1), kind: "file", origin: "/big.bin", private: false })).toThrow(`over the ${MAX_SOURCE_BYTES} byte cap`);
  expect(existsSync(join(dir, "sources"))).toBe(false);
  // exactly the cap is allowed
  const at = registry.add({ bytes: Buffer.alloc(MAX_SOURCE_BYTES, 1), kind: "file", origin: "/at.bin", private: false });
  expect(registry.get(at.id)!.bytes).toBe(MAX_SOURCE_BYTES);
  expect(registry.readRaw(at.id)!.length).toBe(MAX_SOURCE_BYTES);
});

test("a bad origin is refused, and a half-written snapshot directory of a crash is not a source and is replaced", () => {
  const dir = state(), registry = new SourceRegistry(dir);
  for (const origin of ["", "a\nb", "x".repeat(2001), "\u0000"]) expect(() => registry.add({ bytes: bytes("x"), kind: "file", origin, private: false })).toThrow("origin");
  const id = "src:" + sha256Of(bytes("crash")).slice(0, 16), folder = join(dir, "sources", `src-${id.slice(4)}`);
  mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "raw"), "partial");
  expect(registry.get(id)).toBeUndefined();
  expect(registry.list()).toEqual([]);
  expect(registry.add({ bytes: bytes("crash"), kind: "file", origin: "/c.txt", private: false }).created).toBe(true);
  expect(registry.readRaw(id)).toEqual(bytes("crash"));
  expect(readdirSync(join(dir, "sources")).filter(name => name.endsWith(".partial"))).toEqual([]);
});

test("list is ordered by time then id and ignores directories that are not sources", () => {
  const dir = state(), registry = new SourceRegistry(dir);
  const b = registry.add({ bytes: bytes("b"), kind: "file", origin: "/b", private: false, now: 20 });
  const a = registry.add({ bytes: bytes("a"), kind: "file", origin: "/a", private: false, now: 10 });
  mkdirSync(join(dir, "sources", "not-a-source")); writeFileSync(join(dir, "sources", "stray.txt"), "x");
  expect(registry.list().map(row => row.id)).toEqual([a.id, b.id]);
});

// --- the screening decision --------------------------------------------------------------------------------------------------------------------

const policy = (over: Partial<Parameters<typeof screenRegistration>[1]> = {}) => ({ piiPaths: [] as string[], piiPatterns: [] as string[], cwd: "/project", matchesPolicy: () => false, ...over });

test("a path under pii.paths is private, a clean one is not, and the reason is fixed words", () => {
  const dir = state(); mkdirSync(join(dir, "secret")); writeFileSync(join(dir, "secret", "a.txt"), "x"); writeFileSync(join(dir, "open.txt"), "x");
  const real = { piiPaths: ["secret"], cwd: dir, matchesPolicy };
  expect(screenRegistration({ bytes: bytes("x"), kind: "file", path: join(dir, "secret", "a.txt") }, policy(real))).toMatchObject({ private: true, reasons: ["path under pii.paths"] });
  expect(screenRegistration({ bytes: bytes("x"), kind: "file", path: join(dir, "open.txt") }, policy(real))).toMatchObject({ private: false, reasons: [] });
  // a URL has no path, so pii.paths never applies to it
  expect(screenRegistration({ bytes: bytes("x"), kind: "url" }, policy({ ...real, matchesPolicy: () => true }))).toMatchObject({ private: false });
});

test("text the PII patterns flag makes the registration private, for a plain file and for a projected one", () => {
  const patterns = ["\\d{6}-\\d{7}"];
  expect(screenRegistration({ bytes: bytes("patient 900101-1234567"), kind: "file", path: "/p/a.txt" }, policy({ piiPatterns: patterns }))).toMatchObject({ private: true, reasons: ["text matches signals.pii_patterns"] });
  expect(screenRegistration({ bytes: bytes("nothing here"), kind: "url" }, policy({ piiPatterns: patterns }))).toMatchObject({ private: false, text: "nothing here" });
  // bytes a converter turns into flagged text: the projection is what is screened, not the opaque bytes
  const projected = screenRegistration({ bytes: Buffer.from([0, 1, 2]), kind: "file", path: "/p/a.pdf" }, policy({ piiPatterns: patterns, project: () => "converted 900101-1234567" }));
  expect(projected).toMatchObject({ private: true, text: "converted 900101-1234567" });
  // opaque bytes with no converter have no text to screen and are not guessed to be clean or flagged
  expect(screenRegistration({ bytes: Buffer.from([0, 1, 2]), kind: "file", path: "/p/a.bin" }, policy({ piiPatterns: patterns }))).toEqual({ private: false, reasons: [] });
});

test("a pattern that cannot be evaluated is flagged, never read as clear; a throwing converter leaves the plain text", () => {
  expect(screenRegistration({ bytes: bytes("some text"), kind: "url" }, policy({ piiPatterns: ["("] }))).toMatchObject({ private: true, reasons: ["text could not be screened"] });
  const result = screenRegistration({ bytes: bytes("plain"), kind: "file", path: "/p/a.txt" }, policy({ project: () => { throw new Error("converter crashed"); } }));
  expect(result).toMatchObject({ private: false, text: "plain" });
});

test("both reasons can hold at once and the OR over registrations is what the registry keeps", () => {
  const dir = state(); mkdirSync(join(dir, "secret")); writeFileSync(join(dir, "secret", "a.txt"), "x");
  const both = screenRegistration({ bytes: bytes("id 900101-1234567"), kind: "file", path: join(dir, "secret", "a.txt") }, policy({ piiPaths: ["secret"], piiPatterns: ["\\d{6}-\\d{7}"], cwd: dir, matchesPolicy }));
  expect(both.reasons).toEqual(["path under pii.paths", "text matches signals.pii_patterns"]);
  const registry = new SourceRegistry(state());
  const publicFirst = registry.add({ bytes: bytes("same bytes 123"), kind: "file", origin: "/open/a.txt", private: screenRegistration({ bytes: bytes("same bytes 123"), kind: "file" }, policy()).private });
  const privateSecond = registry.add({ bytes: bytes("same bytes 123"), kind: "file", origin: "/secret/a.txt", private: screenRegistration({ bytes: bytes("same bytes 123"), kind: "file", path: "/project/secret/a.txt" }, policy({ matchesPolicy: () => true, piiPaths: ["secret"] })).private });
  expect(publicFirst.private).toBe(false);
  expect(privateSecond).toMatchObject({ id: publicFirst.id, private: true, upgraded: true });
});

// --- the URL fetch -----------------------------------------------------------------------------------------------------------------------------

const response = (body: string | Uint8Array, init: { status?: number; headers?: Record<string, string> } = {}) => new Response(body, { status: init.status ?? 200, headers: init.headers });
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

test("only plain https URLs are accepted: http, other schemes, credentials and junk are refused before any connection", async () => {
  for (const bad of ["http://example.com/a", "ftp://example.com/a", "file:///etc/passwd", "https://user:pw@example.com/a", "https://user@example.com/", "javascript:alert(1)", "not a url", "", "//example.com"]) {
    expect(() => checkSourceUrl(bad), bad).toThrow();
    let called = false;
    await expect(fetchSourceUrl(bad, { fetch: async () => { called = true; return response("x"); } })).rejects.toThrow();
    expect(called).toBe(false);
  }
  expect(checkSourceUrl("https://example.com/a?b=1#c").hostname).toBe("example.com");
});

test("a URL is fetched once, with redirects followed by hand, at most five", async () => {
  const calls: string[] = [];
  const hops = (count: number) => async (input: string) => { calls.push(input); const n = calls.length - 1; return n < count ? redirect(`https://example.com/hop${n + 1}`) : response("final body"); };
  const five = await fetchSourceUrl("https://example.com/start", { fetch: hops(MAX_REDIRECTS) });
  expect(five).toMatchObject({ redirects: 5, finalUrl: "https://example.com/hop5" });
  expect(five.bytes.toString()).toBe("final body");
  expect(calls).toHaveLength(6);
  calls.length = 0;
  await expect(fetchSourceUrl("https://example.com/start", { fetch: hops(MAX_REDIRECTS + 1) })).rejects.toThrow("more than 5 redirects");
  expect(calls).toHaveLength(6); // the sixth redirect is refused without a seventh request
  calls.length = 0;
  const direct = await fetchSourceUrl("https://example.com/plain", { fetch: async input => { calls.push(input); return response("x"); } });
  expect(direct.redirects).toBe(0);
  expect(calls).toEqual(["https://example.com/plain"]);
});

test("a redirect to http, to a credentialed URL or to another scheme is refused, and a relative redirect resolves against the current URL", async () => {
  for (const target of ["http://example.com/a", "https://u:p@example.com/a", "ftp://example.com/a", "file:///etc/passwd"]) {
    await expect(fetchSourceUrl("https://example.com/start", { fetch: async () => redirect(target) }), target).rejects.toThrow("redirect refused");
  }
  const seen: string[] = [];
  const result = await fetchSourceUrl("https://example.com/dir/start", { fetch: async input => { seen.push(input); return seen.length === 1 ? redirect("../other") : response("ok"); } });
  expect(seen).toEqual(["https://example.com/dir/start", "https://example.com/other"]);
  expect(result.finalUrl).toBe("https://example.com/other");
  // a 3xx with no location is a failure, not a body
  await expect(fetchSourceUrl("https://example.com/x", { fetch: async () => response("moved", { status: 301 }) })).rejects.toThrow("HTTP 301");
});

test("the body is capped while it streams: a declared size over the cap, an endless stream and an exact-cap body", async () => {
  await expect(fetchSourceUrl("https://example.com/big", { maxBytes: 10, fetch: async () => response("x".repeat(11), { headers: { "content-length": "11" } }) })).rejects.toThrow("over the 10 byte cap");
  // a server that lies about, or omits, the length is cut off at the cap and not buffered whole
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 4; controller.enqueue(new Uint8Array(4)); } });
  await expect(fetchSourceUrl("https://example.com/endless", { maxBytes: 16, fetch: async () => new Response(endless) })).rejects.toThrow("over the 16 byte cap");
  expect(pulled).toBeLessThan(64);
  // A declared size over the cap is refused before the body is read at all: the stream is never pulled.
  let read = 0;
  const declared = new ReadableStream<Uint8Array>({ pull(controller) { read++; controller.enqueue(new Uint8Array(4)); } });
  await expect(fetchSourceUrl("https://example.com/declared", { maxBytes: 10, fetch: async () => new Response(declared, { headers: { "content-length": "9999" } }) })).rejects.toThrow("9999 bytes, over the 10 byte cap");
  expect(read).toBeLessThanOrEqual(1);
  const exact = await fetchSourceUrl("https://example.com/exact", { maxBytes: 10, fetch: async () => response("x".repeat(10)) });
  expect(exact.bytes.length).toBe(10);
  await expect(fetchSourceUrl("https://example.com/missing", { fetch: async () => response("gone", { status: 404 }) })).rejects.toThrow("HTTP 404");
});

test("the fetch sends no credentials and never follows redirects itself", async () => {
  let init: { redirect?: string; headers?: Record<string, string> } = {};
  await fetchSourceUrl("https://example.com/a", { fetch: async (_url, i) => { init = i; return response("x"); } });
  expect(init.redirect).toBe("manual");
  expect(Object.keys(init.headers ?? {}).map(key => key.toLowerCase()).sort()).toEqual(["accept", "user-agent"]);
});

// Review of PR #907 (codex-review): three defects, one test each.

test("a record with the most origins the writer accepts is read back, and a later add never replaces it", () => {
  const dir = state(), registry = new SourceRegistry(dir), data = bytes("many origins");
  const id = registry.add({ bytes: data, kind: "file", origin: "/first", private: true, now: 1 }).id;
  // every origin as long as the cap, and 3-byte characters: the largest meta the writer can make
  for (let i = 0; i < MAX_ORIGINS - 1; i++) registry.add({ bytes: data, kind: "file", origin: `/o${i}/` + "€".repeat(MAX_ORIGIN_CHARS - 10), private: true, now: 2 + i });
  const file = join(dir, "sources", `src-${id.slice(4)}`, "meta.json");
  expect(statSync(file).size).toBeGreaterThan(64 * 1024); // the old reader cap
  expect(statSync(file).size).toBeLessThan(MAX_META_BYTES);
  const meta = registry.get(id)!;
  expect(meta.private).toBe(true);
  expect(meta.origins).toHaveLength(MAX_ORIGINS);
  const before = readFileSync(file);
  expect(() => registry.add({ bytes: data, kind: "file", origin: "/public", private: false })).toThrow(`${MAX_ORIGINS} origins`);
  expect(readFileSync(file)).toEqual(before);
  expect(registry.add({ bytes: data, kind: "file", origin: "/first", private: true })).toMatchObject({ id, created: false, private: true });
  expect(registry.readRaw(id)).toEqual(data);
});

test("a directory whose meta.json exists but cannot be read is refused and left untouched, never replaced as public", () => {
  const dir = state(), registry = new SourceRegistry(dir), data = bytes("keep me");
  const id = registry.add({ bytes: data, kind: "file", origin: "/secret", private: true }).id;
  const folder = join(dir, "sources", `src-${id.slice(4)}`);
  writeFileSync(join(folder, "meta.json"), "{ not json");
  expect(() => registry.add({ bytes: data, kind: "file", origin: "/again", private: false })).toThrow("cannot be read");
  expect(readFileSync(join(folder, "meta.json"), "utf8")).toBe("{ not json");
  expect(readFileSync(join(folder, "raw"))).toEqual(data);
});

test("plain text up to the raw cap is stored and read back whole, and text over the cap is refused before anything is written", () => {
  const dir = state(), registry = new SourceRegistry(dir);
  expect(MAX_SOURCE_TEXT).toBe(MAX_SOURCE_BYTES);
  const big = "a".repeat(600 * 1024); // over the old 512 KiB read cap
  const added = registry.add({ bytes: bytes(big), kind: "file", origin: "/big.txt", private: false, text: big });
  expect(added.text).toBe(true);
  expect(registry.readText(added.id)).toBe(big);
  expect(() => registry.add({ bytes: bytes("small"), kind: "file", origin: "/s", private: false, text: "a".repeat(MAX_SOURCE_TEXT + 1) })).toThrow("text is over");
  expect(registry.list()).toHaveLength(1);
});

const lockFile = (dir: string) => join(dir, "sources", ".lock");
const hold = (dir: string, owner: unknown) => { mkdirSync(join(dir, "sources"), { recursive: true }); writeFileSync(lockFile(dir), JSON.stringify(owner)); };

test("a registration waits for a live holder and gives up with the lock named, never taking it", () => {
  const dir = state(), registry = new SourceRegistry(dir, { lockWaitMs: 150 });
  hold(dir, { pid: process.pid, signature: processSignature(process.pid) });
  const started = Date.now();
  expect(() => registry.add({ bytes: bytes("x"), kind: "file", origin: "/x", private: false })).toThrow("holds");
  expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  expect(existsSync(lockFile(dir))).toBe(true);
  expect(registry.list()).toEqual([]);
});

test("a lock whose holder is gone is never removed on anyone's behalf: the add fails closed naming the file, and the lock file is untouched", () => {
  const dir = state(), registry = new SourceRegistry(dir, { lockWaitMs: 2000 });
  hold(dir, { pid: process.pid, signature: "0".repeat(64) }); // this pid, another process identity: a reused pid, so the holder is gone
  const before = statSync(lockFile(dir));
  expect(() => registry.add({ bytes: bytes("x"), kind: "file", origin: "/x", private: false })).toThrow("never removed automatically");
  const after = statSync(lockFile(dir));
  expect([after.ino, after.dev]).toEqual([before.ino, before.dev]);
  expect(readFileSync(lockFile(dir), "utf8")).toContain("0".repeat(64));
  expect(registry.list()).toEqual([]);
  rmSync(lockFile(dir)); // the person's repair
  expect(registry.add({ bytes: bytes("x"), kind: "file", origin: "/x", private: false }).created).toBe(true);
  expect(existsSync(lockFile(dir))).toBe(false);
});

test("the lock is released after the add, also when it fails, and no temp file is left behind", () => {
  const dir = state(), registry = new SourceRegistry(dir, { lockWaitMs: 2000 });
  expect(() => registry.add({ bytes: bytes("x"), kind: "file", origin: "bad\norigin", private: false })).toThrow();
  const original = SourceRegistry.prototype.get;
  SourceRegistry.prototype.get = () => { throw new Error("boom"); };
  try { expect(() => registry.add({ bytes: bytes("y"), kind: "file", origin: "/y", private: false })).toThrow("boom"); } finally { SourceRegistry.prototype.get = original; }
  expect(existsSync(lockFile(dir))).toBe(false);
  expect(readdirSync(join(dir, "sources")).filter(name => name.startsWith(".lock"))).toEqual([]);
});

test("a lock file is never seen half written: it is linked in whole, so a contender always reads an owner", () => {
  const dir = state(), registry = new SourceRegistry(dir, { lockWaitMs: 100 });
  let seen: string | undefined;
  const original = SourceRegistry.prototype.get;
  SourceRegistry.prototype.get = function (this: SourceRegistry, id: string) { seen = readFileSync(lockFile(dir), "utf8"); return original.call(this, id); };
  try { registry.add({ bytes: bytes("z"), kind: "file", origin: "/z", private: false }); } finally { SourceRegistry.prototype.get = original; }
  expect(JSON.parse(seen!)).toEqual({ pid: process.pid, signature: processSignature(process.pid) ?? null });
});

test("several processes finding a dead holder's lock at once all fail and none removes it, so none runs beside another", async () => {
  // The reviewed interleaving: two recoverers inspect the same stale lock, one removes it and takes a new one, the other's removal then deletes the new lock.
  // With no removal at all, that cannot happen: every contender fails, the lock file is the same one, and nothing was registered.
  const dir = state(), module = join(import.meta.dir, "..", "src", "hub", "sources.ts"), script = join(dir, "recover.ts");
  hold(dir, { pid: process.pid, signature: "0".repeat(64) });
  const before = statSync(lockFile(dir));
  writeFileSync(script, `import { SourceRegistry } from ${JSON.stringify(module)};
try { new SourceRegistry(process.argv[2]!, { lockWaitMs: 3000 }).add({ bytes: Buffer.from("race " + process.argv[3]), kind: "file", origin: "/r", private: process.argv[3] === "1" }); console.log("ADDED"); }
catch (error) { console.log("REFUSED " + (error as Error).message.includes("never removed automatically")); }`);
  const procs = Array.from({ length: 8 }, (_, i) => Bun.spawn([process.execPath, script, dir, String(i)], { stdout: "pipe", stderr: "pipe" }));
  const outputs = await Promise.all(procs.map(async proc => { const text = await new Response(proc.stdout).text(); await proc.exited; return text.trim(); }));
  expect(outputs).toEqual(Array(8).fill("REFUSED true"));
  const after = statSync(lockFile(dir));
  expect([after.ino, after.dev]).toEqual([before.ino, before.dev]);
  expect(new SourceRegistry(dir).list()).toEqual([]);
});

test("separate processes adding the same bytes, some private and some public, always leave the record private", async () => {
  const dir = state(), data = "shared bytes for a race";
  const script = join(dir, "add.ts"), module = join(import.meta.dir, "..", "src", "hub", "sources.ts");
  writeFileSync(script, `import { SourceRegistry } from ${JSON.stringify(module)};
const [dir, flag, origin] = process.argv.slice(2);
for (let i = 0; i < 15; i++) new SourceRegistry(dir).add({ bytes: Buffer.from(${JSON.stringify(data)}), kind: "file", origin: origin + i, private: flag === "private" });`);
  const procs = Array.from({ length: 6 }, (_, i) => Bun.spawn([process.execPath, script, dir, i === 3 ? "private" : "public", `/p${i}/`], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(procs.map(async proc => ({ code: await proc.exited, stderr: await new Response(proc.stderr).text() })));
  expect(results).toEqual(Array.from({ length: 6 }, () => ({ code: 0, stderr: "" })));
  const registry = new SourceRegistry(dir), id = sourceId(sha256Of(bytes(data)));
  expect(registry.get(id)!.private).toBe(true);
  expect(registry.get(id)!.origins.length).toBe(6 * 15);
  expect(existsSync(lockFile(dir))).toBe(false);
});


test("source record capacity ignores lock, temporary, partial and damaged directory entries", () => {
  const dir = state(), registry = new SourceRegistry(dir);
  mkdirSync(registry.root, { recursive: true });
  // Build metadata directly to avoid O(cap squared) registration scans. Every
  // row is validated by the real get/list parser; this case does not read raw.
  const firstSha = "0".repeat(64);
  for (let i = 0; i < MAX_SOURCES - 1; i++) {
    const prefix = i.toString(16).padStart(16, "0"), sha256 = prefix + "0".repeat(48);
    const folder = join(registry.root, `src-${prefix}`);
    mkdirSync(folder);
    writeFileSync(join(folder, "meta.json"), JSON.stringify({ id: sourceId(sha256), sha256, kind: "file", origin: "/fixture", bytes: 0, added_at: i, private: false, origins: [{ kind: "file", origin: "/fixture", added_at: i, private: false }] }));
  }
  for (const name of [".lock.contender.tmp", ".abandoned.partial", "src-0000000000000000.abandoned.partial", "src-ffffffffffffffff"]) mkdirSync(join(registry.root, name));
  hold(dir, { pid: process.pid, signature: processSignature(process.pid) });
  expect(registry.list()).toHaveLength(MAX_SOURCES - 1);
  rmSync(lockFile(dir));
  const last = registry.add({ bytes: bytes("last allowed source"), kind: "file", origin: "/last", private: false });
  expect(last.created).toBe(true);
  expect(registry.list()).toHaveLength(MAX_SOURCES);
  const overflow = bytes("not allowed source"), overflowId = sourceId(sha256Of(overflow));
  expect(() => registry.add({ bytes: overflow, kind: "file", origin: "/overflow", private: false })).toThrow(`${MAX_SOURCES} sources`);
  // An empty crash directory must not bypass the new-record admission check.
  const partial = join(registry.root, `src-${overflowId.slice(4)}`);
  mkdirSync(partial);
  expect(() => registry.add({ bytes: overflow, kind: "file", origin: "/overflow", private: false })).toThrow(`${MAX_SOURCES} sources`);
  expect(readdirSync(partial)).toEqual([]);
  // At source capacity, an existing record can still upgrade privacy/provenance.
  expect(registry.add({ bytes: bytes("last allowed source"), kind: "file", origin: "/private/last", private: true })).toMatchObject({ created: false, upgraded: true, private: true });
  expect(registry.get(last.id)!.origins).toHaveLength(2);
  expect(registry.get(sourceId(firstSha))).toBeDefined();
  expect(registry.list()).toHaveLength(MAX_SOURCES);
  // Legacy/out-of-band over-cap state is reported, never a silently cut list.
  const extraSha = "e".repeat(64), extra = join(registry.root, `src-${extraSha.slice(0, 16)}`);
  mkdirSync(extra);
  writeFileSync(join(extra, "meta.json"), JSON.stringify({ id: sourceId(extraSha), sha256: extraSha, kind: "file", origin: "/extra", bytes: 0, added_at: 1, private: false, origins: [{ kind: "file", origin: "/extra", added_at: 1, private: false }] }));
  expect(() => registry.list()).toThrow(`${MAX_SOURCES} sources`);
});


test("an unseen origin at capacity is refused without claiming a registration or changing privacy", () => {
  const dir = state(), registry = new SourceRegistry(dir), data = bytes("full public provenance");
  const id = registry.add({ bytes: data, kind: "file", origin: "/public/0", private: false }).id;
  for (let i = 1; i < MAX_ORIGINS; i++) registry.add({ bytes: data, kind: "file", origin: `/public/${i}`, private: false });
  const file = join(registry.root, `src-${id.slice(4)}`, "meta.json"), before = readFileSync(file);
  expect(() => registry.add({ bytes: data, kind: "file", origin: "/new/private", private: true })).toThrow(`${MAX_ORIGINS} origins`);
  expect(readFileSync(file)).toEqual(before);
  expect(registry.get(id)!.private).toBe(false); // refused attempts are not registrations
  expect(registry.get(id)!.origins).toHaveLength(MAX_ORIGINS);
  expect(registry.add({ bytes: data, kind: "file", origin: "/public/0", private: false })).toMatchObject({ created: false, private: false });
});


test("a lock released or replaced during its owner's liveness probe is retried, never called stale", () => {
  for (const mode of ["released", "replaced"] as const) {
    const dir = state(), registry = new SourceRegistry(dir, { lockWaitMs: 1000 });
    hold(dir, { pid: process.pid, signature: "0".repeat(64) });
    const live = { pid: process.pid, signature: processSignature(process.pid) ?? null };
    const probe = spyOn(platform, "processLiveness").mockImplementationOnce(() => {
      // Simulate the old holder's normal release while its liveness was checked.
      rmSync(lockFile(dir));
      if (mode === "replaced") {
        const next = join(dir, "sources", ".next-owner");
        writeFileSync(next, JSON.stringify(live));
        renameSync(next, lockFile(dir));
      }
      return "gone";
    }).mockImplementationOnce((pid, signature) => {
      expect({ pid, signature }).toEqual(live);
      // The replacement holder now releases its own fixture lock normally.
      rmSync(lockFile(dir));
      return "live";
    });
    try {
      expect(() => registry.add({ bytes: bytes(mode), kind: "file", origin: "/race", private: true })).not.toThrow();
      expect(probe).toHaveBeenCalledTimes(mode === "released" ? 1 : 2);
      expect(registry.list()).toHaveLength(1);
      expect(existsSync(lockFile(dir))).toBe(false);
    } finally { probe.mockRestore(); }
  }
});
