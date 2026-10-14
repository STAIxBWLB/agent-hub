import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesPolicy, policyPaths } from "../src/hub/path-policy.ts";
import { realPath } from "../src/hub/project.ts";
import { guardPath, runTool, type ToolContext } from "../src/local/tools.ts";
import { projectFileTool } from "../src/cli/facts-hook.ts";
import { Board } from "../src/hub/board.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { MemoryClient } from "../src/memory/client.ts";
import { loadRouting } from "../src/hub/routing.ts";
const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
function root() { const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-glob-policy-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test("glob policies accept bounded grammar and match future descendants without widening sibling scopes (#259)", () => {
  const dir = root(); mkdirSync(join(dir, "data/raw/deep"), { recursive: true });
  expect(policyPaths(["data//**/*.csv/", "data/**/*.csv"], "pii.paths")).toEqual(["data/**/*.csv"]);
  for (const raw of [["data/[a]"], ["data/{a,b}"], ["!data/a"], ["data/**x"], ["data/a**"], ["data/../*"], ["data/\\*"], ["a/" + "?".repeat(17)]]) expect(() => policyPaths(raw, "pii.paths")).toThrow();
  for (const path of ["data/one.csv", "data/raw/deep/TWO.CSV", "DATA/future/new.csv"]) expect(matchesPolicy(dir, path, ["data/**/*.csv"])).toBe(true);
  expect(matchesPolicy(dir, "data/raw/deep/a.txt", ["data/**/*.csv"])).toBe(false);
  writeFileSync(join(dir, "data/raw/deep/a.txt"), "public");
  expect(matchesPolicy(dir, "data/raw/deep/a.txt", ["data/**/*.csv"], true)).toBe(false);
  expect(matchesPolicy(dir, "database/a.csv", ["data/**/*.csv"])).toBe(false);
  expect(matchesPolicy(dir, "data/a.csv/child", ["data/*.csv"])).toBe(true);
  expect(matchesPolicy(dir, "data/raw/deep", ["data/**/*.csv"], true)).toBe(true);
  expect(matchesPolicy(dir, ".", ["data/**/*.csv"], true)).toBe(true);
  expect(matchesPolicy(dir, "output", ["data/**/*.csv"], true)).toBe(false);
  expect(matchesPolicy(dir, "data/a1/input", ["data/a?/input"])).toBe(true);
  expect(matchesPolicy(dir, "data/a12/input", ["data/a?/input"])).toBe(false);
  expect(matchesPolicy(dir, "data/가/input", ["data/?/input"])).toBe(true);
  expect(matchesPolicy(dir, "data/😀/input", ["data/?/input"])).toBe(true);
});
test("wildcard directory and file aliases protect real future targets and refresh after retargeting (#259)", () => {
  const dir = root(); mkdirSync(join(dir, "private")); mkdirSync(join(dir, "data")); mkdirSync(join(dir, "public"));
  symlinkSync("../private", join(dir, "data/raw-one")); symlinkSync("private", join(dir, "shortcut"));
  expect(matchesPolicy(dir, "private/new.csv", ["data/raw-*/**/*.csv"])).toBe(true);
  expect(matchesPolicy(dir, "shortcut/new.csv", ["data/raw-*/**/*.csv"])).toBe(true);
  expect(matchesPolicy(dir, "private/new.txt", ["data/raw-*/**/*.csv"])).toBe(false);
  expect(matchesPolicy(dir, "private", ["data/raw-*/**/*.csv"], true)).toBe(true);
  rmSync(join(dir, "data/raw-one")); symlinkSync("../public", join(dir, "data/raw-one"));
  expect(matchesPolicy(dir, "private/new.csv", ["data/raw-*/**/*.csv"])).toBe(false);
  expect(matchesPolicy(dir, "public/new.csv", ["data/raw-*/**/*.csv"])).toBe(true);
  writeFileSync(join(dir, "private/input"), "fixture"); symlinkSync("../private/input", join(dir, "data/raw.csv"));
  expect(matchesPolicy(dir, "private/input", ["data/*.csv"])).toBe(true);
});
test("unresolved or excessive glob discovery protects conservatively without scanning unbounded trees (#259)", () => {
  const dir = root(); mkdirSync(join(dir, "data")); symlinkSync("missing", join(dir, "data/raw"));
  expect(matchesPolicy(dir, "output.txt", ["data/*/*.csv"])).toBe(true);
  rmSync(join(dir, "data/raw"));
  symlinkSync(tmpdir(), join(dir, "data/outside"));
  expect(matchesPolicy(dir, "output.txt", ["data/**/*.csv"])).toBe(true);
  rmSync(join(dir, "data/outside")); symlinkSync(".", join(dir, "data/loop"));
  expect(matchesPolicy(dir, "output.txt", ["data/**/*.csv"])).toBe(true);
  rmSync(join(dir, "data/loop")); let deep = join(dir, "data");
  for (let i = 0; i < 34; i++) { deep = join(deep, "level"); mkdirSync(deep); }
  expect(matchesPolicy(dir, "output.txt", ["data/**/*.csv"])).toBe(true);
});
test("managed writes and Claude scoped grants honor glob policy while retaining reads and ordinary grants (#259)", async () => {
  const dir = root(); mkdirSync(join(dir, "data")); writeFileSync(join(dir, "data/input.csv"), "original"); writeFileSync(join(dir, "output.txt"), "output");
  let approvals = 0;
  const ctx: ToolContext = { cwd: dir, deny: [], readOnly: ["data/**/*.csv"], sandboxProfile: "", permit: async () => { approvals++; return true; }, send: () => "sent" };
  expect(guardPath(ctx, "data/input.csv", "read")).toBe(join(dir, "data/input.csv"));
  expect(await runTool("write", JSON.stringify({ path: "data/input.csv", content: "mutated" }), ctx)).toContain("data.readonly"); expect(approvals).toBe(0);
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    const input = { file_path: "data/input.csv", notebook_path: "data/input.csv" };
    expect(projectFileTool(tool, input, dir, false, ctx.readOnly)).toBe(false);
    expect(projectFileTool(tool, { file_path: "output.txt", notebook_path: "output.txt" }, dir, false, ctx.readOnly)).toBe(true);
  }
  expect(projectFileTool("Read", { file_path: "data/input.csv" }, dir, false, ctx.readOnly)).toBe(true);
  expect(projectFileTool("Edit", { file_path: "data/input.csv" }, dir)).toBe(true);
});
test("glob-private task scopes stay private before triage and refuse public accept expansion (#259)", async () => {
  const dir = root(), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }); cleanup.push(() => board.close());
  class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver() {} }
  for (const id of ["codex", "local"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const notices: string[] = [];
  let calls = 0, saved = 0; const memory = new MemoryClient("http://127.0.0.1:1"); memory.save = async () => { saved++; return undefined; };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", profile: "research", notify: line => notices.push(line), piiPaths: ["data/**/*.csv"], memory, routing: () => loadRouting(dir), triage: { onCampus: async () => false, classify: async () => { calls++; return "implement"; } } });
  const task = await tasks.propose("local", { title: "GLOB_PRIVATE_MARKER", owner: "local", plan: { paths: ["data/future/input.csv"] } });
  expect(tasks.isPii(task)).toBe(true); expect(calls).toBe(0); expect(saved).toBe(0);
  expect(JSON.stringify(tasks.publicView(task))).not.toContain("GLOB_PRIVATE_MARKER"); expect(notices.join(" ")).not.toContain("GLOB_PRIVATE_MARKER");
  const parent = await tasks.propose("local", { title: "GLOB_PARENT_MARKER", class: "draft", owner: "local", refs: { paths: ["data/new"] } }); expect(tasks.isPii(parent)).toBe(true);
  const ordinary = await tasks.propose("codex", { title: "public", class: "draft", owner: "codex", refs: { paths: ["output"] } });
  expect(() => tasks.accept("codex", ordinary.id, { paths: ["data/input.csv"] })).toThrow("PII");
});

