import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { checkTriggerFolder, FolderStore, MAX_FOLDER_ENTRIES, MAX_HASH_FILES, readScanned, registerScanned, scanFolder, type FolderPolicy } from "../src/hub/folder-trigger.ts";
import { folderDetail, folderGlobMatches, foldersConfig, FOLDER_MARKER, type FolderEntry, type ScannedFile } from "../src/hub/schedules.ts";
import { SourceRegistry } from "../src/hub/sources.ts";

// agent-hub #512c (hub task #336): the polled folder trigger. Spec: "Schedules and folder triggers (#512)".
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean | Promise<boolean>, label: string, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (!(await condition()) && Date.now() < deadline) await Bun.sleep(10);
  expect(await condition(), label).toBe(true);
};
const T0 = 1_800_000_000_000;
const ENTRY: FolderEntry = { id: "inbox", folder: "inbox", class: "plan", title: "A new file arrived", queue: "backlog" };

/** A project directory with an `inbox/` folder. Everything is removed afterwards. */
function tree() {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-folder-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "inbox"));
  const policy: FolderPolicy = { cwd: dir, dataPaths: [], piiPaths: [], deny: [] };
  const put = (name: string, text: string) => { writeFileSync(join(dir, "inbox", name), text); };
  return { dir, policy, put };
}

// ---- the pure config

test("foldersConfig checks every field and names the entry it refuses", () => {
  expect(foldersConfig(undefined)).toEqual([]);
  expect(foldersConfig([{ id: "in", folder: "inbox", glob: "*.pdf", class: "plan", title: "  New   file ", detail: "d", owner: "codex", queue: "ready" }]))
    .toEqual([{ id: "in", folder: "inbox", glob: "*.pdf", class: "plan", title: "New file", detail: "d", owner: "codex", queue: "ready" }]);
  expect(foldersConfig([{ id: "in", folder: "inbox", class: "plan", title: "t" }])[0]).toMatchObject({ queue: "backlog" });
  const refused: [unknown, string][] = [
    ["x", "must be a list"], [Array.from({ length: 17 }, (_, i) => ({ id: `t${i}`, folder: "a", class: "plan", title: "t" })), "at most 16"], [[5], "must be an object"],
    [[{ id: "Bad Id", folder: "a", class: "plan", title: "t" }], "id is 1 to 48"], [[{ id: "a", folder: "a", class: "plan", title: "t", extra: 1 }], "unknown key extra"],
    [[{ id: "a", class: "plan", title: "t" }], "folder"], [[{ id: "a", folder: "~/x", class: "plan", title: "t" }], "~ is not expanded"],
    [[{ id: "a", folder: "a\u0000b", class: "plan", title: "t" }], "control characters"],
    [[{ id: "a", folder: "a", glob: "../x", class: "plan", title: "t" }], "never a path"], [[{ id: "a", folder: "a", glob: "a/b", class: "plan", title: "t" }], "never a path"],
    [[{ id: "a", folder: "a", glob: "..", class: "plan", title: "t" }], "never a path"], [[{ id: "a", folder: "a", glob: "", class: "plan", title: "t" }], "never a path"],
    [[{ id: "a", folder: "a", class: "", title: "t" }], "class is required"], [[{ id: "a", folder: "a", class: "plan", title: "" }], "title is 1 to 300"],
    [[{ id: "a", folder: "a", class: "plan", title: "t\nu" }], "title is 1 to 300"], [[{ id: "a", folder: "a", class: "plan", title: "t", owner: "Not A Peer" }], "owner is a peer id"],
    [[{ id: "a", folder: "a", class: "plan", title: "t", queue: "now" }], "queue is"], [[{ id: "a", folder: "a", class: "plan", title: "t" }, { id: "a", folder: "b", class: "plan", title: "t" }], "duplicate id"],
  ];
  for (const [input, reason] of refused) expect(() => foldersConfig(input), reason).toThrow(reason);
  try { foldersConfig([{ id: "in", folder: "inbox", glob: "../x", class: "plan", title: "t" }]); } catch (error) { expect((error as Error).message).toContain("folder_triggers.in"); }
});

test("a glob is a file-name pattern: it matches whole names, never hidden files and never across a slash", () => {
  expect(folderGlobMatches("*.pdf", "a.pdf")).toBe(true);
  expect(folderGlobMatches("*.pdf", "a.PDF")).toBe(false);
  expect(folderGlobMatches("*.pdf", "a.pdf.txt")).toBe(false);
  expect(folderGlobMatches("r?port.*", "report.md")).toBe(true);
  expect(folderGlobMatches("a.b", "aXb")).toBe(false); // a dot in a glob is a dot
  expect(folderGlobMatches(undefined, "anything")).toBe(true);
  expect(folderGlobMatches(undefined, ".hidden")).toBe(false);
  expect(folderGlobMatches("*", ".hidden")).toBe(false);
});

