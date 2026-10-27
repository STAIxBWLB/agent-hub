import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesPolicy } from "../src/hub/path-policy.ts";
import { checkSourceUrl, fetchSourceUrl, MAX_REDIRECTS, MAX_SOURCE_BYTES, publicSourceView, screenRegistration, sha256Of, SourceRegistry, sourceId, validSourceId } from "../src/hub/sources.ts";
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
