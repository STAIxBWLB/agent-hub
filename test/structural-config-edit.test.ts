import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/hub/daemon.ts";
import { configSourceTexts, parseConfigSources } from "../src/hub/config-reload.ts";
import { BACKUPS_KEPT, configBackups, editRevisions, fileRevision, planConfigEdit, valueHash, writeConfigEdit, type CandidateCheck, type ConfigEditPlan } from "../src/hub/config-edit.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** A real git project: config.json committed, config.local.json and sdlc.toml untracked, like a person's checkout. */
function project(local?: unknown, sdlc?: string) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-config-edit-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ batch_ms: 0, memory: { enabled: false, native: false } }));
  const git = (...args: string[]) => { const r = hubGitSync(["-C", dir, "-c", "user.name=F", "-c", "user.email=f@x", ...args], { encoding: "utf8" }); expect(r.status, r.stderr).toBe(0); };
  git("init", "-q"); git("add", "-f", ".agenthub/config.json"); git("commit", "-qm", "base");
  if (local !== undefined) writeFileSync(join(dir, ".agenthub/config.local.json"), typeof local === "string" ? local : JSON.stringify(local, null, 2));
  if (sdlc !== undefined) writeFileSync(join(dir, ".agenthub/sdlc.toml"), sdlc);
  // The loaders' own verdict on the candidate, through the same capture the daemon's reload uses.
  const check: CandidateCheck = (file, text) => {
    if (file !== "config.local.json") return;
    const texts = configSourceTexts(dir);
    texts["config.local.json"] = text;
    const sources = parseConfigSources(texts, undefined, dir);
    loadConfig(dir, sources.layers, sources.routing.retired ?? []);
  };
  const revision = (file: "config.local.json" | "sdlc.toml") => editRevisions(dir)[file];
  const plan = (file: "config.local.json" | "sdlc.toml", set: { path: string[]; value: unknown }[], at = revision(file)): ConfigEditPlan => planConfigEdit(dir, { file, revision: at, set }, check);
  const read = (name: string) => existsSync(join(dir, ".agenthub", name)) ? readFileSync(join(dir, ".agenthub", name), "utf8") : null;
  return { dir, state, plan, read, revision, check, git };
}
const reviewer = { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" };
const ok = (plan: ConfigEditPlan) => { if (!plan.ok) throw new Error(plan.error); return plan; };

test("#689 the codex-review fresh reviewer missing start_mode shows the loader's reason and writes nothing", () => {
  const p = project({ roster: { codex: false } });
  const before = p.read("config.local.json");
  const plan = p.plan("config.local.json", [{ path: ["instances", "codex-review"], value: { kind: "codex", roles: ["reviewer"], review_mode: "fresh" } }]);
  expect(plan.ok).toBe(false);
  if (plan.ok) return;
  expect(plan.error).toContain("fresh requires reviewer-only roles, headless mode");
  expect(plan.field).toBe("instances.codex-review.review_mode");
  expect(plan.error).toContain("nothing was written");
  expect(p.read("config.local.json")).toBe(before);
  expect(existsSync(join(p.state, "config-backups"))).toBe(false);
});

test("#689 a valid fresh reviewer is written atomically, keeps a backup of the previous file and changes the revision", () => {
  const p = project({ roster: { codex: false } });
  const plan = ok(p.plan("config.local.json", [{ path: ["instances", "codex-review"], value: reviewer }]));
  expect(plan.tier).toBe(2);
  expect(plan.diff).toEqual([{ path: "instances.codex-review", tier: 2, before: undefined, after: reviewer, applies: "restart" }]);
  const prior = p.read("config.local.json")!, priorMode = lstatSync(join(p.dir, ".agenthub/config.local.json")).mode & 0o777;
  const written = writeConfigEdit(p.dir, p.state, plan, 1_700_000_000_000);
  expect(JSON.parse(p.read("config.local.json")!)).toEqual({ roster: { codex: false }, instances: { "codex-review": reviewer } });
  expect(written.fileBefore).toBe(fileRevision(prior));
  expect(written.fileAfter).toBe(p.revision("config.local.json"));
  const backups = configBackups(p.state);
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(p.state, "config-backups", backups[0]!.name), "utf8")).toBe(prior);
  expect(readdirSync(join(p.dir, ".agenthub")).filter(name => name.endsWith(".tmp"))).toEqual([]);
  // An existing file keeps its mode; a file created by an edit is the owner's alone.
  expect(lstatSync(join(p.dir, ".agenthub/config.local.json")).mode & 0o777).toBe(priorMode);
});

