import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { HELP } from "../src/cli/help.ts";

// #683 U2: a real daemon folds a real events.jsonl, answers the `usage` control op, and the real `ahub usage` CLI prints it.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const ev = (s: number, e: Record<string, unknown>, day = 9) => JSON.stringify({ v: 1, at: new Date(Date.UTC(2026, 9, day, 0, 0, s)).toISOString(), ...e }) + "\n";
const SECRET_TITLE = "PRIVATE-TITLE-USAGE-FIXTURE";

async function rig(roles: Record<string, string[]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-usage-op-")), stateDir = join(root, ".agenthub", "state");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  const log = join(stateDir, "events.jsonl");
  writeFileSync(log, [
    ev(0, { type: "task", id: 1, state: "in_progress", class: "implement", event: "accepted", by: "codex", owner: "codex", reviewer: "claude", pii: false }),
    ev(1, { type: "task", id: 2, state: "in_progress", class: "implement", event: "accepted", by: "local", owner: "local", reviewer: "claude", pii: true }),
    ev(2, { type: "tokens", peer: "codex", n: 1050, task: 1, attribution: "delivery" }),
    ev(3, { type: "usage", peer: "codex", source: "codex_appserver", id: "c1", inputTokens: 1000, cacheReadTokens: 700, outputTokens: 50, reasoningTokens: 20, totalTokens: 1050, task: 1, attribution: "delivery" }),
    ev(4, { type: "tokens", peer: "local", n: 42, task: 2, attribution: "delivery", pii: true }),
    ev(5, { type: "usage", peer: "local", source: "omniroute", id: "l1", inputTokens: 40, outputTokens: 2, totalTokens: 42, task: 2, attribution: "delivery", pii: true }),
    ev(6, { type: "tokens", peer: "jcode", n: 77, attribution: "unattributed" }),
    ev(7, { type: "budget_pause", peer: "claude", reason: "5h window at 95% (claude status line)", window: "5h", resetsAt: 1_900_000_000_000, by: "hub" }),
    ev(8, { type: "quota_reset", peer: "codex", window: "week", cause: "resets_at_moved", resetsAt: 1_900_100_000_000, previousResetsAt: 1_899_000_000_000, used: 0.03, previousUsed: 0.9 }),
  ].join(""));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, ...(Object.keys(roles).length ? { roles: { ...DEFAULT_CONFIG.roles, ...roles } } : {}), batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); cleanup.push(() => console_.close());
  return { root, stateDir, log, daemon, console_ };
}

test("the console reads usage grouped by peer, task and day, with sources, from the daemon's roll-up (#683 U2)", async () => {
  const { console_ } = await rig();
  const peer = await console_.request({ t: "usage", by: "peer" });
  expect(peer.ok, JSON.stringify(peer)).toBe(true);
  const rows = new Map(peer.usage.rows.map((r: any) => [r.key, r]));
  expect((rows.get("codex") as any).total).toEqual({ value: 1050, source: "native" });
  expect((rows.get("codex") as any).totalWithoutCache).toEqual({ value: 350, source: "native" });
  expect((rows.get("jcode") as any).total).toEqual({ value: null, source: "unknown" });       // jcode reports nothing: unknown, never 0
  expect((rows.get("jcode") as any).counted).toEqual({ value: 77, source: "count" });
  const byTask = await console_.request({ t: "usage", by: "task" });
  expect(byTask.usage.rows.map((r: any) => r.key)).toEqual(["1", "#2"]);
  expect(byTask.usage.rows[1]).toMatchObject({ label: "[pii]", pii: true });
  expect(byTask.usage.unattributed.counted).toEqual({ value: 77, source: "count" });
  expect((await console_.request({ t: "usage", by: "day" })).usage.rows.map((r: any) => r.key)).toEqual(["2026-10-09"]);
});