test("glob discovery entry ceiling protects rather than treating an incomplete expansion as public (#259)", () => {
  const dir = root(); mkdirSync(join(dir, "data"));
  for (let i = 0; i < 4097; i++) writeFileSync(join(dir, "data", `entry-${i}`), "");
  expect(matchesPolicy(dir, "output.txt", ["data/**/*.csv"])).toBe(true);
});

for (const policy of ["data", "data/*", "data/**"]) {
  test(`${policy} aliases direct directory links and refreshes their targets (#385)`, () => {
    const dir = root();
    for (const name of ["data", "other", "public"]) mkdirSync(join(dir, name));
    writeFileSync(join(dir, "other/f.csv"), "fixture");
    symlinkSync("../other", join(dir, "data/link"));
    expect(matchesPolicy(dir, "other/f.csv", [policy])).toBe(true);
    expect(matchesPolicy(dir, "data/link/f.csv", [policy])).toBe(true);
    rmSync(join(dir, "data/link")); symlinkSync("../public", join(dir, "data/link"));
    expect(matchesPolicy(dir, "other/f.csv", [policy])).toBe(false);
    expect(matchesPolicy(dir, "public/f.csv", [policy])).toBe(true);
  });
  test(`${policy} does not alias links deeper than one level (#385)`, () => {
    const dir = root(); mkdirSync(join(dir, "data/sub"), { recursive: true }); mkdirSync(join(dir, "other"));
    symlinkSync("../../other", join(dir, "data/sub/link"));
    expect(matchesPolicy(dir, "other/f.csv", [policy])).toBe(false);
    expect(matchesPolicy(dir, "data/sub/link/f.csv", [policy])).toBe(true);
  });
  test(`${policy} aliases direct file links and protects containing directory scopes (#385)`, () => {
    const dir = root(); mkdirSync(join(dir, "data")); mkdirSync(join(dir, "private"));
    writeFileSync(join(dir, "private/input"), "fixture"); symlinkSync("../private/input", join(dir, "data/raw.csv"));
    expect(matchesPolicy(dir, "private/input", [policy])).toBe(true);
    expect(matchesPolicy(dir, "private", [policy])).toBe(false);
    expect(matchesPolicy(dir, "private", [policy], true)).toBe(true);
    expect(matchesPolicy(dir, "private/other", [policy])).toBe(false);
  });
}
for (const policy of ["data", "data/**"]) {
  test(`${policy} protects dangling direct targets precisely and refreshes after retargeting (#385)`, () => {
    const dir = root(); mkdirSync(join(dir, "data")); mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/app.ts"), "public"); symlinkSync("../missing", join(dir, "data/link"));
    expect(matchesPolicy(dir, "missing/future.csv", [policy])).toBe(true);
    expect(matchesPolicy(dir, "missing", [policy])).toBe(true);
    expect(matchesPolicy(dir, "src/app.ts", [policy])).toBe(false);
    mkdirSync(join(dir, "missing")); writeFileSync(join(dir, "missing/future.csv"), "later");
    expect(matchesPolicy(dir, "missing/future.csv", [policy])).toBe(true);
    expect(matchesPolicy(dir, "src/app.ts", [policy])).toBe(false);
    rmSync(join(dir, "data/link")); symlinkSync("../replacement", join(dir, "data/link"));
    expect(matchesPolicy(dir, "missing/future.csv", [policy])).toBe(false);
    expect(matchesPolicy(dir, "replacement/future.csv", [policy])).toBe(true);
    expect(matchesPolicy(dir, "src/app.ts", [policy])).toBe(false);
  });
  test(`${policy} discards incomplete direct alias scans without making unrelated files private (#385)`, () => {
    const dir = root(); mkdirSync(join(dir, "data"));
    for (let i = 0; i < 2049; i++) writeFileSync(join(dir, "data", `entry-${i}`), "");
    expect(matchesPolicy(dir, "src/app.ts", [policy])).toBe(false);
    expect(matchesPolicy(dir, "src/app.ts", [policy, policy])).toBe(false);
    expect(matchesPolicy(dir, "src/app.ts", [policy, policy, "src"])).toBe(true);
  });
  test(`${policy} skips unresolvable direct cycles while retaining valid aliases (#385)`, () => {
    const dir = root(); mkdirSync(join(dir, "data")); mkdirSync(join(dir, "other"));
    symlinkSync("b", join(dir, "data/a")); symlinkSync("a", join(dir, "data/b"));
    symlinkSync("../other", join(dir, "data/valid"));
    expect(matchesPolicy(dir, "other/file", [policy])).toBe(true);
    expect(matchesPolicy(dir, "src/app.ts", [policy])).toBe(false);
  });
  test(`${policy} discards every alias from an over-budget root regardless of directory entry order (#385)`, () => {
    const dir = root(); mkdirSync(join(dir, "data")); mkdirSync(join(dir, "other"));
    // Every immediate entry is a matching alias: whichever order readdir returns, a premature
    // positive match is observable. The over-budget root must contribute no alias at all.
    for (let i = 0; i < 4097; i++) symlinkSync("../other", join(dir, "data", `link-${i}`));
    expect(matchesPolicy(dir, "other/future.csv", [policy])).toBe(false);
    expect(matchesPolicy(dir, "src/app.ts", [policy])).toBe(false);
    expect(matchesPolicy(dir, "data/future.csv", [policy])).toBe(true);
    expect(matchesPolicy(dir, "other/future.csv", [policy, "other"])).toBe(true);
  });
}