test("#689 a first edit with no file yet creates it and has nothing to back up", () => {
  const p = project();
  const written = writeConfigEdit(p.dir, p.state, ok(p.plan("config.local.json", [{ path: ["instances", "codex-review"], value: reviewer }])));
  expect(written.backup).toBeUndefined();
  expect(configBackups(p.state)).toEqual([]);
  expect(JSON.parse(p.read("config.local.json")!).instances["codex-review"]).toEqual(reviewer);
  expect(lstatSync(join(p.dir, ".agenthub/config.local.json")).mode & 0o777).toBe(0o600);
});

test("#689 a file that changed on disk since it was read refuses the edit, at plan time and again at write time", () => {
  const p = project({ roster: { codex: false } });
  const stale = p.revision("config.local.json");
  writeFileSync(join(p.dir, ".agenthub/config.local.json"), JSON.stringify({ roster: { codex: false }, approvals: { notify: true } }));
  const refused = p.plan("config.local.json", [{ path: ["instances", "codex-review"], value: reviewer }], stale);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error).toContain("changed on disk since it was read");
  // The race between preview and write: plan against the current file, then a hand edit lands before the write.
  const plan = ok(p.plan("config.local.json", [{ path: ["instances", "codex-review"], value: reviewer }]));
  const hand = JSON.stringify({ roster: { codex: false }, approvals: { notify: false } });
  writeFileSync(join(p.dir, ".agenthub/config.local.json"), hand);
  expect(() => writeConfigEdit(p.dir, p.state, plan)).toThrow("changed on disk since it was read");
  expect(p.read("config.local.json")).toBe(hand);
  expect(configBackups(p.state)).toEqual([]);
});

