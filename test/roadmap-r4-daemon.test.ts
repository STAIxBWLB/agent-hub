import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { gitProject } from "./fakes/git-project.ts";

class FixturePeer extends BasePeer { received: string[] = []; async start() { this.setState("idle"); } async stop() { this.setState("offline"); } async deliver(envs: any[]) { this.received.push(...envs.map(env => env.body)); } }

test("R4 daemon and CLI keep previews open, enforce conductor apply, and write the caller worktree", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "roadmap-r4-"))), stateDir = join(root, ".agenthub/state"), home = join(root, "home");
  gitProject(root); expect(hubGitSync(["-C", root, "remote", "add", "origin", "https://github.com/example/repo.git"], { encoding: "utf8" }).status).toBe(0);
  mkdirSync(join(root, ".agenthub"), { recursive: true }); mkdirSync(join(root, "docs")); mkdirSync(home);
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ roadmap: { github_mirror: true, github_write: "conductor" } }));
  const remote: any[] = [], calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[1]?.includes("/milestones?")) return { code: 0, stdout: JSON.stringify(remote) };
    if (args[1]?.includes("/issues?")) return { code: 0, stdout: "[]" };
    if (args[1] === "repos/example/repo/milestones") {
      const item = { number: 7, title: "Public", state: "open", description: args.find(v => v.startsWith("description="))!.slice(12), html_url: "https://github.com/example/repo/milestone/7" };
      remote.push(item); return { code: 0, stdout: JSON.stringify(item) };
    }
    return { code: 1, stdout: "" };
  };
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "roadmap-r4", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, roadmapGh: gh, sdlc: sdlcConfig(undefined),
    config: { ...DEFAULT_CONFIG, roadmap: { github_mirror: true, github_write: "conductor" }, roles: { claude: ["conductor"], codex: ["implementer"] }, roster: { claude: true, codex: true }, conductor: { ...DEFAULT_CONFIG.conductor, feed: "all" }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  const clients: ControlClient[] = [], board = new Board(join(stateDir, "hub.db"));
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: home, AGENTHUB_HOME: join(home, "hub"), NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, out, err };
  };
  try {
    for (const id of ["claude", "codex"]) { const peer = new FixturePeer(id); daemon.bus.add(peer); await peer.start(); }
    const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }), agent = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: root }), conductor = await ControlClient.connect(stateDir, { role: "tools", peer: "claude", projectRoot: root }); clients.push(person, agent, conductor);
    board.newMilestone({ title: "Public", outcome: "Outcome" }, "user");
    const op = (client: ControlClient, operation: string, args: object) => client.request({ t: "task", op: operation, args });
    expect((await op(agent, "hub_roadmap_check", {})).ok).toBe(true);
    const preview = await op(agent, "roadmap_sync", {}); expect(preview.ok, String(preview.error)).toBe(true);
    const fingerprint = JSON.parse(preview.text).fingerprint;
    expect((await op(agent, "roadmap_sync_apply", { apply: true, confirm: fingerprint })).ok).toBe(false);
    expect((await op(conductor, "roadmap_sync_apply", { apply: true, confirm: fingerprint })).ok).toBe(true);
    expect(calls.filter(args => args.includes("POST"))).toHaveLength(1);
    const exported = await cli("roadmap", "export", "--write"); expect(exported.code, exported.err).toBe(0);
    expect(readFileSync(join(root, "docs/roadmap.json"), "utf8")).toContain("Public");
    expect(readFileSync(join(root, "docs/roadmap.md"), "utf8")).toContain("Public");
    const checked = await cli("roadmap", "check", "--json"); expect(checked.code, checked.err).toBe(0); expect(JSON.parse(checked.out).findings).toBeArray();
    const task = board.propose("user", { title: "feat: notice fixture", class: "plan" });
    board.update(task.id, "user", "assigned", { owner: "codex" });
    const current = board.milestone(1)!; board.linkMilestone(1, "task", String(task.id), "user", current.revision);
    const accepted = await op(agent, "hub_task_accept", { id: task.id }); expect(accepted.ok, String(accepted.error)).toBe(true);
    const peer = daemon.bus.peers.get("claude") as FixturePeer;
    for (let i = 0; i < 200 && peer.received.filter(body => body.includes("drift rule 6")).length < 2; i++) await Bun.sleep(10);
    expect(peer.received.filter(body => body.includes("drift rule 6"))).toHaveLength(2);
    expect(peer.received.filter(body => body.includes("drift rule 6")).every(body => !body.includes("notice fixture"))).toBe(true);
    expect((await op(agent, "hub_task_done", { id: task.id, summary: "complete" })).ok).toBe(true);
    await Bun.sleep(100);
    expect(peer.received.filter(body => body.includes("drift rule 6"))).toHaveLength(2);
  } finally { for (const client of clients) client.close(); board.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
