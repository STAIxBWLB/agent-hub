import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { gitProject } from "./fakes/git-project.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class FixturePeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}
async function fixture() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-roadmap-daemon-"))), stateDir = join(cwd, ".agenthub/state"), home = join(cwd, "home");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  gitProject(cwd); mkdirSync(join(cwd, ".agenthub"), { recursive: true }); mkdirSync(home);
  writeFileSync(join(cwd, ".agenthub/config.local.json"), '{"instances":{}}\n');
  const daemon = await startDaemon({ cwd, stateDir, projectId: "roadmap-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
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
  const op = (client: ControlClient, name: string, args: object) => client.request({ t: "task", op: name, args }, 2000);
  const cli = async (args: string[], markers: Record<string, string> = {}) => {
    const env = { PATH: process.env.PATH ?? "", HOME: home, AGENTHUB_HOME: join(home, "hub"), NO_COLOR: "1", COLUMNS: "80", ...markers };
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, out, err }; }
    finally { clearTimeout(timer); await child.exited; }
  };
  return { cwd, stateDir, daemon, person, planner, conductor, ordinary, board, op, cli };
}
const fields = { title: "Roadmap acceptance", outcome: "Coherent roadmap", horizon: "now", order: 0 };

test("real roadmap control ops preserve caller authority, CAS, reply unknown ops and hide private tasks", async () => {
  const f = await fixture();
  const created = await f.op(f.planner, "hub_roadmap_edit", { op: "new", fields });
  expect(created.ok).toBe(true);
  const milestone = JSON.parse(created.text);
  const second = await f.op(f.conductor, "hub_roadmap_edit", { op: "new", fields: { ...fields, title: "Conductor outcome" } });
  expect(second.ok).toBe(true);
  const denied = await f.op(f.ordinary, "hub_roadmap_edit", { op: "new", fields });
  expect(denied.ok).toBe(false); expect(String(denied.error)).toMatch(/planner|conductor|person/);
  const edited = await f.op(f.planner, "hub_roadmap_edit", { op: "edit", id: milestone.id, revision: milestone.revision, fields: { title: "Edited milestone" } });
  expect(edited.ok).toBe(true);
  const stale = await f.op(f.planner, "hub_roadmap_edit", { op: "edit", id: milestone.id, revision: milestone.revision, fields: { title: "Stale mutation" } });
  expect(stale.ok).toBe(false); expect(String(stale.error)).toContain("revision");
  for (const args of [{ op: "future", id: milestone.id }, { op: "order", id: milestone.id, order: 1, unknown: true }]) {
    const reply = await f.op(f.person, "hub_roadmap_edit", args);
    expect(reply.ok).toBe(false); expect(String(reply.error)).toMatch(/unknown|invalid/); expect(String(reply.error)).toMatch(/roadmap|console/);
  }
  const unknown = await f.op(f.person, "hub_roadmap_future", {});
  expect(unknown.ok).toBe(false);
  expect(unknown.rid).toBeGreaterThan(0); expect(String(unknown.error)).toContain("unknown roadmap operation");
  const imported = f.board.propose("user", { title: "Inherited task", class: "plan", external: { provider: "github", repo: "example/repo", issue: 42, url: "https://github.com/example/repo/issues/42" } });
  const privateTask = f.board.propose("user", { title: "ROADMAP_DAEMON_PRIVATE_CANARY", detail: "ROADMAP_DAEMON_SECRET_DETAIL", class: "plan", signals: ["pii_path"] });
  expect((await f.op(f.planner, "hub_roadmap_edit", { op: "link", id: milestone.id, kind: "issue", ref: "example/repo#42" })).ok).toBe(true);
  expect((await f.op(f.person, "hub_roadmap_edit", { op: "link", id: milestone.id, kind: "task", ref: String(privateTask.id) })).ok).toBe(true);
  const shown = await f.op(f.ordinary, "hub_roadmap_show", { id: milestone.id });
  expect(shown.ok).toBe(true);
  const view = JSON.parse(shown.text);
  expect(view.title).toBe("Edited milestone");
  expect(view.tasks.map((task: { id: number }) => task.id)).toEqual([imported.id]);
  expect(view.tasks[0].placement).toEqual({ rule: "source-issue", issue: "example/repo#42" });
  expect(view.withheld).toBe(1);
  expect(view.links.some((link: { kind: string }) => link.kind === "task")).toBe(false);
  expect(shown.text).not.toContain("ROADMAP_DAEMON_PRIVATE_CANARY");
  const listed = await f.op(f.ordinary, "hub_roadmap_list", {});
  expect(listed.ok).toBe(true); expect(JSON.parse(listed.text).milestones).toHaveLength(2);
  expect(listed.text).not.toContain("ROADMAP_DAEMON_");
  for (const file of ["hub.log", "events.jsonl"]) if (existsSync(join(f.stateDir, file))) {
    expect(readFileSync(join(f.stateDir, file), "utf8")).not.toContain("ROADMAP_DAEMON_");
  }
}, 20_000);

test("real CLI defaults to human output, offers explicit JSON and blocks agent/delegated final-state writes", async () => {
  const f = await fixture();
  const created = await f.cli(["roadmap", "new", "--title", "CLI milestone", "--outcome", "Ready for review"]);
  expect(created.code, created.err).toBe(0);
  expect(created.out).toContain("CLI milestone"); expect(() => JSON.parse(created.out)).toThrow();
  const initial = await f.op(f.person, "hub_roadmap_list", {}), list = JSON.parse(initial.text).milestones;
  expect(list).toHaveLength(1); const id = String(list[0].id);
  const human = await f.cli(["roadmap", "show", id]);
  expect(human.code, human.err).toBe(0); expect(human.out).toContain("Milestone"); expect(human.out).toContain("CLI milestone");
  const machine = await f.cli(["roadmap", "show", id, "--json"]);
  expect(machine.code, machine.err).toBe(0); expect(JSON.parse(machine.out).title).toBe("CLI milestone");
  const agent = await f.cli(["roadmap", "list", "--json"], { AGENTHUB_PEER_ID: "codex" });
  expect(agent.code, agent.err).toBe(0); expect(JSON.parse(agent.out).milestones).toHaveLength(1);
  const final = await f.cli(["roadmap", "state", id, "done"], { AGENTHUB_PEER_ID: "codex" });
  expect(final.code).not.toBe(0); expect(final.err).toMatch(/person|console/);
  const delegated = await f.cli(["--live-test", "roadmap", "state", id, "done"], { AGENTHUB_PEER_ID: "codex" });
  expect(delegated.code).not.toBe(0); expect(delegated.err).toMatch(/person|console/);
  expect(f.board.milestone(Number(id))?.state).toBe("proposed");
  const invalid = await f.cli(["roadmap", "edit", id, "--revision", "0", "--title", "Must not save", "--unknown"]);
  expect(invalid.code).not.toBe(0); expect(f.board.milestone(Number(id))?.title).toBe("CLI milestone");
  for (const operands of [["future"], ["edit", id, "--revision", "0"], ["link", id, "unknown", "ref"]]) {
    const refused = await f.cli(["roadmap", ...operands], { AGENTHUB_PEER_ID: "codex" });
    expect(refused.code).not.toBe(0); expect(refused.err).toContain("see ahub help roadmap");
  }
}, 20_000);