test("the task detail names the trigger and the source, never the file", () => {
  const detail = folderDetail({ ...ENTRY, detail: "Summarise it." }, "src:0123456789abcdef");
  expect(detail.split("\n")[0]).toBe(`${FOLDER_MARKER}inbox`);
  expect(detail).toContain("Summarise it.");
  expect(detail.trimEnd().endsWith("Source: src:0123456789abcdef")).toBe(true);
});

// ---- the folder rule

test("a folder inside the project is allowed; a data folder is allowed only when declared; anything else is refused with a reason", () => {
  const t = tree();
  expect(checkTriggerFolder(ENTRY, t.policy)).toEqual({ ok: true, real: join(t.dir, "inbox") });
  const outside = realPath(mkdtempSync(join(tmpdir(), "ahub-folder-out-"))); cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
  const abs: FolderEntry = { ...ENTRY, folder: outside };
  const refused = checkTriggerFolder(abs, t.policy);
  expect(refused.ok).toBe(false); expect((refused as { reason: string }).reason).toContain("outside the project");
  expect(checkTriggerFolder(abs, { ...t.policy, dataPaths: [outside] })).toEqual({ ok: true, real: outside });
  expect(checkTriggerFolder({ ...ENTRY, folder: "missing" }, t.policy)).toMatchObject({ ok: false });
  expect(checkTriggerFolder({ ...ENTRY, folder: "../escape" }, t.policy)).toMatchObject({ ok: false });
});

test("a symlinked folder that points outside the project is judged by where it lands", () => {
  const t = tree();
  const outside = realPath(mkdtempSync(join(tmpdir(), "ahub-folder-out-"))); cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(t.dir, "linked"));
  const result = checkTriggerFolder({ ...ENTRY, folder: "linked" }, t.policy);
  expect(result.ok).toBe(false); expect((result as { reason: string }).reason).toContain("outside the project");
});

test("a folder under pii.paths, on the denylist, or holding an Obsidian vault is refused", () => {
  const t = tree();
  mkdirSync(join(t.dir, "private")); mkdirSync(join(t.dir, "vault", ".obsidian"), { recursive: true }); mkdirSync(join(t.dir, "secrets"));
  expect(checkTriggerFolder({ ...ENTRY, folder: "private" }, { ...t.policy, piiPaths: ["private"] })).toMatchObject({ ok: false });
  expect((checkTriggerFolder({ ...ENTRY, folder: "vault" }, t.policy) as { reason: string }).reason).toContain("Obsidian");
  expect(checkTriggerFolder({ ...ENTRY, folder: "secrets" }, { ...t.policy, deny: ["secrets"] })).toMatchObject({ ok: false });
});

// ---- the scan

test("the scan reads regular files directly in the folder with size, mtime and SHA-256, in name order, and nothing else", () => {
  const t = tree();
  t.put("b.txt", "bee"); t.put("a.txt", "ay"); t.put(".hidden", "no"); mkdirSync(join(t.dir, "inbox", "sub")); writeFileSync(join(t.dir, "inbox", "sub", "deep.txt"), "deep");
  const scan = scanFolder(ENTRY, t.policy);
  expect(scan.refused).toBeUndefined();
  expect(scan.files.map(file => file.name)).toEqual(["a.txt", "b.txt"]);
  const a = scan.files[0]!;
  expect(a).toMatchObject({ real: join(t.dir, "inbox", "a.txt"), size: 2 });
  expect(a.sha256).toBe(new Bun.CryptoHasher("sha256").update("ay").digest("hex"));
  expect(a.mtime).toBeGreaterThan(0);
  expect("bytes" in a).toBe(false); // a scan keeps no file's bytes
  expect(readScanned(a)!.toString()).toBe("ay");
  expect(scan.skipped.map(row => row.reason)).toEqual(["not a regular file"]); // the subfolder; the dot file is not even a candidate
});

test("a scan holds no file's bytes and hashes at most MAX_HASH_FILES files, leaving the rest for the next poll", () => {
  const t = tree();
  for (let i = 0; i < MAX_HASH_FILES + 30; i++) t.put(`f${String(i).padStart(4, "0")}.txt`, `file ${i}`);
  const first = scanFolder(ENTRY, t.policy);
  expect(first.files).toHaveLength(MAX_HASH_FILES); expect(first.truncated).toBe(true);
  expect(first.files.every(file => !("bytes" in file))).toBe(true);
  expect(first.files[0]!.name).toBe("f0000.txt");
  // the files already recorded at their path, size and mtime cost an lstat and are not hashed again, so the next poll reaches the rest
  const known = new Map(first.files.map(file => [`${file.real}|${file.size}|${file.mtime}`, file.sha256]));
  const second = scanFolder(ENTRY, t.policy, (real, size, mtime) => known.get(`${real}|${size}|${mtime}`));
  expect(second.files).toHaveLength(MAX_HASH_FILES + 30); expect(second.truncated).toBe(false);
  expect(second.files.filter(file => file.seen)).toHaveLength(MAX_HASH_FILES);
  expect(second.files.filter(file => !file.seen).map(file => file.name)).toEqual(Array.from({ length: 30 }, (_, i) => `f${String(MAX_HASH_FILES + i).padStart(4, "0")}.txt`));
});