test("star-segment discovery keeps its existing fail-closed dangling-link behavior (#385)", () => {
  const dir = root(); mkdirSync(join(dir, "data")); symlinkSync("../missing", join(dir, "data/link"));
  expect(matchesPolicy(dir, "src/app.ts", ["data/*"])).toBe(true);
});

test("all policy forms discover direct aliases through case-compatible directory spellings (#385)", () => {
  const dir = root(); mkdirSync(join(dir, "data")); mkdirSync(join(dir, "private"));
  symlinkSync("../private", join(dir, "data/link"));
  for (const policy of ["DATA", "DATA/*", "DATA/**"]) {
    expect(matchesPolicy(dir, "private/file", [policy])).toBe(true);
    expect(matchesPolicy(dir, "elsewhere/file", [policy])).toBe(false);
  }
});

test("direct unresolvable alias cycles are skipped only for subtree roots while deeper cycles are never traversed (#385)", () => {
  const dir = root(); mkdirSync(join(dir, "data/sub"), { recursive: true });
  symlinkSync("b", join(dir, "data/sub/a")); symlinkSync("a", join(dir, "data/sub/b"));
  for (const policy of ["data", "data/*", "data/**"]) expect(matchesPolicy(dir, "other/file", [policy])).toBe(false);
  symlinkSync("b", join(dir, "data/a")); symlinkSync("a", join(dir, "data/b"));
  for (const policy of ["data", "data/**"]) expect(matchesPolicy(dir, "other/file", [policy])).toBe(false);
  expect(matchesPolicy(dir, "other/file", ["data/*"])).toBe(true);
});

