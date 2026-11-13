import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectModelStatus } from "../src/cli/model.ts";
import { renderRuntimeModels } from "../src/cli/output.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import type { ModelObservation, StampedEvent } from "../src/hub/events.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { formatResearch, researchReport, taskRecords } from "../src/hub/research.ts";

// #1402 T5: `ahub status` / `ahub model list` show the last observed model with its grade in place of `not reported`, and `ahub research` prints the share of tasks with a known owner model.

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
const paint = (spans: { text: string }[][]) => spans.map(line => line.map(span => span.text).join("")).join("\n");

test("the CLI projection accepts the two observed sources and still refuses an unknown one", () => {
  const row = { peer: "jcode", effectiveModel: "gpt-5.5", desiredModel: null, source: "observed (session)", pendingNextTurn: false };
  expect(projectModelStatus(row)?.source).toBe("observed (session)");
  expect(projectModelStatus({ ...row, source: "observed (served)" })?.source).toBe("observed (served)");
  for (const bad of ["observed (configured)", "observed", "observed (guess)", "secret"]) expect(projectModelStatus({ ...row, source: bad })).toBeNull();
  const text = paint(renderRuntimeModels([projectModelStatus(row)!]));
  expect(text).toContain("gpt-5.5"); expect(text).toContain("observed (session)"); expect(text).not.toContain("not reported");
  expect(paint(renderRuntimeModels([{ ...row, effectiveModel: null, source: "native default" } as never]))).toContain("not reported");
});

class Reporting extends BasePeer {
  observed: ModelObservation | undefined;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) { this.setState("busy"); queueMicrotask(() => this.setState("idle")); }
  observedModel() { const seen = this.observed; this.observed = undefined; return seen; }
}

async function rig(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-status-model-")), stateDir = join(root, "state");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.local.json"), "{}");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, config: { ...DEFAULT_CONFIG, roster: {}, start: { agents: [] }, batch_ms: 0, configWatch: false,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
    pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
    task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false }, ...config } as never });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  const row = async (peer: string) => ((await console_.request({ t: "model", op: "list" })).models as any[]).find(value => value.peer === peer);
  return { daemon, console_, row, stateDir };
}
const turn = async (daemon: Awaited<ReturnType<typeof rig>>["daemon"], peer: string, text: string) => {
  const before = (daemon.bus.peers.get(peer) as Reporting).state;
  daemon.bus.publish(newEnvelope("user", text, { to: [peer] }));
  for (let i = 0; i < 300 && !(daemon.bus.peers.get(peer)!.state === "idle" && before); i++) await Bun.sleep(10);
  await Bun.sleep(60);
};

test("a finished turn's observed model fills EFFECTIVE MODEL with its grade, until the peer goes offline", async () => {
  const { daemon, console_, row } = await rig();
  const peer = new Reporting("codex", 60_000); daemon.bus.add(peer); await peer.start();
  expect(await row("codex")).toMatchObject({ effectiveModel: null, source: "native default" });
  peer.observed = { model: "gpt-5.5", evidence: "session" };
  await turn(daemon, "codex", "work");
  expect(await row("codex")).toMatchObject({ effectiveModel: "gpt-5.5", source: "observed (session)" });
  const status = (await console_.request({ t: "status" })).status;
  expect(status.runtimeModels.find((value: { peer: string }) => value.peer === "codex")).toMatchObject({ effectiveModel: "gpt-5.5", source: "observed (session)" });
  peer.observed = { model: "gpt-5.5-served", evidence: "served" };
  await turn(daemon, "codex", "more");
  expect(await row("codex")).toMatchObject({ effectiveModel: "gpt-5.5-served", source: "observed (served)" });
  // A turn that reports nothing keeps the last observation; a configured grade or an unsafe id is never shown.
  await turn(daemon, "codex", "silent");
  expect(await row("codex")).toMatchObject({ effectiveModel: "gpt-5.5-served", source: "observed (served)" });
  peer.observed = { model: "from-config", evidence: "configured" };
  await turn(daemon, "codex", "configured");
  expect(await row("codex")).toMatchObject({ effectiveModel: "gpt-5.5-served" });
  await peer.stop();
  await Bun.sleep(60);
  expect(await row("codex")).toMatchObject({ effectiveModel: null, source: "native default" });
});

test("a replaced adapter under the same id does not inherit the earlier owner's observation", async () => {
  const { daemon, row } = await rig();
  const first = new Reporting("codex", 60_000); daemon.bus.add(first); await first.start();
  first.observed = { model: "old-owner-model", evidence: "session" };
  await turn(daemon, "codex", "work");
  expect(await row("codex")).toMatchObject({ effectiveModel: "old-owner-model", source: "observed (session)" });
  const second = new Reporting("codex", 60_000); daemon.bus.add(second); await second.start();
  expect(await row("codex")).toMatchObject({ effectiveModel: null, source: "native default" });
});

test("ahub research prints the share of tasks whose owner model is known (served or session), not configured ones", () => {
  const at = (n: number) => new Date(Date.parse("2026-11-01T00:00:00Z") + n * 60_000).toISOString();
  const events: StampedEvent[] = [];
  const approved = (id: number, owner: string, extra: Record<string, unknown>[]) => {
    events.push({ v: 1, at: at(id * 10), type: "task", id, event: "proposed", by: "hub", state: "proposed", owner: null, reviewer: "claude", class: "implement", pii: false } as StampedEvent,
      { v: 1, at: at(id * 10 + 1), type: "task", id, event: "assigned", by: "hub", state: "in_progress", owner, reviewer: "claude", class: "implement", pii: false } as StampedEvent,
      ...extra.map((e, i) => ({ v: 1, at: at(id * 10 + 2 + i), task: id, attribution: "delivery", peer: owner, ...e }) as StampedEvent),
      { v: 1, at: at(id * 10 + 8), type: "task", id, event: "approved", by: "claude", state: "approved", owner, reviewer: "claude", class: "implement", pii: false } as StampedEvent);
  };
  approved(1, "codex", [{ type: "turn_end", turn: "t1", ms: 1, model: "gpt-5.5", modelEvidence: "session" }]);
  approved(2, "pi", [{ type: "turn_end", turn: "t2", ms: 1, model: "dgx/coding", modelEvidence: "configured" }]);
  approved(3, "kimi", [{ type: "turn_end", turn: "t3", ms: 1 }]);
  approved(4, "jcode", [{ type: "turn_end", turn: "t4", ms: 1, model: "m-4", modelEvidence: "served" }]);
  const report = researchReport(taskRecords(events, "p-1", { version: "test", source: "backfill" }));
  expect(report.modelCoverage).toEqual({ tasks: 4, withModel: 3, grounded: 2, unknown: 1 });
  const text = formatResearch(report).join("\n");
  expect(text).toContain("owner model known (served or session): 2 of 4 tasks (50%)");
});