test("a file late in name order is reached once the earlier ones are recorded, however many hidden or unmatched names sort before it", () => {
  const t = tree();
  for (let i = 0; i < 2500; i++) writeFileSync(join(t.dir, "inbox", `.h${String(i).padStart(4, "0")}`), "x"); // hidden: never candidates, but they sort first
  for (let i = 0; i < 300; i++) t.put(`a${String(i).padStart(4, "0")}.txt`, `a${i}`);
  t.put("zz-last.txt", "the late one");
  let known = new Map<string, string>();
  const names = new Set<string>();
  for (let poll = 0; poll < 5 && !names.has("zz-last.txt"); poll++) {
    const scan = scanFolder(ENTRY, t.policy, (real, size, mtime) => known.get(`${real}|${size}|${mtime}`));
    for (const file of scan.files) { known.set(`${file.real}|${file.size}|${file.mtime}`, file.sha256); names.add(file.name); }
  }
  expect(names.has("zz-last.txt")).toBe(true);
  expect(names.size).toBe(301);
});

test("a folder with more entries than the limit is refused as not an inbox with a reason, not silently truncated", () => {
  const t = tree(); for (let i = 0; i < 6; i++) t.put(`f${i}.txt`, `x${i}`);
  const refused = scanFolder(ENTRY, t.policy, undefined, { entries: 5 });
  expect(refused.refused).toContain("holds more than 5 entries"); expect(refused.files).toEqual([]);
  expect(scanFolder(ENTRY, t.policy, undefined, { entries: 6 }).files).toHaveLength(6);
  expect(MAX_FOLDER_ENTRIES).toBe(100_000);
});

test("readScanned returns the bytes only while they still hash to what the scan saw", () => {
  const t = tree(); t.put("a.txt", "original");
  const file = scanFolder(ENTRY, t.policy).files[0]!;
  expect(readScanned(file)!.toString()).toBe("original");
  writeFileSync(join(t.dir, "inbox", "a.txt"), "tampered"); // same size, new content
  expect(readScanned(file)).toBeUndefined();
  writeFileSync(join(t.dir, "inbox", "a.txt"), "longer than before");
  expect(readScanned(file)).toBeUndefined();
  // a scan record that claims a smaller size than the file now has is refused by the size check, with no read of the larger content
  writeFileSync(join(t.dir, "inbox", "a.txt"), "original");
  expect(readScanned({ ...file, size: 3 }), "a size that differs from the file's is refused").toBeUndefined();
  expect(readScanned(file)!.toString()).toBe("original");
  rmSync(join(t.dir, "inbox", "a.txt"));
  expect(readScanned(file)).toBeUndefined();
  const outside = realPath(mkdtempSync(join(tmpdir(), "ahub-folder-out-"))); cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "x.txt"), "original");
  symlinkSync(join(outside, "x.txt"), join(t.dir, "inbox", "a.txt"));
  expect(readScanned(file), "a link put in the file's place is never followed").toBeUndefined();
});

test("a glob filters the scan", () => {
  const t = tree(); t.put("a.pdf", "1"); t.put("b.txt", "2");
  expect(scanFolder({ ...ENTRY, glob: "*.pdf" }, t.policy).files.map(file => file.name)).toEqual(["a.pdf"]);
});

test("a symlink is never read: one that leaves the folder and one that stays are both skipped, with their reasons", () => {
  const t = tree();
  const outside = realPath(mkdtempSync(join(tmpdir(), "ahub-folder-out-"))); cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
  t.put("real.txt", "ok");
  symlinkSync(join(outside, "secret.txt"), join(t.dir, "inbox", "leaves.txt"));
  symlinkSync(join(t.dir, "inbox", "real.txt"), join(t.dir, "inbox", "stays.txt"));
  symlinkSync(join(t.dir, "inbox", "nowhere"), join(t.dir, "inbox", "dangling.txt"));
  const scan = scanFolder(ENTRY, t.policy);
  expect(scan.files.map(file => file.name)).toEqual(["real.txt"]);
  expect(Object.fromEntries(scan.skipped.map(row => [row.name, row.reason]))).toEqual({ "leaves.txt": "symlink leaving the folder", "stays.txt": "symlink", "dangling.txt": "symlink leaving the folder" });
  expect(JSON.stringify(scan.files)).not.toContain("TOP SECRET");
});

test("a file on the denylist and a file over the source cap are skipped, not read", () => {
  const t = tree(); t.put(".env", "x"); t.put("id_rsa", "key"); t.put("fine.txt", "ok");
  const scan = scanFolder(ENTRY, { ...t.policy, deny: ["id_rsa"] });
  expect(scan.files.map(file => file.name)).toEqual(["fine.txt"]);
  expect(scan.skipped.map(row => [row.name, row.reason])).toEqual([["id_rsa", "on the denylist"]]);
});

