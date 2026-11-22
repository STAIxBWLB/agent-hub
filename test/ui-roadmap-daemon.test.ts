import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-ui-roadmap-"))), stateDir = join(cwd, ".agenthub/state"), home = join(cwd, "home");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  gitProject(cwd); mkdirSync(join(cwd, ".agenthub"), { recursive: true }); mkdirSync(home);
  writeFileSync(join(cwd, ".agenthub/config.local.json"), '{"instances":{}}\n');
  const daemon = await startDaemon({ cwd, stateDir, projectId: "ui-roadmap-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    sdlc: sdlcConfig(undefined), config: { ...DEFAULT_CONFIG, roles: { claude: ["conductor"], kimi: ["planner"], codex: ["implementer"] }, batch_ms: 0,
      roster: { claude: true, kimi: true, codex: true, qwen: false, jcode: false, pi: false, local: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  cleanup.push(() => daemon.stop());
  for (const id of ["claude", "kimi", "codex"]) { const peer = new FixturePeer(id); daemon.bus.add(peer); await peer.start(); }
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  const planner = await ControlClient.connect(stateDir, { role: "tools", peer: "kimi", projectRoot: cwd });
  cleanup.push(() => { for (const client of [person, planner]) client.close(); });
  const board = new Board(join(stateDir, "hub.db")); cleanup.push(() => board.close());
  const act = (action: Record<string, unknown>, instanceId: string | undefined = person.instanceId) =>
    person.request({ t: "ui_action", instanceId, action: { ...action } }) as Promise<Record<string, any>>;
  const tries = async (action: Record<string, unknown>) => {
    try { return await act(action); } catch (error) { return { ok: false, error: String((error as Error).message) }; }
  };
  return { cwd, stateDir, daemon, person, planner, board, act, tries };
}

test("a dashboard roadmap write fences the revision it rendered, and a stale page is refused before it writes", async () => {
  const f = await fixture();
  const created = await f.act({ action: "roadmap_new", title: "R5 dashboard milestone", outcome: "Ship the roadmap view", horizon: "now" });
  expect(created.ok).toBe(true);
  const { id, revision } = created.milestone as { id: number; revision: number };
  const edited = await f.act({ action: "roadmap_edit", id, revision, fields: { title: "Edited from the page" } });
  expect(edited.ok).toBe(true);
  // The page that named `revision` is now behind the hub; every management verb it can send is refused, and its cause is named.
  const stale = [
    { action: "roadmap_edit", id, revision, fields: { title: "Second edit" } },
    { action: "roadmap_state", id, revision, state: "active" },
    { action: "roadmap_move", id, revision, horizon: "next", order: 0 },
    { action: "roadmap_link", id, revision, kind: "issue", ref: "example/repo#42" },
    { action: "roadmap_unlink", id, revision, kind: "issue", ref: "example/repo#42" },
  ];
  for (const action of stale) {
    const reply = await f.tries(action);
    expect(reply.ok, String(action.action)).toBe(false);
    expect(String(reply.error)).toContain("roadmap changed since this page loaded");
    expect(String(reply.error)).toContain("reload the dashboard");
  }
  const row = f.board.milestone(id);
  expect(row?.title).toBe("Edited from the page");
  expect(row?.state).toBe("proposed");
  expect(row?.horizon).toBe("now");
  expect(f.board.milestoneLinks().filter(link => link.milestone === id)).toHaveLength(0);
  // A reloaded page acts on the revision the hub now reports, and the same verbs succeed.
  const current = (await f.act({ action: "roadmap_state", id, revision: edited.milestone.revision, state: "active" })).milestone;
  expect(current.state).toBe("active");
  const moved = await f.act({ action: "roadmap_move", id, revision: current.revision, horizon: "next", order: 0 });
  expect(moved.ok).toBe(true);
  expect(moved.milestones.find((milestone: { id: number }) => milestone.id === id).horizon).toBe("next");
  const linked = await f.act({ action: "roadmap_link", id, revision: f.board.milestone(id)!.revision, kind: "issue", ref: "example/repo#42" });
  expect(linked.ok).toBe(true);
  // A page from before a restart, and a non-console control client, never reach the write.
  const restarted = await f.act({ action: "roadmap_edit", id, revision: f.board.milestone(id)!.revision, fields: { title: "After restart" } }, "stale-instance");
  expect(restarted.ok).toBe(false);
  expect(String(restarted.error)).toContain("hub restarted");
  const refused = await f.planner.request({ t: "ui_action", action: { action: "roadmap_edit", id, revision: f.board.milestone(id)!.revision, fields: { title: "Not the person" } } }) as Record<string, unknown>;
  expect(refused.ok).toBe(false);
  expect(String(refused.error)).toContain("console");
  expect(f.board.milestone(id)?.title).toBe("Edited from the page");
}, 20_000);