test("immediate entry exhaustion discards subtree-root aliases but keeps star-segment discovery fail-closed (#385)", () => {
  const dir = root(); mkdirSync(join(dir, "data"));
  for (let i = 0; i < 4097; i++) writeFileSync(join(dir, "data", `entry-${i}`), "");
  for (const policy of ["data", "data/**"]) expect(matchesPolicy(dir, "other/file", [policy])).toBe(false);
  expect(matchesPolicy(dir, "other/file", ["data/*"])).toBe(true);
  mkdirSync(join(dir, "other")); symlinkSync("other", join(dir, "legacy-root"));
  expect(matchesPolicy(dir, "other/file", ["data", "legacy-*/**"])).toBe(true);
  expect(matchesPolicy(dir, "other/file", ["data/**", "legacy-*/**"])).toBe(true);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("unreadable protected roots fail closed for every policy form (#385)", () => {
  const dir = root(), data = join(dir, "data"); mkdirSync(data); chmodSync(data, 0);
  try {
    for (const policy of ["data", "data/*", "data/**"]) expect(matchesPolicy(dir, "other/file", [policy])).toBe(true);
  } finally { chmodSync(data, 0o700); }
});

test("different direct roots share the remaining budget without poisoning unrelated scopes (#385)", () => {
  const dir = root();
  for (const name of ["data-a", "data-b", "other-a", "other-b"]) mkdirSync(join(dir, name));
  for (const name of ["a", "b"]) {
    for (let i = 0; i < 2048; i++) writeFileSync(join(dir, `data-${name}`, `entry-${i}`), "");
    symlinkSync(`../other-${name}`, join(dir, `data-${name}/link`));
  }
  for (const policies of [["data-a", "data-b"], ["data-a/**", "data-b/**"]]) {
    expect(matchesPolicy(dir, "other-a/file", policies)).toBe(true);
    expect(matchesPolicy(dir, "other-b/file", policies)).toBe(false);
    expect(matchesPolicy(dir, "src/app.ts", policies)).toBe(false);
    expect(matchesPolicy(dir, "other-b/file", [...policies, "other-b"])).toBe(true);
  }
});

test("dangling direct aliases resolve a dangling ancestor to its precise future target (#385)", () => {
  const dir = root(); mkdirSync(join(dir, "data")); mkdirSync(join(dir, "aliases"));
  symlinkSync("missing", join(dir, "aliases/channel")); symlinkSync("../aliases/channel/input", join(dir, "data/link"));
  for (const policy of ["data", "data/**"]) {
    expect(matchesPolicy(dir, "aliases/missing/input", [policy])).toBe(true);
    expect(matchesPolicy(dir, "src/app.ts", [policy])).toBe(false);
  }
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("unreadable matched roots still fail closed after an earlier root exhausts the budget (#385)", () => {
  const dir = root(), denied = join(dir, "denied"); mkdirSync(join(dir, "data")); mkdirSync(denied);
  for (let i = 0; i < 4097; i++) writeFileSync(join(dir, "data", `entry-${i}`), "");
  chmodSync(denied, 0);
  // Linux CI exposed that opening a handle alone need not report EACCES before readSync.
  // The exhausted-budget path must check readability without consuming another entry.
  try {
    for (const policies of [["data", "denied"], ["data/**", "denied/**"]]) expect(matchesPolicy(dir, "src/app.ts", policies)).toBe(true);
  } finally { chmodSync(denied, 0o700); }
});

test("long dangling direct aliases distinguish a future target from native ELOOP (#385)", () => {
  const dir = root(); mkdirSync(join(dir, "data")); mkdirSync(join(dir, "links"));
  symlinkSync("../links/step-1", join(dir, "data/link"));
  for (let i = 1; i < 40; i++) symlinkSync(i === 39 ? "../future/input" : `step-${i + 1}`, join(dir, "links", `step-${i}`));
  let nativeCode = "";
  try { realPath(join(dir, "data/link")); } catch (error) { nativeCode = (error as NodeJS.ErrnoException).code ?? ""; }
  expect(["ENOENT", "ELOOP"]).toContain(nativeCode);
  for (const policy of ["data", "data/**"]) {
    expect(matchesPolicy(dir, "future/input", [policy])).toBe(nativeCode === "ENOENT");
    expect(matchesPolicy(dir, "src/app.ts", [policy])).toBe(false);
  }
});