test("a folder that cannot be read is a refusal with a reason, not a throw", () => {
  const t = tree();
  const scan = scanFolder({ ...ENTRY, folder: "missing" }, t.policy);
  expect(scan.refused).toContain("missing"); expect(scan.files).toEqual([]);
});

// ---- the store

test("the store records files by trigger, path, size, mtime and hash, and a trigger's rows go when it is removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-folder-store-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FolderStore(join(dir, "hub.db")); cleanup.push(() => store.close());
  const file = { real: "/p/a.txt", size: 3, mtime: 1000, sha256: "a".repeat(64) };
  expect(store.baselined("t")).toBe(false);
  store.begin("t", 5); store.begin("t", 99);
  expect(store.baselined("t")).toBe(false);
  store.markBaselined("t", 6);
  expect(store.baselined("t")).toBe(true);
  expect(store.isNew("t", file.sha256)).toBe(true);
  store.record("t", file, 7, 10);
  expect(store.isNew("t", file.sha256)).toBe(false);
  expect(store.isNew("other", file.sha256)).toBe(true); // per trigger
  expect(store.rows("t")).toEqual([{ trigger: "t", real_path: "/p/a.txt", size: 3, mtime: 1000, sha256: file.sha256, task: 7, at: 10 }]);
  store.record("other", file, null, 11);
  store.prune(["other"]);
  expect(store.rows("t")).toEqual([]); expect(store.baselined("t")).toBe(false); expect(store.rows("other")).toHaveLength(1);
  new FolderStore(join(dir, "hub.db")).close(); // reopening changes nothing
});

// ---- the pass, on the Tasks layer

function rig(options: { piiPatterns?: string[]; held?: () => boolean } = {}) {
  const t = tree();
  const board = new Board(join(t.dir, "hub.db")), bus = new Bus({ batchMs: 0 }), store = new FolderStore(join(t.dir, "hub.db"));
  const registry = new SourceRegistry(join(t.dir, "state"));
  const tasks = new Tasks({ cwd: t.dir, board, bus, roles: {}, project: "fixture", routing: () => {
    const routing = loadRouting(t.dir);
    return options.piiPatterns ? { ...routing, signals: { ...routing.signals, pii_patterns: options.piiPatterns } } : routing;
  }, notify: () => {} });
  cleanup.push(() => { store.close(); bus.closeJournal(); board.close(); });
  const registered: ScannedFile[] = [];
  // the function the daemon calls, over this rig's registry and patterns
  const register = (file: ScannedFile) => { registered.push(file); return registerScanned(file, { registry, cwd: t.dir, piiPaths: t.policy.piiPaths, piiPatterns: () => options.piiPatterns ?? [] }); };
  const poll = (entries: readonly FolderEntry[] = [ENTRY], now = T0) => tasks.runFolderTriggers(store, entries, entry => scanFolder(entry, t.policy, (real, size, mtime) => store.known(entry.id, real, size, mtime)), register, now, options.held ?? (() => false));
  const made = () => board.list().filter(task => task.detail.startsWith(FOLDER_MARKER));
  return { ...t, board, tasks, store, registry, registered, poll, made };
}

test("the first poll records what is already there and proposes nothing; only a file that arrives later is new", async () => {
  const r = rig(); r.put("old1.txt", "one"); r.put("old2.txt", "two");
  expect(await r.poll()).toEqual([{ id: "inbox", outcome: "baseline", tasks: [], files: 2 }]);
  expect(r.made()).toHaveLength(0); expect(r.registered).toHaveLength(0); expect(r.registry.list()).toHaveLength(0);
  expect(r.store.rows("inbox")).toHaveLength(2);
  expect(await r.poll()).toEqual([{ id: "inbox", outcome: "none", tasks: [], files: 0 }]); // nothing changed
  r.put("new.txt", "three");
  const [run] = await r.poll();
  expect(run).toMatchObject({ id: "inbox", outcome: "ran", files: 1 });
  expect(run!.tasks).toHaveLength(1);
  expect(r.made()).toHaveLength(1);
});

test("a new file is registered as a source and proposes one task that names it, and nothing about the file's name", async () => {
  const r = rig(); await r.poll();
  r.put("quarterly-report-FINAL.txt", "the numbers");
  const [run] = await r.poll();
  const task = r.board.get(run!.tasks[0]!)!;
  expect(task).toMatchObject({ title: "A new file arrived", class: "plan", state: "backlog" });
  expect(task.history[0]).toMatchObject({ by: "hub" });
  const sources = r.registry.list();
  expect(sources).toHaveLength(1);
  expect(sources[0]).toMatchObject({ kind: "file", bytes: 11, private: false, origin: join(r.dir, "inbox", "quarterly-report-FINAL.txt") });
  expect(task.detail).toContain(`Source: ${sources[0]!.id}`);
  expect(task.detail.startsWith(`${FOLDER_MARKER}inbox`)).toBe(true);
  expect(task.detail).not.toContain("quarterly-report"); expect(task.title).not.toContain("quarterly-report");
  expect(r.registry.readText(sources[0]!.id)).toBe("the numbers");
  expect(r.store.rows("inbox").find(row => row.real_path.endsWith("FINAL.txt"))).toMatchObject({ size: 11, task: task.id, sha256: sources[0]!.sha256 });
});

