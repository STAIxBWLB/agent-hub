import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeOrcaCompanionHost } from "./helpers/orca-companion-host.ts";
import { FakeOrcaCompanionCli } from "./fakes/orca-companion-cli.ts";

// #1198 O1 AC3 and AC7 over the O0 fixtures: the companion never decides anything the existing screens decide, and removing it changes nothing else. The native leg (a real Orca profile) is
// integrations/orca/native-receipt.md and is a person-run step; nothing here claims it.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
// @ts-ignore TS7016: untyped plain JavaScript by design
const worker: any = await import("../integrations/orca/src/worker.mjs");
const ROOT = realpathSync(join(import.meta.dir, ".."));
const PLUGIN = join(ROOT, "integrations/orca");

function tree(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? tree(join(dir, entry.name)).map(p => `${entry.name}/${p}`) : [entry.name]);
}

test("AC3: the worker's whole surface of host calls is read-and-navigate, never an approval, assignment, completion, retry, stop or upgrade", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ahub-orca-indep-"))); dirs.push(dir);
  const root = join(dir, "p"); mkdirSync(root);
  const fake = new FakeOrcaCompanionHost({ offeredMethods: ["workspace.list", "workspace.readContext", "workspace.open", "shell.openExternal"], surface: "worker", capabilities: ["workspace:read", "workspace:write"],
    workspaces: [{ id: "w", kind: "worktree", name: "n", path: root, branch: null, hostId: "local" }], syntheticState: { agents: ["a1", "a2"], worktrees: ["wt"], terminals: ["t1"] } });
  const before = fake.snapshot();
  const methods: string[] = [], terminals: unknown[] = [];
  const host = { has: (m: string) => m === "terminal.create" || fake.has(m), call: async (m: string, p?: unknown) => { methods.push(m); if (m === "terminal.create") { terminals.push(p); return { terminalId: "t" }; } return fake.call(m, p); } };
  const cli = new FakeOrcaCompanionCli({ hostId: "local", scripted: [{ stdout: "Dashboard opened. ok\n", exitCode: 0 }] });
  const c = worker.createCompanion({ host, readSettings: async () => ({ localHostIds: "local" }), spawnCli: cli.run });
  const snapshot = { id: "w", hostId: "local", root, kind: "worktree" };
  await c.list(); await c.bind({ id: "w" });
  for (const kind of ["dashboard", "console", "family"]) expect((await c.open({ kind, snapshot })).ok).toBe(true);
  // every host method the worker called is one of these four, and none of them changes agents, worktrees or terminals of the synthetic state
  expect([...new Set(methods)].sort()).toEqual(["terminal.create", "workspace.list", "workspace.open"]);
  expect(fake.snapshot()).toEqual(before);
  // the only commands it ever runs or types are these, and each is fixed
  expect(cli.calls.map(call => [call.executable, call.argv])).toEqual([["ahub", ["ui"]]]);
  expect(terminals.map((t: any) => t.command)).toEqual(["'ahub' 'console'", "'acon' 'ui'"]);
  // an unknown kind (an approval, a stop) is not an entry point at all
  for (const kind of ["approve", "stop", "retry", "assign", "complete", "upgrade", "task", "agent"]) {
    expect(await c.open({ kind, snapshot })).toMatchObject({ ok: false, refusal: "bad_request" });
  }
  expect(cli.calls).toHaveLength(1); expect(terminals).toHaveLength(2);
});

test("AC7: the companion holds no state and no process, so disabling it leaves every other thing as it was", async () => {
  const source = readFileSync(join(PLUGIN, "src/worker.mjs"), "utf8") + readFileSync(join(PLUGIN, "src/companion.mjs"), "utf8");
  // no timers, no intervals, no detached or long-lived child, no file writes, no environment writes, no network
  expect(source).not.toMatch(/setInterval|writeFile|appendFile|mkdirSync|createWriteStream|process\.env\.\w+\s*=|fetch\(|http\.request|net\.connect|XMLHttpRequest|WebSocket/);
  // the only child is the short-lived `ahub ui`, killed with its process group on timeout, and the deactivate hook holds nothing
  expect(source.match(/spawn\(/g)).toHaveLength(1);
  expect(source).toContain("export async function deactivate()");
  // a worker that has handled requests leaves the filesystem exactly as it found it
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ahub-orca-indep2-"))); dirs.push(dir);
  const root = join(dir, "p"); mkdirSync(root);
  const stat = () => tree(dir).map(p => [p, statSync(join(dir, p)).mtimeMs]);
  const before = stat();
  const fake = new FakeOrcaCompanionHost({ offeredMethods: ["workspace.list", "workspace.open"], surface: "worker", capabilities: ["workspace:read", "workspace:write"], workspaces: [{ id: "w", kind: "worktree", name: "n", path: root, branch: null, hostId: "local" }] });
  const c = worker.createCompanion({ host: { has: (m: string) => fake.has(m), call: (m: string, p?: unknown) => fake.call(m, p) }, readSettings: async () => ({ localHostIds: "local" }), spawnCli: new FakeOrcaCompanionCli({ hostId: "local", scripted: [] }).run });
  await c.list(); await c.open({ kind: "dashboard", snapshot: { id: "w", hostId: "local", root, kind: "worktree" } });
  expect(stat()).toEqual(before);
});

test("AC7: nothing in the ahub runtime depends on the companion, and the package ships exactly what it did", () => {
  // no source file of the package refers to the plugin folder, to Orca's plugin API, or to the companion's names
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of walk(join(ROOT, "src")).filter(f => /\.(ts|js|mjs)$/.test(f))) {
    const text = readFileSync(file, "utf8");
    expect(text, file).not.toMatch(/integrations\/orca|agent-hub-companion|orca\.plugin|orca-plugin\.json/);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  expect(pkg.files).not.toContain("integrations"); expect(pkg.files.join(" ")).not.toMatch(/integrations|orca/);
  // O1 adds no runtime dependency: the one first-party package (AGENTS.md) is all there is.
  expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@staix/agent-mem"]);
  // the plugin imports nothing from the package and nothing third-party: only node builtins and its own files
  for (const file of ["src/worker.mjs", "src/companion.mjs"]) {
    const imports = [...readFileSync(join(PLUGIN, file), "utf8").matchAll(/^import .* from "([^"]+)"/gm)].map(m => m[1]!);
    for (const spec of imports) expect(spec.startsWith("node:") || spec.startsWith("./"), `${file} imports ${spec}`).toBe(true);
  }
  expect(tree(PLUGIN).sort()).toEqual(expect.arrayContaining(["orca-plugin.json", "panel/index.html", "src/companion.mjs", "src/worker.mjs", "README.md"]));
});
