import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Facts } from "../src/hub/facts.ts";
import { DeliverableRefusal, vetDeliverables } from "../src/hub/deliverable-files.ts";
import { matchesPolicy } from "../src/hub/path-policy.ts";
import { screenRegistration } from "../src/hub/sources.ts";
import { realPath } from "../src/hub/project.ts";
import { initShadow, repoOf } from "../src/hub/snapshots.ts";

// #552, the #541 class: Bun's realpath can name ANOTHER hardlink of the same file on macOS APFS (about 1 call in 100; the system realpath never does), so a
// policy decision made from the resolved name alone can judge a different name than the one the caller used. Each caller below judges both names.
// Each loop runs enough iterations that an unfixed caller fails with overwhelming probability (1 percent per call: 5 x 1000 calls miss it with probability e^-50).
// 5000 iterations per fixed caller, run as 5 tests of 1000 so no test needs a timeout above the gate's 20 s (tests.md: a test that runs spawnSync in a loop keeps its own timeout at or under 20 s).
const PARTS = [1, 2, 3, 4, 5], ITERATIONS = 1000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function loop(layout: { original: string; link: string }, attempt: (dir: string, typed: string) => void): void {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-realpath-name-"))); dirs.push(base);
  for (let i = 0; i < ITERATIONS; i++) {
    const dir = join(base, `d${i}`);
    for (const sub of ["data/raw", "secrets", ".agenthub", "private", "docs"]) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, layout.original), "k=v"); linkSync(join(dir, layout.original), join(dir, layout.link));
    attempt(dir, layout.link);
  }
}

for (const part of PARTS) test(`Facts.rel never names a denied file that is the later hardlink of an innocent one, on every call (part ${part} of 5)`, () => {
  let named = 0;
  loop({ original: "data/raw/input.json", link: ".env" }, (dir, typed) => {
    const facts = new Facts({ root: dir, tmp: join(dir, ".facts"), instance: "i", scope: () => ({ paths: [], plans: [] }), peers: () => [], nameable: () => true });
    if (facts.rel(typed) !== undefined) named++;
  });
  expect(named).toBe(0);
}, 20_000);

test("Facts.rel still names an ordinary file and a hardlinked ordinary file", () => {
  loop({ original: "data/raw/input.json", link: "docs/copy.json" }, (dir, typed) => {
    const facts = new Facts({ root: dir, tmp: join(dir, ".facts"), instance: "i", scope: () => ({ paths: [], plans: [] }), peers: () => [], nameable: () => true });
    expect(facts.rel(typed)).toBeDefined();
  });
}, 20_000);

for (const part of PARTS) test(`a deliverable that is the later hardlink of an innocent file is refused when its name is hub-owned or denied, on every call (part ${part} of 5)`, () => {
  let hubAccepted = 0, deniedAccepted = 0;
  const vet = (dir: string, path: string, deny: string[]) => { try { vetDeliverables([{ path, format: "json" }], { cwd: dir, deny, private: () => false }); return true; } catch (error) { if (!(error instanceof DeliverableRefusal)) throw error; return false; } };
  loop({ original: "data/raw/input.json", link: ".agenthub/state.json" }, (dir, typed) => { if (vet(dir, typed, [])) hubAccepted++; });
  loop({ original: "data/raw/input.json", link: ".env" }, (dir, typed) => { if (vet(dir, typed, [])) deniedAccepted++; });
  expect(hubAccepted).toBe(0);
  expect(deniedAccepted).toBe(0);
}, 20_000);

for (const part of PARTS) test(`a deliverable named by a local.deny entry is refused through the typed name, and an ordinary hardlinked deliverable is still accepted (part ${part} of 5)`, () => {
  let denyAccepted = 0;
  const vet = (dir: string, path: string, deny: string[]) => { try { vetDeliverables([{ path, format: "json" }], { cwd: dir, deny, private: () => false }); return true; } catch (error) { if (!(error instanceof DeliverableRefusal)) throw error; return false; } };
  loop({ original: "data/raw/input.json", link: "secrets/report.json" }, (dir, typed) => { if (vet(dir, typed, ["secrets/"])) denyAccepted++; });
  loop({ original: "data/raw/input.json", link: "docs/copy.json" }, (dir, typed) => { expect(vet(dir, typed, [])).toBe(true); });
  expect(denyAccepted).toBe(0);
}, 20_000);