test("#689 unknown request fields, unknown keys and unsafe paths are refused by name, never dropped", () => {
  const p = project({});
  const rev = p.revision("config.local.json");
  const run = (request: unknown) => planConfigEdit(p.dir, request, p.check);
  for (const [request, text] of [
    [{ file: "config.local.json", revision: rev, set: [{ path: ["review", "pool"], value: ["claude"] }], extra: 1 }, "extra: unknown field"],
    [{ file: "config.local.json", revision: rev, set: [{ path: ["review", "pool"], value: ["claude"], mode: "x" }] }, "set[0].mode: unknown field"],
    [{ file: "config.local.json", revision: rev, set: [{ path: ["nonsense", "x"], value: 1 }] }, "nonsense.x is not a structural setting"],
    [{ file: "config.local.json", revision: rev, set: [{ path: ["instances", "codex-review", "bogus"], value: 1 }] }, "unknown instance field"],
    [{ file: "config.local.json", revision: rev, set: [{ path: ["__proto__", "polluted"], value: 1 }] }, "invalid configuration path"],
    [{ file: "config.local.json", revision: rev, set: [{ path: ["roster", "codex"], value: true }] }, "already editable with ahub settings set roster.codex"],
    [{ file: "config.local.json", revision: "not-a-hash", set: [{ path: ["review", "pool"], value: [] }] }, "revision"],
    [{ file: "routing.toml", revision: rev, set: [{ path: ["x"], value: 1 }] }, "file: one of"],
    [{ file: "config.local.json", revision: rev, set: [] }, "set: 1 to"],
    [{ file: "config.local.json", revision: rev, set: [{ path: ["review", "pool"], value: [] }, { path: ["review", "pool"], value: [] }] }, "appears twice"],
    [{ file: "sdlc.toml", revision: "absent", set: [{ path: ["bands"], value: {} }] }, "only mode and required_checks"],
  ] as const) {
    const plan = run(request);
    expect(plan.ok, text).toBe(false);
    if (!plan.ok) expect(plan.error, text).toContain(text);
  }
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("#689 a loader refusal at a structural block names the field, and writes nothing", () => {
  const p = project({});
  const plan = p.plan("config.local.json", [{ path: ["context", "gate"], value: 7 }]);
  expect(plan.ok).toBe(false);
  if (!plan.ok) { expect(plan.error).toContain("context"); expect(plan.error).toContain("nothing was written"); }
  expect(p.read("config.local.json")).toBe("{}");
});

test("#689 a tier 3 field is reported in the plan so the daemon can demand the typed key; a replacement may not silently drop one", () => {
  const home = join(tmpdir(), "ahub-config-edit-jcode-home");
  mkdirSync(home, { recursive: true }); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const p = project({ instances: { "jcode-two": { kind: "jcode", jcode_home: home, roles: ["implementer"] } } });
  const edit = ok(p.plan("config.local.json", [{ path: ["instances", "jcode-two", "model"], value: "gpt-x" }]));
  expect(edit.tier).toBe(3);
  expect(edit.tier3Keys).toEqual(["instances.jcode-two.model"]);
  const tier2 = ok(p.plan("config.local.json", [{ path: ["instances", "jcode-two", "roles"], value: ["verifier"] }]));
  expect(tier2.tier).toBe(2);
  const drop = p.plan("config.local.json", [{ path: ["instances", "jcode-two"], value: { kind: "jcode", roles: ["implementer"] } }]);
  expect(drop.ok).toBe(false);
  if (!drop.ok) expect(drop.error).toContain("would drop a native home or account setting");
});

test("#689 sdlc.toml: mode and required_checks change as lines, comments and every other table stay byte for byte", () => {
  const text = '# lifecycle for this repository\nmode = "advise"\nrequired_checks = [\n  "check (ubuntu-latest)", # linux\n  "seeded guards",\n]\nmax_nits = 3\n\n[bands.rework_rounds]\nwindow = 10\n';
  const p = project({}, text);
  const plan = ok(p.plan("sdlc.toml", [{ path: ["mode"], value: "enforce" }]));
  expect(plan.next).toBe(text.replace('mode = "advise"', 'mode = "enforce"'));
  expect(plan.diff).toEqual([{ path: "sdlc.mode", tier: 2, before: "advise", after: "enforce", applies: "restart" }]);
  const checks = ok(p.plan("sdlc.toml", [{ path: ["required_checks"], value: ["gate"] }]));
  expect(checks.next).toBe('# lifecycle for this repository\nmode = "advise"\nrequired_checks = ["gate"]\nmax_nits = 3\n\n[bands.rework_rounds]\nwindow = 10\n');
  writeConfigEdit(p.dir, p.state, plan);
  expect(p.read("sdlc.toml")).toBe(plan.next!);
  expect(configBackups(p.state).map(item => item.file)).toEqual(["sdlc.toml"]);
  expect(readFileSync(join(p.state, "config-backups", configBackups(p.state)[0]!.name), "utf8")).toBe(text);
});

test("#689 sdlc.toml: a new file is created, a key is added before the first table, an invalid mode is refused, off is a value not a removal", () => {
  const p = project({});
  const created = ok(p.plan("sdlc.toml", [{ path: ["mode"], value: "advise" }]));
  expect(created.next).toBe('mode = "advise"\n');
  writeConfigEdit(p.dir, p.state, created);
  expect(configBackups(p.state)).toEqual([]);
  const q = project({}, '[bands.rework_rounds]\nwindow = 10\n');
  expect(ok(q.plan("sdlc.toml", [{ path: ["mode"], value: "enforce" }])).next).toBe('mode = "enforce"\n\n[bands.rework_rounds]\nwindow = 10\n');
  const bad = q.plan("sdlc.toml", [{ path: ["mode"], value: "block" }]);
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error).toContain("sdlc.mode: expected off, advise or enforce");
  const checks = q.plan("sdlc.toml", [{ path: ["required_checks"], value: ["a", "a"] }]);
  expect(checks.ok).toBe(false);
  if (!checks.ok) expect(checks.error).toContain("sdlc.required_checks");
  expect(q.read("sdlc.toml")).toBe('[bands.rework_rounds]\nwindow = 10\n');
});

test("#689 sdlc.toml: a layout the editor cannot change faithfully is refused with its own reason, not guessed", () => {
  // A line that looks like a key but sits inside a multi-line string: editing it would corrupt the string.
  const p = project({}, 'note = """\nrequired_checks = ["x"]\n"""\nmode = "advise"\n');
  const plan = p.plan("sdlc.toml", [{ path: ["required_checks"], value: ["gate"] }]);
  expect(plan.ok).toBe(false);
  if (!plan.ok) expect(plan.error).toContain("a layout the editor cannot change safely");
  expect(p.read("sdlc.toml")).toBe('note = """\nrequired_checks = ["x"]\n"""\nmode = "advise"\n');
});

test("#689 backups are bounded to five per file, newest first, and a stale name is never read as one", () => {
  const p = project({});
  for (let i = 0; i < 8; i++) {
    const plan = ok(p.plan("config.local.json", [{ path: ["approvals", "timeout_s"], value: 100 + i }]));
    writeConfigEdit(p.dir, p.state, plan, 1_700_000_000_000 + i * 1000);
  }
  const backups = configBackups(p.state).filter(item => item.file === "config.local.json");
  expect(backups).toHaveLength(BACKUPS_KEPT);
  expect(backups.map(item => item.at)).toEqual([...backups.map(item => item.at)].sort((a, b) => b - a));
  expect(backups[0]!.at).toBe(1_700_000_007_000);
  writeFileSync(join(p.state, "config-backups", "notes.txt"), "x");
  writeFileSync(join(p.state, "config-backups", "config.local.json.bad.bak"), "x");
  expect(configBackups(p.state)).toHaveLength(BACKUPS_KEPT);
});

test("#689 the audit record is hashes of key paths and values, never a value", () => {
  const p = project({});
  const secret = "/Users/someone/private/home-ENDPOINT";
  const plan = ok(p.plan("config.local.json", [{ path: ["instances", "codex-review"], value: reviewer }]));
  const written = writeConfigEdit(p.dir, p.state, plan);
  expect(JSON.stringify(written)).not.toContain("headless");
  expect(written.paths).toEqual([{ path: "instances.codex-review", before: null, after: valueHash(reviewer) }]);
  expect(valueHash({ b: 1, a: 2 })).toBe(valueHash({ a: 2, b: 1 }));
  expect(valueHash(secret)).toMatch(/^[a-f0-9]{16}$/);
});

test("#689 a git-tracked config.local.json, a symlinked file and an oversized file are never written or read through", () => {
  const p = project({ roster: { codex: false } });
  const plan = ok(p.plan("config.local.json", [{ path: ["approvals", "timeout_s"], value: 90 }]));
  p.git("add", "-f", ".agenthub/config.local.json");
  expect(() => writeConfigEdit(p.dir, p.state, plan)).toThrow("committed to git");
  expect(JSON.parse(p.read("config.local.json")!)).toEqual({ roster: { codex: false } });
  const q = project();
  writeFileSync(join(q.dir, "elsewhere.json"), "{}");
  symlinkSync(join(q.dir, "elsewhere.json"), join(q.dir, ".agenthub/config.local.json"));
  expect(() => editRevisions(q.dir)).toThrow("regular file");
  const r = project();
  writeFileSync(join(r.dir, ".agenthub/sdlc.toml"), `# ${"x".repeat(70 * 1024)}\n`);
  expect(() => editRevisions(r.dir)).toThrow("size limit");
});

test("#689 removing a key (null) deletes it and its emptied block; setting nothing new is not a write", () => {
  const p = project({ review: { pool: ["claude"] }, roster: { codex: false } });
  const removed = ok(p.plan("config.local.json", [{ path: ["review", "pool"], value: null }]));
  expect(JSON.parse(removed.next!)).toEqual({ roster: { codex: false } });
  const same = p.plan("config.local.json", [{ path: ["review", "pool"], value: ["claude"] }]);
  expect(same.ok).toBe(false);
  if (!same.ok) expect(same.error).toContain("nothing to change");
});

test("#689 removing or replacing a whole instance that holds a tier 3 field is itself tier 3, so a dashboard can never reach its values", () => {
  const home = join(tmpdir(), "ahub-config-edit-t3-home");
  mkdirSync(home, { recursive: true }); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const p = project({ instances: { "jcode-two": { kind: "jcode", jcode_home: home, model: "secret-model", roles: ["implementer"] }, "codex-review": reviewer } });
  const removeTier3 = ok(p.plan("config.local.json", [{ path: ["instances", "jcode-two"], value: null }]));
  expect(removeTier3.tier).toBe(3);
  expect(removeTier3.tier3Keys).toEqual(["instances.jcode-two"]);
  expect(removeTier3.diff[0]).toMatchObject({ path: "instances.jcode-two", tier: 3 });
  const removeTier2 = ok(p.plan("config.local.json", [{ path: ["instances", "codex-review"], value: null }]));
  expect(removeTier2.tier).toBe(2);
  expect(removeTier2.tier3Keys).toEqual([]);
});

test("#689 a symlinked .agenthub directory is never read or written through, for either file", () => {
  const p = project({});
  const real = join(p.dir, "real-agenthub");
  mkdirSync(real); writeFileSync(join(real, "sdlc.toml"), 'mode = "advise"\n');
  rmSync(join(p.dir, ".agenthub"), { recursive: true, force: true });
  symlinkSync(real, join(p.dir, ".agenthub"));
  expect(() => editRevisions(p.dir)).toThrow(".agenthub must be a real directory");
  const refused = planConfigEdit(p.dir, { file: "sdlc.toml", revision: "absent", set: [{ path: ["mode"], value: "enforce" }] }, p.check);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error).toContain(".agenthub must be a real directory");
  expect(readFileSync(join(real, "sdlc.toml"), "utf8")).toBe('mode = "advise"\n');
});

