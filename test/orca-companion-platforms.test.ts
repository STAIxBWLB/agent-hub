import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeOrcaCompanionHost, type OrcaCompanionFixtureWorkspace } from "./helpers/orca-companion-host.ts";
import { FakeOrcaCompanionCli } from "./fakes/orca-companion-cli.ts";

// #1198 O3 (AC8, AC9): each combination has its own recorded verdict, an unqualified one is refused rather than approximated, and no identity check is loosened for any of them. The receipts
// that need a person's machines are person-run legs; this file proves the rules around them and never claims them.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = (name: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), `ahub-orca-${name}-`))); dirs.push(dir); return dir; };
// @ts-ignore TS7016: untyped plain JavaScript by design
const worker: any = await import("../integrations/orca/src/worker.mjs");
// @ts-ignore TS7016: untyped plain JavaScript by design
const companion: any = await import("../integrations/orca/src/companion.mjs");
const PLUGIN = join(import.meta.dir, "../integrations/orca");

class TestHost {
  readonly calls: string[] = [];
  constructor(readonly fake: FakeOrcaCompanionHost) {}
  has(method: string) { return method === "terminal.create" || this.fake.has(method); }
  async call(method: string, params?: unknown) { this.calls.push(method); if (method === "terminal.create") return { terminalId: "t" }; return this.fake.call(method, params); }
}
function setup(opts: { platform?: string; hostId?: string | null; settings?: Record<string, unknown> } = {}) {
  const base = temp("ws"), root = join(base, "proj with space & $(x)"); mkdirSync(root);
  const hostId = opts.hostId === undefined ? "local" : opts.hostId;
  const row: OrcaCompanionFixtureWorkspace = { id: "ws-a", kind: "worktree", name: "n", path: root, branch: null, hostId };
  const fake = new FakeOrcaCompanionHost({ offeredMethods: ["workspace.list", "workspace.readContext", "workspace.open", "shell.openExternal"], surface: "worker", capabilities: ["workspace:read", "workspace:write"], workspaces: [row] });
  const host = new TestHost(fake), cli = new FakeOrcaCompanionCli({ hostId, scripted: [{ stdout: "Dashboard opened. ok\n", exitCode: 0 }, { stdout: "Dashboard opened. ok\n", exitCode: 0 }] });
  const port = async (call: any) => { const r = await cli.run(call); return { ...r, stderr: "", stderrSaysNoHub: false }; };
  const instance = worker.createCompanion({ host, platform: opts.platform ?? "darwin", readSettings: async () => opts.settings ?? { localHostIds: "local" }, spawnCli: port });
  return { root, fake, host, cli, instance, snapshot: { id: "ws-a", hostId, root, kind: "worktree" } };
}

test("AC8: the support matrix gives every combination its own verdict, and none is claimed without a receipt", () => {
  const matrix = JSON.parse(readFileSync(join(PLUGIN, "support-matrix.json"), "utf8"));
  const ids = matrix.combinations.map((c: { id: string }) => c.id);
  expect(ids).toEqual(["macos-local-desktop", "remote-workspace", "windows-desktop", "browser-or-mobile-client", "linux-desktop"]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const c of matrix.combinations) {
    expect(matrix.verdicts, c.id).toContain(c.verdict);
    expect(typeof c.reason === "string" && c.reason.length > 20, c.id).toBe(true);
    if (c.verdict === "supported") {
      // The rule: supported only with a receipt file that exists and no longer says it was not run.
      expect(c.receipt, `${c.id} is supported without a receipt`).toBeTruthy();
      const file = join(PLUGIN, c.receipt.startsWith("..") ? c.receipt.replace("../", "") : c.receipt);
      expect(existsSync(file), `${c.id}: receipt ${c.receipt} does not exist`).toBe(true);
      expect(readFileSync(file, "utf8"), `${c.id}: receipt still says NOT RUN`).not.toMatch(/Status:\s*\**\s*NOT RUN/);
    }
  }
  // Today no combination is supported: each leg is a person-run step that has not been run. If this ever changes, the receipt above must have been filled in by a person.
  expect(matrix.combinations.filter((c: { verdict: string }) => c.verdict === "supported")).toEqual([]);
  expect(matrix.combinations.find((c: { id: string }) => c.id === "macos-local-desktop").verdict).toBe("fixture_only");
});

test("AC8: every receipt a combination names exists and says NOT RUN, with ids-and-counts-only instructions and no claimed result", () => {
  const matrix = JSON.parse(readFileSync(join(PLUGIN, "support-matrix.json"), "utf8"));
  for (const c of matrix.combinations.filter((x: { receipt: string | null }) => x.receipt)) {
    const file = join(PLUGIN, c.receipt.replace("../", ""));
    expect(existsSync(file), c.id).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text, c.id).toMatch(/NOT RUN/);
    expect(text, c.id).toMatch(/person/i);
    // a receipt is a template: its result fields stay blank (or list the options "PASS / FAIL / PARTIAL"), never a lone pass the person has not written
    expect(text, c.id).not.toMatch(/Overall:\s*(PASS|PASSED)\s*(\n|$)/);
    expect(text, c.id).not.toMatch(/\bPASSED\b/);
  }
  for (const name of ["remote", "windows", "browser-mobile"]) expect(existsSync(join(PLUGIN, "receipts", `${name}.md`)), name).toBe(true);
  expect(readFileSync(join(PLUGIN, "receipts/browser-mobile.md"), "utf8")).toMatch(/not inferred/i);
});