for (const part of PARTS) test(`ahub source add screens the typed name against pii.paths as well as the resolved one, on every call (part ${part} of 5)`, () => {
  let notPrivate = 0;
  loop({ original: "docs/a.txt", link: "private/b.txt" }, (dir, typed) => {
    const absolute = realPath(resolve(dir, typed));
    const verdict = screenRegistration({ bytes: Buffer.from("hello"), kind: "file", path: absolute, typedPath: resolve(dir, typed) }, { piiPaths: ["private"], piiPatterns: [], cwd: dir, matchesPolicy });
    if (!verdict.reasons.includes("path under pii.paths")) notPrivate++;
  });
  expect(notPrivate).toBe(0);
}, 20_000);

test("screenRegistration keeps its behavior without a typed name, and a public path stays public", () => {
  const base = { piiPaths: ["private"], piiPatterns: [], cwd: "/tmp/x" };
  const policy = { ...base, matchesPolicy: () => false };
  expect(screenRegistration({ bytes: Buffer.from("hello"), kind: "file", path: "/tmp/x/open/a.txt" }, policy).reasons).not.toContain("path under pii.paths");
  expect(screenRegistration({ bytes: Buffer.from("hello"), kind: "file", path: "/tmp/x/open/a.txt", typedPath: "/tmp/x/open/b.txt" }, policy).private).toBe(false);
  const flagged = { ...base, matchesPolicy: (_cwd: string, path: string) => path.endsWith("typed.txt") };
  expect(screenRegistration({ bytes: Buffer.from("hello"), kind: "file", path: "/tmp/x/open/a.txt", typedPath: "/tmp/x/private/typed.txt" }, flagged).reasons).toContain("path under pii.paths");
  expect(screenRegistration({ bytes: Buffer.from("hello"), kind: "url", path: "/tmp/x/open/a.txt", typedPath: "/tmp/x/private/typed.txt" }, flagged).reasons).not.toContain("path under pii.paths");
});

/** One shadow repository per test (building one costs about 20 ms) and a fresh directory pair per iteration, the layout that flips about 1 call in 100. */
function shadowFacts(ignore?: string) {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-realpath-shadow-"))); dirs.push(base);
  mkdirSync(join(base, ".agenthub"), { recursive: true });
  initShadow(base);
  if (ignore !== undefined) writeFileSync(join(base, ".agenthub/ignore"), ignore);
  const repo = repoOf(base);
  expect(repo?.shadow).toBe(true);
  return { base, facts: new Facts({ root: base, repo, tmp: join(base, ".facts"), instance: "i", scope: () => ({ paths: [], plans: [] }), peers: () => [], nameable: () => true }) };
}

for (const part of PARTS) test(`Facts.rel in a shadow repository never names a hub-owned file that is the later hardlink of an innocent one, on every call (part ${part} of 5)`, () => {
  const { base, facts } = shadowFacts();
  let named = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    mkdirSync(join(base, `data${i}`), { recursive: true }); mkdirSync(join(base, `.agenthub/h${i}`), { recursive: true });
    writeFileSync(join(base, `data${i}/input.json`), "k=v"); linkSync(join(base, `data${i}/input.json`), join(base, `.agenthub/h${i}/state.json`));
    if (facts.rel(`.agenthub/h${i}/state.json`) !== undefined) named++;
  }
  expect(named).toBe(0);
}, 20_000);