test("ONLY a new file proposes: a rename and a touch with the same hash propose nothing, a copy of the same bytes is not new, changed bytes are", async () => {
  const r = rig(); r.put("a.txt", "alpha"); await r.poll();
  r.put("b.txt", "beta"); expect((await r.poll())[0]!.tasks).toHaveLength(1);
  expect(r.made()).toHaveLength(1);
  // a rename keeps the hash
  renameSync(join(r.dir, "inbox", "b.txt"), join(r.dir, "inbox", "b-renamed.txt"));
  expect((await r.poll())[0]).toMatchObject({ outcome: "none", tasks: [] });
  // a touch changes the mtime and nothing else
  utimesSync(join(r.dir, "inbox", "a.txt"), new Date(T0 + 5000), new Date(T0 + 5000));
  utimesSync(join(r.dir, "inbox", "b-renamed.txt"), new Date(T0 + 9000), new Date(T0 + 9000));
  expect((await r.poll())[0]).toMatchObject({ outcome: "none", tasks: [] });
  // the same bytes under another name are the same file
  r.put("copy-of-a.txt", "alpha");
  expect((await r.poll())[0]).toMatchObject({ outcome: "none", tasks: [] });
  expect(r.made()).toHaveLength(1);
  // different bytes at a known path are a new file
  appendFileSync(join(r.dir, "inbox", "a.txt"), " and more");
  const changed = (await r.poll())[0]!;
  expect(changed).toMatchObject({ outcome: "ran" }); expect(changed.tasks).toHaveLength(1);
  expect(r.made()).toHaveLength(2);
  // and a deleted file never proposes
  rmSync(join(r.dir, "inbox", "a.txt"));
  expect((await r.poll())[0]).toMatchObject({ outcome: "none" });
  expect(r.made()).toHaveLength(2);
});

test("a glob limits what proposes, and a subfolder and a hidden file never do", async () => {
  const r = rig(); const entry = { ...ENTRY, glob: "*.pdf" }; await r.poll([entry]);
  r.put("a.pdf", "p"); r.put("b.txt", "t"); r.put(".c.pdf", "h"); mkdirSync(join(r.dir, "inbox", "d.pdf"));
  const [run] = await r.poll([entry]);
  expect(run!.tasks).toHaveLength(1);
  expect(r.registered.map(file => file.name)).toEqual(["a.pdf"]);
});

test("at most 20 new files propose per pass, in name order, and the rest follow on the next poll", async () => {
  const r = rig(); await r.poll();
  for (let i = 0; i < 25; i++) r.put(`f${String(i).padStart(2, "0")}.txt`, `file ${i}`);
  const first = (await r.poll())[0]!;
  expect(first.tasks).toHaveLength(20); expect(first.files).toBe(25);
  expect(r.registered.map(file => file.name).slice(0, 2)).toEqual(["f00.txt", "f01.txt"]);
  const second = (await r.poll())[0]!;
  expect(second.tasks).toHaveLength(5);
  expect(r.made()).toHaveLength(25);
  expect((await r.poll())[0]).toMatchObject({ outcome: "none" });
});

test("a held hub reads nothing and records nothing, and the files are proposed once it is released", async () => {
  let held = false;
  const r = rig({ held: () => held }); await r.poll();
  r.put("a.txt", "x");
  held = true;
  expect((await r.poll())[0]).toEqual({ id: "inbox", outcome: "held", tasks: [], files: 0 });
  expect(r.made()).toHaveLength(0); expect(r.store.rows("inbox")).toEqual([]);
  held = false;
  expect((await r.poll())[0]!.tasks).toHaveLength(1);
});

test("a hold that begins between two files stops the rest: nothing more is registered or recorded, and the rest follow once released", async () => {
  let held = false;
  const r = rig({ held: () => held }); await r.poll();
  r.put("a.txt", "one"); r.put("b.txt", "two"); r.put("c.txt", "three");
  const tasks = r.tasks, store = r.store, scan = (entry: FolderEntry) => scanFolder(entry, r.policy, (real, size, mtime) => store.known(entry.id, real, size, mtime));
  const seen: string[] = [];
  const holdingAfterFirst = (file: ScannedFile) => { seen.push(file.name); const added = r.registry.add({ bytes: readScanned(file)!, kind: "file", origin: file.real, private: false }); held = true; return { id: added.id, private: false }; };
  const first = (await tasks.runFolderTriggers(store, [ENTRY], scan, holdingAfterFirst, T0, () => held))[0]!;
  // the hold began while the first file was being registered: its propose fence refused the write, so nothing was proposed or recorded and the others never started
  expect(seen).toEqual(["a.txt"]);
  expect(first.tasks).toEqual([]); expect(r.made()).toHaveLength(0);
  expect(store.rows("inbox").filter(row => row.task !== null)).toEqual([]);
  held = false;
  const after = (await r.poll())[0]!;
  expect(after.tasks).toHaveLength(3); expect(r.made()).toHaveLength(3);
});