test("AC8: a remote workspace is refused before anything runs, shows the existing remote console command, and no link is opened locally", async () => {
  const s = setup({ hostId: "ssh-box" });
  expect((await s.instance.list()).rows[0]).toMatchObject({ selectable: false, refusal: "remote" });
  for (const kind of ["dashboard", "console", "family"]) {
    const r = await s.instance.open({ kind, snapshot: s.snapshot });
    expect(r).toMatchObject({ ok: false, refusal: "remote", command: "'ahub' 'console'" });
    expect(JSON.stringify(r)).not.toContain(s.root); expect(JSON.stringify(r)).not.toMatch(/https?:\/\//);
  }
  expect(s.cli.calls).toHaveLength(0);
  expect(s.host.calls.filter(m => m === "workspace.open" || m === "terminal.create")).toEqual([]);
  expect(s.fake.openedWorkspaceIds).toEqual([]); expect(s.fake.externalNavigation).toEqual([]);
  expect(await s.instance.status({ snapshot: s.snapshot })).toMatchObject({ ok: false, refusal: "remote" });
  expect(s.cli.calls).toHaveLength(0);
});

test("AC8: declaring a remote host as this Mac does not make its folder bind: the root must still be a real folder here, and the identity checks are the same", async () => {
  // A deliberately wrong setting. The remote project's path does not exist on this Mac, so it cannot bind, and a path that happens to exist is a different project that the id and root checks pin.
  const s = setup({ hostId: "ssh-box", settings: { localHostIds: "ssh-box" } });
  s.fake.setRoster([{ id: "ws-a", kind: "worktree", name: "n", path: "/home/remote-user/project-that-is-not-here", branch: null, hostId: "ssh-box" }]);
  expect((await s.instance.list()).rows[0]).toMatchObject({ selectable: false, refusal: "unreal_root" });
  expect(await s.instance.open({ kind: "dashboard", snapshot: { ...s.snapshot, root: "/home/remote-user/project-that-is-not-here" } })).toMatchObject({ ok: false, refusal: "unreal_root" });
  expect(s.cli.calls).toHaveLength(0);
});

test("AC8: on Windows every workspace is refused and nothing runs; the same checks stay in force elsewhere", async () => {
  const win = setup({ platform: "win32" });
  expect((await win.instance.list()).rows[0]).toMatchObject({ selectable: false, refusal: "unsupported_platform" });
  for (const kind of ["dashboard", "console", "family"]) expect(await win.instance.open({ kind, snapshot: win.snapshot })).toMatchObject({ ok: false, refusal: "unsupported_platform" });
  expect(await win.instance.status({ snapshot: win.snapshot })).toMatchObject({ ok: false, refusal: "unsupported_platform" });
  expect(win.cli.calls).toHaveLength(0); expect(win.host.calls.filter(m => m === "workspace.open" || m === "terminal.create")).toEqual([]);
  expect(companion.REFUSALS.unsupported_platform).toMatch(/not qualified/);
  // macOS and Linux are the same code with the same identity checks: a changed root is still `changed`
  for (const platform of ["darwin", "linux"]) {
    const p = setup({ platform });
    expect((await p.instance.open({ kind: "dashboard", snapshot: p.snapshot })).ok).toBe(true);
    const other = join(p.root, "..", "moved"); mkdirSync(other);
    p.fake.setRoster([{ id: "ws-a", kind: "worktree", name: "n", path: other, branch: null, hostId: "local" }]);
    expect(await p.instance.open({ kind: "dashboard", snapshot: p.snapshot })).toMatchObject({ ok: false, refusal: "changed" });
  }
});

test("AC8: a client without external navigation never holds a link: the panel checks for the API first and tells the person to run ahub ui", () => {
  const html = readFileSync(join(PLUGIN, "panel/index.html"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const guard = html.indexOf('orca.host.has("shell.openExternal")'), hold = html.indexOf("pendingLink = result.url");
  expect(guard).toBeGreaterThan(-1); expect(hold).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(hold);
  expect(html).toContain("cannot open a link. Run `ahub ui` in a terminal");
  // and the fixture host models it: no desktop, no external navigation at all
  const browser = new FakeOrcaCompanionHost({ offeredMethods: ["shell.openExternal"], surface: "panel", capabilities: [], workspaces: [], desktop: false });
  expect(browser.has("shell.openExternal")).toBe(false);
});

test("the #791 nit: a failed status names a next step", () => {
  // @ts-ignore TS7016: untyped plain JavaScript by design
  return import("../integrations/orca/src/status.mjs").then((status: any) => {
    expect(status.STATUS_SENTENCES.failed).toContain("Run `ahub status` in a terminal in the project");
    for (const key of ["offline", "unavailable_version", "failed"]) expect(status.STATUS_SENTENCES[key]).toMatch(/`ahub [a-z]+`/);
  });
});

test("AC9: the support matrix and the docs say the same thing about what is claimed", () => {
  const matrix = JSON.parse(readFileSync(join(PLUGIN, "support-matrix.json"), "utf8"));
  const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");
  for (const c of matrix.combinations) expect(readme, c.id).toContain(c.id);
  expect(readme).toMatch(/person-run/);
  const dogfood = readFileSync(join(import.meta.dir, "../docs/dogfood.md"), "utf8");
  expect(dogfood).toMatch(/#1198 O3/);
  expect(dogfood).toMatch(/person-run/);
});