for (const part of PARTS) test(`Facts.rel in a shadow repository never names a file that .agenthub/ignore excludes and that is the later hardlink of a public one, on every call (part ${part} of 5)`, () => {
  // The shadow ignore policy is name-based as well: it is asked about the resolved name and the typed name, and an ignored or unavailable answer on either refuses.
  const { base, facts } = shadowFacts("ignored/\n");
  let named = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    mkdirSync(join(base, `pub${i}`), { recursive: true }); mkdirSync(join(base, `ignored/d${i}`), { recursive: true });
    writeFileSync(join(base, `pub${i}/f.txt`), "k=v"); linkSync(join(base, `pub${i}/f.txt`), join(base, `ignored/d${i}/g.txt`));
    if (facts.rel(`ignored/d${i}/g.txt`) !== undefined) named++;
  }
  expect(named).toBe(0);
}, 20_000);

test("in a shadow repository an ordinary file is still named, an ignored file and an ignored symlink target are not, and a hardlinked ordinary file is named", () => {
  const { base, facts } = shadowFacts("ignored/\n");
  mkdirSync(join(base, "pub")); mkdirSync(join(base, "ignored"));
  writeFileSync(join(base, "pub/a.txt"), "a"); writeFileSync(join(base, "ignored/b.txt"), "b");
  linkSync(join(base, "pub/a.txt"), join(base, "pub/copy.txt")); symlinkSync(join(base, "ignored/b.txt"), join(base, "pub/via-link.txt"));
  expect(facts.rel("pub/a.txt")).toBe("pub/a.txt");
  expect(facts.rel("pub/copy.txt")).toBeDefined();
  expect(facts.rel("ignored/b.txt")).toBeUndefined();
  expect(facts.rel("pub/via-link.txt")).toBeUndefined();
});

test("in a shadow repository a missing repository refuses every name rather than answering (the resolved name's check fails closed)", () => {
  // Removing the shadow metadata makes the repository handle invalid, so `rel` refuses before the ignore check runs; this pins the refusal, not the ignore check's exit-code branch.
  const { base, facts } = shadowFacts();
  mkdirSync(join(base, "pub")); writeFileSync(join(base, "pub/a.txt"), "a");
  expect(facts.rel("pub/a.txt")).toBe("pub/a.txt");
  rmSync(join(base, ".agenthub/shadow.git"), { recursive: true, force: true });
  expect(() => facts.rel("pub/a.txt")).toThrow();
});

test("in a shadow repository a file reached through a symlinked directory is refused, because git cannot judge a name beyond a symbolic link (fails closed; a behavior change of this PR)", () => {
  // The typed name is asked of `git check-ignore` too, and git answers "beyond a symbolic link" (exit 128) for `via/f.txt`. Before this change only the resolved name `real/f.txt` was asked, so the file was named.
  // An answer that is not a plain "not ignored" is never readable fact evidence, so the file is not named by that path; its real path still is.
  const { base, facts } = shadowFacts();
  mkdirSync(join(base, "real/sub"), { recursive: true }); writeFileSync(join(base, "real/sub/f.txt"), "x");
  symlinkSync(join(base, "real"), join(base, "via")); symlinkSync(join(base, "real/sub"), join(base, "real/inner"));
  expect(facts.rel("real/sub/f.txt")).toBe("real/sub/f.txt");
  expect(facts.rel("via/sub/f.txt")).toBeUndefined();
  expect(facts.rel("real/inner/f.txt")).toBeUndefined();
});

test("in a shadow repository a typed name outside the project that resolves to an ordinary file inside it is still named: the ignore check asks about names inside the project only", () => {
  const { base, facts } = shadowFacts();
  const elsewhere = realPath(mkdtempSync(join(tmpdir(), "ahub-realpath-shadow-out-"))); dirs.push(elsewhere);
  mkdirSync(join(base, "docs")); writeFileSync(join(base, "docs/ok.txt"), "ok"); symlinkSync(join(base, "docs/ok.txt"), join(elsewhere, "link.txt"));
  expect(facts.rel(join(elsewhere, "link.txt"))).toBe("docs/ok.txt");
});

