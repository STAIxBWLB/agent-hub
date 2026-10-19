import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { ReviewerPrintPeer } from "../src/adapters/reviewer-print.ts";
import { ControlClient } from "../src/hub/control-client.ts";
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const until = async (condition: () => boolean) => { for (let n = 0; n < 200 && !condition(); n++) await Bun.sleep(10); expect(condition()).toBe(true); };

test("daemon Kimi fresh reviews use task capabilities and separate clean homes on the shared account", async () => {
 const root = mkdtempSync(join(tmpdir(), "ahub-kimi-review-daemon-")), native = join(root, "native"), bin = join(root, "bin"), project = join(root, "project"), stateDir = join(project, "state"), log = join(root, "review.log");
 cleanups.push(() => rmSync(root, { recursive: true, force: true }));
 for (const dir of [native, bin, project, join(native, "credentials"), join(native, "oauth")]) mkdirSync(dir, { recursive: true });
 writeFileSync(join(native, "device_id"), "fixture-device");
 writeFileSync(join(native, "config.toml"), 'default_model="model"\n[providers."managed:kimi-code"]\ntype="kimi"\nbase_url="https://api.kimi.ai/coding/v1"\n[providers."managed:kimi-code".oauth]\nstorage="file"\nkey="oauth/kimi-code"\n[models.model]\nprovider="managed:kimi-code"\nmodel="kimi-for-coding"\n');
 const fake = resolve(import.meta.dir, "fakes/fake-kimi-reviewer.ts"), executable = join(bin, "kimi");
 writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${fake}' '${log}' "$@"\n`); chmodSync(executable, 0o755);
 const originalPath = process.env.PATH, originalHome = process.env.KIMI_CODE_HOME;
 process.env.PATH = `${bin}:${originalPath}`; process.env.KIMI_CODE_HOME = native;
 cleanups.push(() => { process.env.PATH = originalPath; if (originalHome === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = originalHome; });
 const daemon = await startDaemon({ cwd: project, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0,
  config: { ...DEFAULT_CONFIG, instances: { "kimi-review": { kind: "kimi", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } }, roles: { ...DEFAULT_CONFIG.roles, builder: ["implementer"] },
   budget: { ...DEFAULT_CONFIG.budget, checkpoint_timeout_s: 1 }, tasks: { ...DEFAULT_CONFIG.tasks, wip_limits: { builder: 3 } }, review: { ...DEFAULT_CONFIG.review, pool: ["kimi"] }, batch_ms: 0,
   snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
   mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
 cleanups.push(() => daemon.stop());
 const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => console_.close());
 expect(await console_.request({ t: "start", peer: "kimi-review" })).toMatchObject({ ok: true });
 expect((daemon.bus.peers.get("kimi-review") as ReviewerPrintPeer).isolationReceipt?.binary).toBe(realPath(executable));
 const builder = await ControlClient.connect(stateDir, { role: "peer", peer: "builder", channel: true }); cleanups.push(() => builder.close());
 await until(() => daemon.bus.stateOf("builder") === "idle");
 const db = new Database(join(stateDir, "hub.db"), { readonly: true }); cleanups.push(() => db.close());
 for (const title of ["first", "second"]) {
  const proposal = await builder.request({ t: "task", op: "hub_task_propose", args: { title, class: "implement", owner: "builder", reviewer: "kimi-review" } });
  expect(proposal.ok).toBe(true); const id = Number(String(proposal.text).match(/task #(\d+)/)?.[1]);
  expect((await builder.request({ t: "task", op: "hub_task_done", args: { id, summary: "BUILDER NARRATIVE" } })).ok).toBe(true);
  try { await until(() => (db.query("SELECT state FROM tasks WHERE id = ?").get(id) as { state: string }).state === "approved"); } catch (error) { console.error(JSON.stringify({row:db.query("SELECT state,history FROM tasks WHERE id = ?").get(id),native:existsSync(log)?readFileSync(log,"utf8"):"no native log"})); throw error; }
  await until(() => daemon.bus.stateOf("kimi-review") === "idle");
 }
 const rows = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => !row.stage);
 expect(rows).toHaveLength(2); expect(new Set(rows.map(row => row.home)).size).toBe(2);
 for (const row of rows) {
  expect(row.tools).toEqual(["hub_review", "hub_task_show"]); expect(row.wrongRefused).toBe(true);
  expect(row.cwd).not.toBe(project); expect(existsSync(row.home)).toBe(false);
  expect(row.agent).not.toContain("BUILDER NARRATIVE"); expect(JSON.stringify(row.show)).not.toContain("BUILDER NARRATIVE");
 }
 expect(await console_.request({ t: "budget", set: { peer: "kimi-review", used: 0.99, resetsInMs: 60_000 } })).toMatchObject({ ok: true });
 await until(() => daemon.bus.stateOf("kimi-review") === "paused");
 const shared = (await console_.request({ t: "budget" })).budget;
 expect(shared.kimi.paused).toBeDefined();
 expect(shared["kimi-review"]).toBeUndefined();
 expect(await console_.request({ t: "budget", resume: "kimi" })).toMatchObject({ ok: true });
 await until(() => daemon.bus.stateOf("kimi-review") === "idle");

});