test("a hold that begins after one file's task was written stops the next file", async () => {
  let held = false;
  const r = rig({ held: () => held }); await r.poll();
  r.put("a.txt", "one"); r.put("b.txt", "two");
  const names: string[] = [];
  const register = (file: ScannedFile) => { names.push(file.name); const added = r.registry.add({ bytes: readScanned(file)!, kind: "file", origin: file.real, private: false }); return { id: added.id, private: false }; };
  const tasks = r.tasks, store = r.store, scan = (entry: FolderEntry) => scanFolder(entry, r.policy, (real, size, mtime) => store.known(entry.id, real, size, mtime));
  let wrote = 0;
  r.board.onChange = (_task, entry) => { if (entry.event === "backlogged" && ++wrote === 1) held = true; }; // the hold begins right after the first task is written
  const run = (await tasks.runFolderTriggers(store, [ENTRY], scan, register, T0, () => held))[0]!;
  expect(names).toEqual(["a.txt"]); // the second file was never registered
  expect(run.tasks).toHaveLength(1); expect(r.made()).toHaveLength(1);
  held = false;
  expect((await r.poll())[0]!.tasks).toHaveLength(1);
  expect(r.made()).toHaveLength(2);
});

test("a folder pass never overlaps a schedules pass, and the guard is released afterwards", async () => {
  const r = rig(); await r.poll();
  r.put("a.txt", "x");
  let entered = 0;
  const tasks = r.tasks, store = r.store, scan = (entry: FolderEntry) => scanFolder(entry, r.policy, (real, size, mtime) => store.known(entry.id, real, size, mtime));
  // the pass is synchronous up to its first await, so the guard is already taken when the call returns its promise
  const first = tasks.runFolderTriggers(store, [ENTRY], scan, file => { entered++; return { id: r.registry.add({ bytes: readScanned(file)!, kind: "file", origin: file.real, private: false }).id, private: false }; }, T0);
  expect(tasks.schedulesPending()).toBe(1);
  expect(await tasks.runFolderTriggers(store, [ENTRY], scan, () => { throw new Error("must not run"); }, T0)).toEqual([]);
  await first;
  expect(tasks.schedulesPending()).toBe(0);
  expect(entered).toBe(1);
  expect((await tasks.runFolderTriggers(store, [ENTRY], scan, () => ({ id: "src:0123456789abcdef", private: false }), T0))[0]).toMatchObject({ outcome: "none" });
});

test("two files with the same new bytes arriving before one poll propose ONE task: the first one's record suppresses the second", async () => {
  const r = rig(); await r.poll();
  r.put("first.txt", "identical bytes"); r.put("second.txt", "identical bytes"); r.put("third.txt", "different bytes");
  const [run] = await r.poll();
  expect(run!.tasks).toHaveLength(2); expect(r.made()).toHaveLength(2);
  expect(r.registered.map(file => file.name)).toEqual(["first.txt", "third.txt"]); // the duplicate was never registered
  expect(r.registry.list()).toHaveLength(2);
});

test("a folder too big to hash in one poll is baselined over several polls and proposes nothing until the baseline is complete", async () => {
  const r = rig();
  const total = MAX_HASH_FILES + 40;
  for (let i = 0; i < total; i++) r.put(`f${String(i).padStart(4, "0")}.txt`, `old ${i}`);
  const first = (await r.poll())[0]!;
  expect(first).toMatchObject({ outcome: "baseline", files: MAX_HASH_FILES }); expect(r.store.baselined("inbox")).toBe(false);
  r.put("new-during-baseline.txt", "arrived while the baseline was still running");
  const second = (await r.poll())[0]!;
  expect(second.outcome).toBe("baseline"); expect(r.store.baselined("inbox")).toBe(true);
  expect(r.made()).toHaveLength(0); expect(r.registered).toHaveLength(0); // nothing proposed, and the file that arrived mid-baseline is part of it
  expect(r.store.rows("inbox")).toHaveLength(total + 1);
  r.put("really-new.txt", "after the baseline");
  const third = (await r.poll())[0]!;
  expect(third.tasks).toHaveLength(1); expect(r.made()).toHaveLength(1);
});

test("a failure while registering leaves the file to be tried again, records no task and keeps the order", async () => {
  const r = rig(); await r.poll();
  r.put("a.txt", "x"); r.put("b.txt", "y");
  let failing = true;
  const tasks = r.tasks, store = r.store, scan = (entry: FolderEntry) => scanFolder(entry, r.policy, (real, size, mtime) => store.known(entry.id, real, size, mtime));
  const flaky = (file: ScannedFile) => { if (failing && file.name === "a.txt") throw new Error("registry unavailable"); return { id: "src:0123456789abcdef", private: false }; };
  const failed = (await tasks.runFolderTriggers(store, [ENTRY], scan, flaky, T0))[0]!;
  expect(failed).toMatchObject({ outcome: "failed", tasks: [], reason: "registry unavailable" });
  expect(r.made()).toHaveLength(0); expect(store.rows("inbox").map(row => row.real_path.split("/").pop())).toEqual([]);
  failing = false;
  const ok = (await tasks.runFolderTriggers(store, [ENTRY], scan, flaky, T0))[0]!;
  expect(ok.tasks).toHaveLength(2);
  expect(r.made()).toHaveLength(2);
});