test("limits returns the history and the open pause, total returns lifetime per peer, and a private task shows no title (#683 U2)", async () => {
  const { console_ } = await rig();
  const limits = await console_.request({ t: "usage", op: "limits" });
  expect(limits.ok).toBe(true);
  expect(limits.limits.history.map((h: any) => h.type)).toEqual(["budget_pause", "quota_reset"]);
  expect(limits.limits.open).toMatchObject([{ peer: "claude", window: "5h" }]);
  expect(limits.current).toBeDefined();
  expect((await console_.request({ t: "usage", op: "limits", peer: "codex" })).limits.history.map((h: any) => h.type)).toEqual(["quota_reset"]);
  const total = await console_.request({ t: "usage", op: "total" });
  expect(total.total.overall.tokens).toEqual({ value: 1050 + 42 + 77, source: "count" });
  expect(JSON.stringify([limits, total, await console_.request({ t: "usage", by: "task" })])).not.toContain(SECRET_TITLE);
});

test("a malformed request is answered with an error, never dropped: every control message with a rid gets a reply (#683 U2)", async () => {
  const { console_ } = await rig();
  for (const bad of [{ by: "nonsense" }, { op: "nonsense" }, { since: "yesterday" }, { until: -1 }, { op: "limits", peer: "../etc" }]) {
    const reply = await console_.request({ t: "usage", ...bad });
    expect(reply.ok, JSON.stringify(bad)).toBe(false);
    expect(typeof reply.error).toBe("string");
  }
});

test("only the console and a configured planner may read usage; every other agent is refused (#683 U2)", async () => {
  const { stateDir, root } = await rig({ claude: ["planner"] });
  const asTools = async (peer: string) => { const c = await ControlClient.connect(stateDir, { role: "tools", peer, projectRoot: root }); cleanup.push(() => c.close()); return c.request({ t: "usage", by: "peer" }); };
  const planner = await asTools("claude");
  expect(planner.ok, JSON.stringify(planner)).toBe(true);
  for (const agent of ["codex", "local"]) {
    const refused = await asTools(agent);
    expect(refused.ok, agent).toBe(false);
    expect(refused.error).toContain("person and a configured planner");
  }
});

test("a query folds what the log gained since the last pass, and a restart resumes from the stored offset without double counting (#683 U2)", async () => {
  const { console_, log, stateDir, root, daemon } = await rig();
  const before = (await console_.request({ t: "usage", by: "peer" })).usage.rows.find((r: any) => r.key === "codex").counted.value;
  appendFileSync(log, ev(20, { type: "tokens", peer: "codex", n: 5, attribution: "unattributed" }));
  const after = (await console_.request({ t: "usage", by: "peer" })).usage.rows.find((r: any) => r.key === "codex").counted.value;
  expect(after).toBe(before + 5);
  await daemon.stop();
  appendFileSync(log, ev(21, { type: "tokens", peer: "codex", n: 7, attribution: "unattributed" }));
  const again = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
  cleanup.push(() => again.stop());
  const c2 = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); cleanup.push(() => c2.close());
  expect((await c2.request({ t: "usage", by: "peer" })).usage.rows.find((r: any) => r.key === "codex").counted.value).toBe(before + 5 + 7);
});

test("ahub usage is an allowed agent command like report, its three forms are in help, and the parser knows the same ones (#683 U2)", () => {
  for (const args of [[], ["limits"], ["total"], ["--by", "task"]]) expect(classifyPeerCommand("usage", args)).toBe("allowed");
  const forms = HELP.map(entry => entry.usage).filter(usage => usage.startsWith("ahub usage"));
  expect(forms).toHaveLength(3);
  expect(forms.some(f => f.includes("--by peer|task|issue|pr|release|day|model"))).toBe(true);
  expect(forms.some(f => f.startsWith("ahub usage limits"))).toBe(true);
  expect(forms.some(f => f.startsWith("ahub usage total"))).toBe(true);
});
