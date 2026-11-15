import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { gitProject } from "./fakes/git-project.ts";
import { TASK_TOOLS, projectToolList } from "../src/hub/hub-tools.ts";

// R3 (#1481) over the real wire: a real daemon, a fake `gh` through the host-only seam and the real CLI. No real GitHub is read or written.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class FixturePeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}
const issue = (number: number, milestone: number | null = null) => ({ number, title: `Export issue ${number}`, url: `https://github.com/example/repo/issues/${number}`, pr: false, milestone });
async function fixture() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-roadmap-r3-daemon-"))), stateDir = join(cwd, ".agenthub/state"), home = join(cwd, "home");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  gitProject(cwd); mkdirSync(join(cwd, ".agenthub"), { recursive: true }); mkdirSync(home);
  writeFileSync(join(cwd, ".agenthub/config.local.json"), '{"instances":{}}\n');
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "example/repo" }) };
    const path = args[1] ?? "";
    if (!/[?&]page=1(?:&|$)/.test(path)) return { code: 0, stdout: "[]" };
    return { code: 0, stdout: JSON.stringify(path.includes("/milestones?")
      ? [{ number: 2, title: "GitHub beta", description: "Ship the beta", due: null, url: "https://github.com/example/repo/milestone/2" }]
      : [issue(1), issue(2, 2)]) };
  };
  const daemon = await startDaemon({ cwd, stateDir, projectId: "roadmap-r3", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, roadmapGh: gh,
    sdlc: sdlcConfig(undefined), config: { ...DEFAULT_CONFIG, roles: { claude: ["conductor"], kimi: ["planner"], codex: ["implementer"] }, batch_ms: 0,
      roster: { claude: true, kimi: true, codex: true, qwen: false, jcode: false, pi: false, local: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  cleanup.push(() => daemon.stop());
  for (const id of ["claude", "kimi", "codex"]) { const peer = new FixturePeer(id); daemon.bus.add(peer); await peer.start(); }
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  const planner = await ControlClient.connect(stateDir, { role: "tools", peer: "kimi", projectRoot: cwd });
  const conductor = await ControlClient.connect(stateDir, { role: "tools", peer: "claude", projectRoot: cwd });
  const ordinary = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: cwd });
  cleanup.push(() => { for (const client of [person, planner, conductor, ordinary]) client.close(); });
  const board = new Board(join(stateDir, "hub.db")); cleanup.push(() => board.close());
  const op = (client: ControlClient, name: string, args: object) => client.request({ t: "task", op: name, args }, 5000);
  const cli = async (args: string[], markers: Record<string, string> = {}) => {
    const env = { PATH: process.env.PATH ?? "", HOME: home, AGENTHUB_HOME: join(home, "hub"), NO_COLOR: "1", COLUMNS: "100", ...markers };
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try { const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, out, err }; }
    finally { clearTimeout(timer); await child.exited; }
  };
  return { cwd, stateDir, daemon, person, planner, conductor, ordinary, board, op, cli, calls };
}

test("unplaced is a read for every agent and the CLI renders it; private tasks are only counted", async () => {
  const f = await fixture();
  f.board.propose("user", { title: "Public unplaced task", class: "plan" });
  f.board.propose("user", { title: "R3_DAEMON_PRIVATE_CANARY", class: "plan", signals: ["pii_path"] });
  for (const client of [f.ordinary, f.planner, f.person]) {
    const reply = await f.op(client, "hub_roadmap_unplaced", {});
    expect(reply.ok, String(reply.error)).toBe(true);
    const view = JSON.parse(reply.text);
    expect(view.issues.map((row: { ref: string }) => row.ref)).toEqual(["example/repo#1", "example/repo#2"]);
    expect(view.tasks.map((row: { title: string }) => row.title)).toEqual(["Public unplaced task"]);
    expect(view.privateTasks).toBe(1); expect(reply.text).not.toContain("R3_DAEMON_PRIVATE_CANARY");
  }
  const bad = await f.op(f.planner, "hub_roadmap_unplaced", { unknown: true });
  expect(bad.ok).toBe(false); expect(String(bad.error)).toContain("roadmap unplaced");
  const human = await f.cli(["roadmap", "unplaced"]);
  expect(human.code, human.err).toBe(0);
  expect(human.out).toContain("Unplaced work (example/repo)"); expect(human.out).toContain("example/repo#1: Export issue 1");
  expect(human.out).toContain("Private tasks counted, not listed: 1"); expect(() => JSON.parse(human.out)).toThrow();
  const machine = await f.cli(["roadmap", "unplaced", "--json"], { AGENTHUB_PEER_ID: "codex" });
  expect(machine.code, machine.err).toBe(0); expect(JSON.parse(machine.out).privateTasks).toBe(1);
  // Every GitHub call was a read.
  for (const call of f.calls) expect(call.some(word => /^(-X|--method|-f|-F|--input)$/.test(word))).toBe(false);
}, 30_000);