test("a refused folder records the reason and proposes nothing, and the first poll never silently baselines it", async () => {
  const r = rig();
  const bad = { ...ENTRY, id: "bad", folder: "missing" };
  const [run] = await r.poll([bad]);
  expect(run).toMatchObject({ id: "bad", outcome: "refused", tasks: [] }); expect(run!.reason).toContain("missing");
  mkdirSync(join(r.dir, "missing")); writeFileSync(join(r.dir, "missing", "a.txt"), "x");
  expect((await r.poll([bad]))[0]).toEqual({ id: "bad", outcome: "baseline", tasks: [], files: 1 }); // the folder became readable: what is in it then is the baseline, not news
  expect(r.made()).toHaveLength(0);
  writeFileSync(join(r.dir, "missing", "b.txt"), "y");
  expect((await r.poll([bad]))[0]!.tasks).toHaveLength(1);
});

test("a file whose text matches a PII pattern registers as a private source, and the task still names it by id only", async () => {
  const r = rig({ piiPatterns: ["STUDENT-\\d+"] }); await r.poll();
  r.put("grades.txt", "STUDENT-12345 got an A");
  const [run] = await r.poll();
  const task = r.board.get(run!.tasks[0]!)!;
  const source = r.registry.list()[0]!;
  expect(source.private).toBe(true);
  expect(task.detail).toContain(`Source: ${source.id}`);
  expect(task.detail).not.toContain("STUDENT-12345"); expect(task.detail).not.toContain("grades");
  expect(r.tasks.publicView(task)).toMatchObject({ title: "A new file arrived" });
});

test("a removed trigger keeps no rows, and a trigger added later baselines instead of flooding the board", async () => {
  const r = rig(); r.put("a.txt", "x"); await r.poll();
  expect(r.store.rows("inbox")).toHaveLength(1);
  await r.poll([]);
  expect(r.store.rows("inbox")).toEqual([]);
  r.put("b.txt", "y");
  expect((await r.poll())[0]).toMatchObject({ outcome: "baseline", files: 2 });
  expect(r.made()).toHaveLength(0);
});

// ---- in a real daemon

const SHARED = {
  batch_ms: 0, roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, pi: false, local: false },
  memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, research: { enabled: false },
  snapshots: { enabled: false }, approvals: { notify: false }, pi: { enabled: false, auto_start: false }, coordination: "advisory",
  task_sweep: { enabled: false, interval_s: 3600 },
};
function project(options: { shared?: Record<string, unknown>; local?: Record<string, unknown>; commitLocal?: boolean }) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-folder-daemon-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub")); mkdirSync(join(dir, "inbox"));
  const git = (...args: string[]) => { const r = hubGitSync(["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { encoding: "utf8" }); expect(r.status, r.stderr).toBe(0); };
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ ...SHARED, ...options.shared }));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"');
  writeFileSync(join(dir, ".agenthub/routing.toml"), routing);
  if (options.local) writeFileSync(join(dir, ".agenthub/config.local.json"), JSON.stringify(options.local));
  git("init", "-q"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml");
  if (options.commitLocal) git("add", "-f", ".agenthub/config.local.json");
  git("commit", "-qm", "baseline");
  return { dir, state };
}
const TRIGGERS = [{ id: "inbox", folder: "inbox", class: "plan", title: "A new file arrived" }];