test("#689 sdlc.toml keeps its newline convention: a CRLF file changes only the edited lines and stays CRLF", () => {
  const text = '# lifecycle\r\nmode = "advise"\r\nrequired_checks = ["gate"]\r\nmax_nits = 3\r\n\r\n[bands.rework_rounds]\r\nwindow = 10\r\n';
  const p = project({}, text);
  const plan = ok(p.plan("sdlc.toml", [{ path: ["mode"], value: "enforce" }]));
  expect(plan.next).toBe(text.replace('mode = "advise"', 'mode = "enforce"'));
  expect(plan.next!.replace(/\r\n/g, "").includes("\n")).toBe(false);
  const added = ok(project({}, '[bands.rework_rounds]\r\nwindow = 10\r\n').plan("sdlc.toml", [{ path: ["mode"], value: "off" }]));
  expect(added.next).toBe('mode = "off"\r\n\r\n[bands.rework_rounds]\r\nwindow = 10\r\n');
  const lf = ok(project({}, 'mode = "advise"\n').plan("sdlc.toml", [{ path: ["mode"], value: "off" }]));
  expect(lf.next).toBe('mode = "off"\n');
  const mixed = ok(project({}, 'mode = "advise"\r\nmax_nits = 2\n').plan("sdlc.toml", [{ path: ["mode"], value: "off" }]));
  expect(mixed.next).toBe('mode = "off"\r\nmax_nits = 2\n'); // an untouched line keeps its own ending
  const noFinal = ok(project({}, 'mode = "advise"').plan("sdlc.toml", [{ path: ["mode"], value: "off" }]));
  expect(noFinal.next).toBe('mode = "off"\n');
});

test("#689 a tier 3 value gets no hash in the audit record, so a low-entropy model name cannot be recovered from the event log", () => {
  const home = join(tmpdir(), "ahub-config-edit-hash-home"); mkdirSync(home, { recursive: true }); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const p = project({ instances: { "jcode-two": { kind: "jcode", jcode_home: home, model: "gpt-5" } } });
  const written = writeConfigEdit(p.dir, p.state, ok(p.plan("config.local.json", [{ path: ["instances", "jcode-two", "model"], value: "gpt-6" }])));
  expect(written.paths).toEqual([{ path: "instances.jcode-two.model", before: "(set)", after: "(set)" }]);
  for (const guess of ["gpt-5", "gpt-6"]) expect(JSON.stringify(written)).not.toContain(valueHash(guess)!);
  const tier2 = writeConfigEdit(p.dir, p.state, ok(p.plan("config.local.json", [{ path: ["approvals", "timeout_s"], value: 90 }])));
  expect(tier2.paths[0]).toMatchObject({ path: "approvals.timeout_s", after: valueHash(90) });
});