test("triage, accept and reject are the planner's and conductor's; an ordinary agent is refused; no model reports it plainly", async () => {
  const f = await fixture();
  f.board.newMilestone({ title: "Export surface", outcome: "People can export the roadmap", state: "active" }, "kimi", 1000);
  // The test daemon has inference off, so triage says so instead of failing or linking anything.
  const triage = await f.op(f.planner, "hub_roadmap_triage", {});
  expect(triage.ok, String(triage.error)).toBe(true);
  expect(JSON.parse(triage.text)).toMatchObject({ unavailable: expect.stringContaining("no answer"), suggestions: [] });
  expect(f.board.milestoneLinks()).toEqual([]);
  const denied = await f.op(f.ordinary, "hub_roadmap_triage", {});
  expect(denied.ok).toBe(false); expect(String(denied.error)).toMatch(/planner|conductor|person/);
  for (const args of [{ op: "accept", suggestion: 1 }, { op: "reject", suggestion: 1 }]) {
    const refused = await f.op(f.ordinary, "hub_roadmap_edit", args);
    expect(refused.ok).toBe(false); expect(String(refused.error)).toMatch(/planner|conductor|person/);
  }
  // A suggestion stored by the hub is listed read-only and applied by exactly one accept.
  const stored = f.board.addSuggestion({ kind: "issue", ref: "example/repo#1", milestone: 1, proposal: null, citeMilestone: "export the roadmap", citeItem: "Export issue 1" }, "hub", 2000)!;
  // Pending suggestions are public planning text, read like the milestones themselves: any agent may list them, only a planner or the conductor may apply one.
  const listed = await f.op(f.ordinary, "hub_roadmap_triage", { list: true });
  expect(listed.ok, String(listed.error)).toBe(true);
  expect(JSON.parse(listed.text).suggestions.map((row: { id: number }) => row.id)).toEqual([stored.id]);
  const planned = await f.op(f.planner, "hub_roadmap_triage", { list: true });
  expect(JSON.parse(planned.text).suggestions.map((row: { id: number }) => row.id)).toEqual([stored.id]);
  const accepted = await f.op(f.planner, "hub_roadmap_edit", { op: "accept", suggestion: stored.id });
  expect(accepted.ok, String(accepted.error)).toBe(true);
  expect(f.board.milestoneLinks().map(link => [link.kind, link.ref])).toEqual([["issue", "example/repo#1"]]);
  const again = await f.op(f.planner, "hub_roadmap_edit", { op: "accept", suggestion: stored.id });
  expect(again.ok).toBe(false); expect(String(again.error)).toContain("already accepted");
  const fields = await f.op(f.planner, "hub_roadmap_edit", { op: "accept", suggestion: stored.id, id: 1 });
  expect(fields.ok).toBe(false); expect(String(fields.error)).toContain("unknown fields");
  const cliAccept = await f.cli(["roadmap", "accept", "99"], { AGENTHUB_PEER_ID: "codex" });
  expect(cliAccept.code).not.toBe(0);
}, 30_000);

test("import-github is a console op: no agent and no conductor reaches it; the person's dry run writes nothing and apply is idempotent (AC4)", async () => {
  const f = await fixture();
  for (const client of [f.planner, f.conductor, f.ordinary]) {
    const refused = await f.op(client, "roadmap_import_github", {});
    expect(refused.ok).toBe(false); expect(String(refused.error)).toMatch(/console command|person/);
  }
  const dry = await f.cli(["roadmap", "import-github"]);
  expect(dry.code, dry.err).toBe(0);
  expect(dry.out).toContain("dry run, nothing written"); expect(dry.out).toContain("GitHub #2 GitHub beta: would create; 1 issue, 1 new link");
  expect(f.board.milestones()).toEqual([]);
  const applied = await f.cli(["roadmap", "import-github", "--apply"]);
  expect(applied.code, applied.err).toBe(0); expect(applied.out).toContain("Created 1 milestone, linked 1 issue.");
  expect(f.board.milestones()).toHaveLength(1); expect(f.board.milestones()[0]).toMatchObject({ state: "proposed", title: "GitHub beta" });
  const before = JSON.stringify([f.board.milestones(), f.board.milestoneLinks()]);
  const second = await f.cli(["roadmap", "import-github", "--apply"]);
  expect(second.code, second.err).toBe(0); expect(second.out).toContain("Created 0 milestones, linked 0 issues.");
  expect(JSON.stringify([f.board.milestones(), f.board.milestoneLinks()])).toBe(before);
  const agent = await f.cli(["roadmap", "import-github", "--apply"], { AGENTHUB_PEER_ID: "codex" });
  expect(agent.code).not.toBe(0); expect(agent.err).toMatch(/person|console/);
  const delegated = await f.cli(["--live-test", "roadmap", "import-github", "--apply"], { AGENTHUB_PEER_ID: "codex" });
  expect(delegated.code).not.toBe(0); expect(delegated.err).toMatch(/person|console/);
  expect(f.board.milestones()).toHaveLength(1);
}, 40_000);

test("the new read tool reaches read-only peers, the write-capable ones do not, and the daemon advertises the feature", async () => {
  const f = await fixture();
  expect(DAEMON_FEATURES).toContain("roadmap");
  const all = projectToolList(TASK_TOOLS).map(tool => tool.name), readOnly = projectToolList(TASK_TOOLS, true).map(tool => tool.name);
  for (const name of ["hub_roadmap_unplaced", "hub_roadmap_triage"]) expect(all).toContain(name);
  expect(readOnly).toContain("hub_roadmap_unplaced");
  for (const name of ["hub_roadmap_triage", "hub_roadmap_edit"]) expect(readOnly).not.toContain(name);
  // A read-only peer's control op for the new read is admitted, and its write-capable twin is refused.
  const ro = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex", projectRoot: f.cwd });
  try { expect((await f.op(ro, "hub_roadmap_unplaced", {})).ok).toBe(true); } finally { ro.close(); }
  const unknown = await f.op(f.person, "hub_roadmap_future", {});
  expect(unknown.ok).toBe(false); expect(unknown.rid).toBeGreaterThan(0);
}, 20_000);
