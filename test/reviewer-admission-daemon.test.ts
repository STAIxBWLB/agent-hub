import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import type { ReviewerPrintPeer } from "../src/adapters/reviewer-print.ts";
import { renderStatus, type StatusOutput } from "../src/cli/output.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
type TaskRow = { state: string; reviewer: string; history: string };

async function fixture(holdArgument: "exec" | "--version") {
  const home = mkdtempSync(join(tmpdir(), "ahub-review-admission-")), root = join(home, "project"), stateDir = join(home, "state");
  const native = join(home, "native"), bin = join(home, "bin"), hold = join(home, "hold"), entered = join(home, "entered"), release = join(home, "release"), calls = join(home, "calls.jsonl");
  for (const directory of [root, native, bin]) mkdirSync(directory);
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previousHome = process.env.HOME, previousCodex = process.env.CODEX_HOME;
  process.env.HOME = native; process.env.CODEX_HOME = native;
  cleanup.push(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex; });
  const executable = join(bin, "codex"), fake = resolve(import.meta.dir, "fakes/fake-codex-reviewer.ts");
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = ${quote(holdArgument)} ] && [ -f ${quote(hold)} ]; then
  touch ${quote(entered)}
  attempt=0
  while [ ! -f ${quote(release)} ] && [ "$attempt" -lt 150 ]; do sleep 0.01; attempt=$((attempt + 1)); done
  [ -f ${quote(release)} ] || exit 1
fi
export FAKE_CODEX_REVIEW_LOG=${quote(calls)}
exec ${quote(process.execPath)} ${quote(fake)} "$@"
`);
  chmodSync(executable, 0o755);
  const local = { ...DEFAULT_CONFIG.local, deny: [] as string[] };
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, codex_bin: executable, local, batch_ms: 0, watchdog_ms: 5000,
      instances: { "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } },
      roles: { builder: ["implementer"], inspector: ["reviewer"] }, review: { ...DEFAULT_CONFIG.review, pool: ["codex"] },
      tasks: { ...DEFAULT_CONFIG.tasks, wip_limits: { builder: 4 } }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop()); cleanup.push(() => writeFileSync(release, "release"));
  const connect = async (hello: Parameters<typeof ControlClient.connect>[1]) => { const client = await ControlClient.connect(stateDir, hello); cleanup.push(() => client.close()); return client; };
  const person = await connect({ role: "console" });
  expect(await person.request({ t: "start", peer: "codex-review" })).toMatchObject({ ok: true });
  const reviewer = daemon.bus.peers.get("codex-review") as ReviewerPrintPeer;
  const builder = await connect({ role: "peer", peer: "builder", channel: true });
  await connect({ role: "peer", peer: "inspector", channel: true });
  await until(() => daemon.bus.stateOf("builder") === "idle" && daemon.bus.stateOf("inspector") === "idle");
  const db = new Database(join(stateDir, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  const row = (id: number) => db.query("SELECT state,reviewer,history FROM tasks WHERE id = ?").get(id) as TaskRow;
  const op = async (client: ControlClient, name: string, args: Record<string, unknown>) => { const result = await client.request({ t: "task", op: name, args }); expect(result).toMatchObject({ ok: true }); return result; };
  const ready = async (title: string) => {
    const result = await op(builder, "hub_task_propose", { title, class: "implement", owner: "builder" });
    const id = Number(/task #(\d+)/.exec(String(result.text))?.[1]); expect(Number.isSafeInteger(id)).toBe(true);
    await op(builder, "hub_task_accept", { id }); await op(builder, "hub_task_done", { id, summary: "fixture ready" }); return id;
  };
  const healthy = async () => {
    const status = (await person.request({ t: "status" })).status as StatusOutput;
    expect(status.peers["codex-review"].reviewerUnavailable).toBeUndefined();
    expect(renderStatus(status).map(line => line.map(span => span.text).join("")).join("\n")).not.toContain("reviewer isolation unavailable");
  };
  return { home, stateDir, daemon, reviewer, person, builder, local, hold, entered, release, calls, ready, row, op, healthy };
}

test("AC1 a stale queued request leaves real daemon reviewer status healthy and does not reroute", async () => {
  const f = await fixture("exec"); writeFileSync(f.hold, "hold");
  const first = await f.ready("held first review"); await until(() => existsSync(f.entered));
  const stale = await f.ready("queued stale review");
  const envelope = f.daemon.bus.pendingEnvelopes("codex-review").find(env => env.kind === "review" && env.refs?.task === String(stale));
  expect(envelope).toBeDefined(); expect(f.row(stale).reviewer).toBe("codex-review");
  await f.op(f.person, "task_assign", { id: stale, peer: "inspector", role: "reviewer" });
  writeFileSync(f.release, "release");
  await until(() => f.row(first).state === "approved" && f.reviewer.state === "idle");
  const before = f.row(stale).history;
  await f.reviewer.deliver([envelope!]); await until(() => f.reviewer.state === "idle");
  expect(f.row(stale)).toMatchObject({ reviewer: "inspector", state: "in_review", history: before });
  await f.healthy();
  const log = readFileSync(join(f.stateDir, "hub.log"), "utf8");
  expect(log.split("\n").filter(line => line.includes(`task #${stale} skipped: stale binding`))).toHaveLength(1);
  expect(log).not.toContain(`unavailable for task #${stale}`);
});

test("AC2 policy drift after admission reroutes no_verdict while the real daemon reviewer stays reusable", async () => {
  const f = await fixture("--version"); writeFileSync(f.hold, "hold");
  const id = await f.ready("policy changed review"); await until(() => existsSync(f.entered));
  // DaemonOptions.config retains embedding-owned policy references; the real admit closure reads this update.
  f.local.deny.push("new-deny/"); writeFileSync(f.release, "release");
  await until(() => f.row(id).reviewer === "user" && f.reviewer.state === "idle");
  expect(JSON.parse(f.row(id).history).findLast((entry: { event: string }) => entry.event === "reviewer unavailable")).toMatchObject({ reviewerFailure: { peer: "codex-review", cause: "no_verdict" } });
  expect(existsSync(f.calls)).toBe(false); await f.healthy();
  const next = await f.ready("next request uses current policy");
  await until(() => f.row(next).state === "approved" && f.reviewer.state === "idle");
  await f.healthy();
});