test("in a real daemon: the timer baselines the folder, a new file becomes one task naming a registered source, and a touch or rename proposes nothing", async () => {
  const p = project({ local: { folder_triggers: TRIGGERS } });
  writeFileSync(join(p.dir, "inbox", "old.txt"), "already here");
  const daemon = await startDaemon({ cwd: p.dir, stateDir: p.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, schedulesNow: () => T0, schedulesEveryMs: 20 });
  cleanup.push(() => daemon.stop());
  const db = new Database(join(p.state, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  const made = () => (db.query("SELECT id, title, detail, state FROM tasks ORDER BY id").all() as { id: number; title: string; detail: string; state: string }[]).filter(task => task.detail.startsWith(FOLDER_MARKER));
  const seen = () => db.query("SELECT real_path, size, sha256, task FROM folder_seen ORDER BY real_path").all() as { real_path: string; size: number; sha256: string; task: number | null }[];
  await until(() => seen().length === 1, "the first poll recorded the existing file");
  await Bun.sleep(100);
  expect(made()).toHaveLength(0);
  writeFileSync(join(p.dir, "inbox", "new.txt"), "fresh content");
  await until(() => made().length === 1, "a new file proposed one task");
  const task = made()[0]!;
  expect(task).toMatchObject({ title: "A new file arrived", state: "backlog" });
  const registry = new SourceRegistry(p.state);
  const sources = registry.list();
  expect(sources).toHaveLength(1);
  expect(task.detail).toContain(`Source: ${sources[0]!.id}`);
  expect(seen().find(row => row.real_path.endsWith("new.txt"))).toMatchObject({ size: 13, task: task.id, sha256: sources[0]!.sha256 });
  utimesSync(join(p.dir, "inbox", "new.txt"), new Date(T0), new Date(T0));
  renameSync(join(p.dir, "inbox", "new.txt"), join(p.dir, "inbox", "renamed.txt"));
  await Bun.sleep(150);
  expect(made()).toHaveLength(1);
  expect(registry.list()).toHaveLength(1);
});

test("in a real daemon: a new file whose text matches a PII pattern is registered as a private source", async () => {
  const p = project({ local: { folder_triggers: TRIGGERS } });
  const daemon = await startDaemon({ cwd: p.dir, stateDir: p.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, schedulesNow: () => T0, schedulesEveryMs: 20 });
  cleanup.push(() => daemon.stop());
  const db = new Database(join(p.state, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  const made = () => (db.query("SELECT id, detail FROM tasks ORDER BY id").all() as { id: number; detail: string }[]).filter(task => task.detail.startsWith(FOLDER_MARKER));
  await until(() => (db.query("SELECT 1 FROM folder_poll").all() as unknown[]).length === 1, "the first poll started the trigger");
  writeFileSync(join(p.dir, "inbox", "grades.txt"), "applicant 900101-1234567 got an A"); // the shipped default pii pattern: a resident registration number
  await until(() => made().length === 1, "the new file proposed one task");
  const sources = new SourceRegistry(p.state).list();
  expect(sources).toHaveLength(1);
  expect(sources[0]!.private).toBe(true);
  expect(made()[0]!.detail).not.toContain("900101");
});

test("a file whose bytes change between the scan and the registration is not registered, and is tried again as what it became", async () => {
  const r = rig(); await r.poll();
  r.put("a.txt", "before");
  const tasks = r.tasks, store = r.store;
  let swapped = false;
  const scan = (entry: FolderEntry) => {
    const result = scanFolder(entry, r.policy, (real, size, mtime) => store.known(entry.id, real, size, mtime));
    if (!swapped && result.files.length) { swapped = true; writeFileSync(join(r.dir, "inbox", "a.txt"), "AFTER!"); } // same size, new content, after the hash was taken
    return result;
  };
  const register = (file: ScannedFile) => registerScanned(file, { registry: r.registry, cwd: r.dir, piiPaths: [], piiPatterns: () => [] });
  const first = (await tasks.runFolderTriggers(store, [ENTRY], scan, register, T0))[0]!;
  expect(first).toMatchObject({ outcome: "failed" }); expect(first.reason).toContain("changed");
  expect(r.made()).toHaveLength(0); expect(r.registry.list()).toHaveLength(0);
  const second = (await tasks.runFolderTriggers(store, [ENTRY], scan, register, T0))[0]!;
  expect(second.tasks).toHaveLength(1);
  expect(r.registry.readRaw(r.registry.list()[0]!.id)!.toString()).toBe("AFTER!"); // registered as what it now is, under its own hash
});

test("folder_triggers is machine-local: a committed config is ignored, a tracked config.local.json is not trusted, and an invalid entry is refused by the loader", () => {
  const committed = project({ shared: { folder_triggers: TRIGGERS } });
  expect(loadConfig(committed.dir).folder_triggers).toEqual([]);
  expect(loadConfig(committed.dir).ignored?.join(" ")).toContain("folder_triggers in .agenthub/config.json ignored");
  const tracked = project({ local: { folder_triggers: TRIGGERS }, commitLocal: true });
  expect(loadConfig(tracked.dir).folder_triggers).toEqual([]);
  const local = project({ local: { folder_triggers: TRIGGERS } });
  expect(loadConfig(local.dir).folder_triggers).toEqual([{ id: "inbox", folder: "inbox", class: "plan", title: "A new file arrived", queue: "backlog" }]);
  const bad = project({ local: { folder_triggers: [{ id: "x", folder: "inbox", glob: "../x", class: "plan", title: "t" }] } });
  expect(() => loadConfig(bad.dir)).toThrow("never a path");
});

test("a settings write cannot create or change a folder trigger", async () => {
  const p = project({ local: { folder_triggers: TRIGGERS } });
  const daemon = await startDaemon({ cwd: p.dir, stateDir: p.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(p.state, { role: "console" }); cleanup.push(() => client.close());
  const reply = await client.request({ t: "settings_set", key: "folder_triggers", value: [{ id: "x", folder: "/", class: "plan", title: "t" }] });
  expect(reply.ok).toBe(false);
  expect(String(reply.error)).toContain("never editable from settings"); // refused as a class, not merely as an unknown key
});