test("Facts.rel is judged by what the name is, not by where realpath lands: a name outside the project is refused whichever way it resolves", () => {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-realpath-outside-"))); dirs.push(base);
  const inside = join(base, "p"), outside = join(base, "o");
  mkdirSync(inside, { recursive: true }); mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "x.txt"), "x"); writeFileSync(join(inside, "ok.txt"), "ok");
  const facts = new Facts({ root: inside, tmp: join(inside, ".facts"), instance: "i", scope: () => ({ paths: [], plans: [] }), peers: () => [], nameable: () => true });
  expect(facts.rel(join(outside, "x.txt"))).toBeUndefined();
  expect(facts.rel("../o/x.txt")).toBeUndefined();
  expect(facts.rel("ok.txt")).toBe("ok.txt");
});

test("deliverables: a typed name outside the project never reaches the typed-name checks, and an ordinary file is still accepted", () => {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-realpath-deliv-"))); dirs.push(base);
  const root = join(base, "p"); mkdirSync(join(root, "docs"), { recursive: true }); writeFileSync(join(root, "docs/r.md"), "# r");
  expect(() => vetDeliverables([{ path: "docs/r.md", format: "md" }], { cwd: root, deny: [".env"], private: () => false })).not.toThrow();
  expect(() => vetDeliverables([{ path: "docs/nope.md", format: "md" }], { cwd: root, deny: [], private: () => false })).toThrow(DeliverableRefusal);
});

test("the resolved name still counts: an innocent symlink to a denied file is refused by Facts.rel and by a deliverable", () => {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-realpath-resolved-"))); dirs.push(base);
  const root = join(base, "p"); mkdirSync(join(root, ".agenthub"), { recursive: true });
  writeFileSync(join(root, ".env"), "k=v"); symlinkSync(join(root, ".env"), join(root, "notes.txt"));
  writeFileSync(join(root, ".agenthub/state.json"), "{}"); symlinkSync(join(root, ".agenthub/state.json"), join(root, "plain.json"));
  const facts = new Facts({ root, tmp: join(root, ".facts"), instance: "i", scope: () => ({ paths: [], plans: [] }), peers: () => [], nameable: () => true });
  expect(facts.rel("notes.txt")).toBeUndefined();
  const vet = (path: string) => vetDeliverables([{ path, format: "txt" }], { cwd: root, deny: [], private: () => false });
  expect(() => vet("notes.txt")).toThrow(DeliverableRefusal);
  expect(() => vet("plain.json")).toThrow(DeliverableRefusal);
});

test("a typed name outside the project that resolves to an ordinary file inside it keeps working: the typed-name check only judges names inside the project", () => {
  // Without that bound the new check would refuse a name like `<elsewhere>/.env` for a link into the project, which no policy asked for and the old code accepted.
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-realpath-bound-"))); dirs.push(base);
  const root = join(base, "p"), elsewhere = join(base, "o");
  mkdirSync(join(root, "docs"), { recursive: true }); mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(root, "docs/ok.txt"), "ok"); symlinkSync(join(root, "docs/ok.txt"), join(elsewhere, ".env"));
  const facts = new Facts({ root, tmp: join(root, ".facts"), instance: "i", scope: () => ({ paths: [], plans: [] }), peers: () => [], nameable: () => true });
  expect(facts.rel(join(elsewhere, ".env"))).toBe("docs/ok.txt");
  // A deliverable claim is parsed to refuse absolute and `..` paths before it gets here, so this calls the vetting directly: the same bound keeps the typed-name checks to names inside the project.
  expect(() => vetDeliverables([{ path: join(elsewhere, ".env"), format: "txt" }], { cwd: root, deny: [], private: () => false })).not.toThrow();
  expect(() => vetDeliverables([{ path: "docs/ok.txt", format: "txt" }], { cwd: root, deny: [], private: () => false })).not.toThrow();
});
