import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (ok: () => boolean) => { for (const end = Date.now() + 10000; !ok() && Date.now() < end;) await Bun.sleep(10); expect(ok()).toBe(true); };
const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

for (const kind of ["claude", "codex"] as const) test(`daemon ${kind} review variant uses fresh isolated children and records pool family`, async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-reviewer-daemon-")), root = join(home, "repo"), bin = join(home, "bin"), stateDir = join(root, "state"), log = join(home, "calls.jsonl");
  mkdirSync(root); mkdirSync(bin); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const fake = resolve(import.meta.dir, kind === "claude" ? "fakes/fake-claude-print.ts" : "fakes/fake-codex-reviewer.ts");
  const executable = join(bin, kind);
  writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`); chmodSync(executable, 0o755);
  const vars = { PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_ACTION: "approve", FAKE_CODEX_REVIEW_LOG: log };
  const before = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]])); Object.assign(process.env, vars);
  cleanup.push(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const peer = `${kind}-review`;
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, codex_bin: executable, instances: { [peer]: { kind, roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } }, roles: { ...DEFAULT_CONFIG.roles, builder: ["implementer"] },
      review: { ...DEFAULT_CONFIG.review, pool: [kind] }, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const connect = async (hello: Parameters<typeof ControlClient.connect>[1]) => { const client = await ControlClient.connect(stateDir, hello); cleanup.push(() => client.close()); return client; };
  const console_ = await connect({ role: "console" });
  expect(await console_.request({ t: "start", peer })).toMatchObject({ ok: true });
  const builder = await connect({ role: "peer", peer: "builder", channel: true });
  await until(() => daemon.bus.stateOf("builder") === "idle");
  expect(await builder.request({ t: "send", to: [peer], body: "builder reasoning" })).toMatchObject({ ok: false, error: expect.stringContaining("review-only") });
  const task = async (op: string, args: Record<string, unknown>) => { const reply = await builder.request({ t: "task", op, args }); expect(reply).toMatchObject({ ok: true }); return String(reply.text); };
  const db = new Database(join(stateDir, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  for (let i = 0; i < 2; i++) {
    const proposed = await task("hub_task_propose", { title: `fixture ${i}`, class: "implement", owner: "builder" });
    const id = Number(/#(\d+)/.exec(proposed)![1]);
    await task("hub_task_accept", { id }); await task("hub_task_done", { id, summary: "BUILDER NARRATIVE" });
    const row = () => db.query("SELECT state, history FROM tasks WHERE id = ?").get(id) as { state: string; history: string };
    await until(() => row().state === "approved");
    expect(JSON.parse(row().history).at(-1)).toMatchObject({ by: peer, reviewContext: "fresh", reviewerFamily: kind, reviewerReason: "rotation" });
    await until(() => daemon.bus.stateOf(peer) === "idle");
  }
  const calls = lines(log).filter(line => line.argv);
  expect(calls).toHaveLength(2);
  const reads = lines(log).filter(line => line.show);
  expect(reads).toHaveLength(2);
  for (const row of reads) expect(JSON.stringify(row.show)).not.toContain("BUILDER NARRATIVE");
  for (const call of calls) {
    expect(call.prompt).not.toContain("BUILDER NARRATIVE"); expect(call.peer).toBe(peer);
    if (kind === "codex") {
      expect(call.argv).toContain("--ephemeral"); expect(call.argv).toContain("--ignore-rules");
      for (const feature of ["plugins", "hooks", "apps"]) expect(call.argv.some((arg: string, index: number) => arg === "--disable" && call.argv[index + 1] === feature)).toBe(true);
      expect(call.argv).toContain('web_search="disabled"');
      expect(call.argv).toContain('default_permissions="ahub-review"');
      const projects = Bun.TOML.parse(call.argv.find((value: string) => value.startsWith("projects="))) as { projects: Record<string, { trust_level: string }> };
      expect(Object.values(projects.projects)).toEqual([{ trust_level: "untrusted" }]);
      const servers = (Bun.TOML.parse(call.argv.find((value: string) => value.startsWith("mcp_servers="))) as { mcp_servers: Record<string, { enabled_tools: string[] }> }).mcp_servers;
      expect(servers["agent-hub"]!.enabled_tools).toEqual(["hub_review", "hub_task_show"]);
      const profile = Bun.TOML.parse(call.argv.find((value: string) => value.startsWith("permissions="))) as { permissions: Record<string, { filesystem: Record<string, string> }> };
      expect(profile.permissions["ahub-review"]!.filesystem[stateDir]).toBe("deny");
    } else expect(call.argv).toContain("--strict-mcp-config");
  }
  if (kind === "claude") expect(new Set(calls.map(call => call.argv[call.argv.indexOf("--session-id") + 1])).size).toBe(2);
});

test("declared unavailable variants refuse startup and recovery cannot downgrade reviewer safety", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-reviewer-unavailable-")), stateDir = join(root, "state");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, instances: { "agy-review": { kind: "agy", roles: ["reviewer"], start_mode: "headless" } },
      review: { ...DEFAULT_CONFIG.review, pool: ["agy"] }, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  for (const peer of ["agy-review"]) {
    expect(await console_.request({ t: "start", peer })).toMatchObject({ ok: false, error: expect.stringContaining("agy is an implementer peer (#485)") });
    expect(daemon.bus.stateOf(peer)).toBe("offline");
  }
  const status = (await console_.request({ t: "status" })).status;
  expect(await console_.request({ t: "recovery", op: "prepare", operationId: "reviewer-downgrade", expectedInstanceId: status.instanceId, targetFeatures: status.features.filter((feature: string) => feature !== "reviewer_pool") })).toMatchObject({ ok: false, error: expect.stringContaining("target lacks reviewer_pool") });
  expect((await console_.request({ t: "status" })).status.stopping).toBe(false);
});


test("per-review isolation failure excludes the reviewer until a verified restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-reviewer-prepare-fail-")), root = join(home, "repo"), bin = join(home, "bin"), stateDir = join(root, "state");
  const fail = join(home, "fail"), probes = join(home, "probes");
  mkdirSync(root); mkdirSync(bin); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const executable = join(bin, "codex"), fake = resolve(import.meta.dir, "fakes/fake-codex-reviewer.ts");
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo probe >> '${probes}'; if [ -f '${fail}' ]; then exit 1; fi; fi\nexec '${process.execPath}' '${fake}' "$@"\n`); chmodSync(executable, 0o755);
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, tasks: { ...DEFAULT_CONFIG.tasks, wip_limits: { builder: 3 } }, codex_bin: executable, instances: { "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } }, roles: { ...DEFAULT_CONFIG.roles, builder: ["implementer"] },
      review: { ...DEFAULT_CONFIG.review, pool: ["codex"] }, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  expect(await console_.request({ t: "start", peer: "codex-review" })).toMatchObject({ ok: true });
  const builder = await ControlClient.connect(stateDir, { role: "peer", peer: "builder", channel: true }); cleanup.push(() => builder.close());
  await until(() => daemon.bus.stateOf("builder") === "idle");
  const db = new Database(join(stateDir, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  const task = async (op: string, args: Record<string, unknown>) => { const reply = await builder.request({ t: "task", op, args }); expect(reply).toMatchObject({ ok: true }); return String(reply.text); };
  writeFileSync(fail, "fail next preparation");
  for (let i = 0; i < 2; i++) {
    const proposed = await task("hub_task_propose", { title: `failed preparation ${i}`, class: "implement", owner: "builder" });
    const id = Number(/#(\d+)/.exec(proposed)![1]);
    await task("hub_task_accept", { id }); await task("hub_task_done", { id, summary: "fixture" });
    const row = () => db.query("SELECT reviewer FROM tasks WHERE id = ?").get(id) as { reviewer: string };
    await until(() => row().reviewer === "user");
    await until(() => daemon.bus.stateOf("codex-review") === "idle");
    // One startup proof and one failed proof; later tasks skip it without launching more probes.
    expect(readFileSync(probes, "utf8").trim().split("\n")).toHaveLength(2);
  }
  rmSync(fail);
  expect(await console_.request({ t: "peer_stop", peer: "codex-review" })).toMatchObject({ ok: true, state: "offline" });
  for (const held of daemon.bus.queueList("codex-review").filter(row => row.state === "needs_review")) {
    expect(await console_.request({ t: "queue", op: "resolve", id: held.id, revision: held.revision, action: "discard", reason: "fixture preparation ran no model" })).toMatchObject({ ok: true });
  }
  expect(await console_.request({ t: "start", peer: "codex-review" })).toMatchObject({ ok: true });
  const proposed = await task("hub_task_propose", { title: "recovered preparation", class: "implement", owner: "builder" });
  const id = Number(/#(\d+)/.exec(proposed)![1]);
  await task("hub_task_accept", { id }); await task("hub_task_done", { id, summary: "fixture" });
  expect(db.query("SELECT reviewer FROM tasks WHERE id = ?").get(id)).toMatchObject({ reviewer: "codex-review" });
  await until(() => (db.query("SELECT state FROM tasks WHERE id = ?").get(id) as { state: string }).state === "approved");
  expect(readFileSync(probes, "utf8").trim().split("\n")).toHaveLength(4);
});
