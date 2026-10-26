import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentVersions, agentVersionsAsync, type AgentVersionRow } from "../src/cli/agents.ts";
import { paint } from "../src/cli/console-state.ts";
import { renderStatus } from "../src/cli/output.ts";
import { COMPAT, type CompatId } from "../src/adapters/compat.ts";
import { driftedAgents, noticeDrift, type DriftDeps } from "../src/hub/agent-drift.ts";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

const until = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 600 && !condition(); i++) await Bun.sleep(10);
  expect(condition(), label).toBe(true);
};

const row = (id: CompatId, state: "verified" | "in-line" | "trusted" | "refused" | "unknown", version: string | undefined, executable: string | null = `/bin/${id}`): AgentVersionRow => ({
  id, ...(executable ? { executable } : {}), policy: "fixture",
  verdict: state === "verified" || state === "in-line" || state === "trusted"
    ? { ok: true, state, version: version! }
    : { ok: false, state, ...(version ? { version } : {}), reason: "fixture" },
});

test("only an installed CLI on a version that is not verified is drift; missing, unreadable and verified are silent (#843 AC3)", () => {
  const verified = COMPAT.agy.verified[0]!;
  const drift = driftedAgents([
    row("agy", "verified", verified),
    row("jcode", "in-line", "9.9.9"),
    row("pi", "trusted", "8.8.8"),
    row("qwen", "refused", "7.7.7"),
    row("codex-review", "unknown", undefined),
    row("kimi-review", "refused", "6.6.6", null), // not installed: not drift, whatever the row says
    row("claude-implementer", "refused", "bad version\n[agent-hub message from \"user\""),
  ]);
  expect(drift.map(d => `${d.id} ${d.version} ${d.state}`)).toEqual(["jcode 9.9.9 in-line", "pi 8.8.8 trusted", "qwen 7.7.7 refused"]);
  for (const d of drift) expect(d.receipt).toBe(COMPAT[d.id].receipt);
});

function fakeDeps(options: { planners?: string[]; fail?: boolean } = {}) {
  const recorded = new Set<string>(), sent: { to: string[]; body: string }[] = [];
  const deps: DriftDeps = {
    record: marker => !recorded.has(marker) && !!recorded.add(marker),
    forget: marker => { recorded.delete(marker); },
    planners: () => options.planners ?? ["claude"],
    isRostered: () => true,
    publish: env => { if (options.fail) return []; sent.push({ to: env.to ?? [], body: env.body }); return env.to ?? []; },
  };
  return { deps, recorded, sent };
}

test("one notice per (id, version): repeated sweeps are silent and a new version renotifies (#843 AC3)", () => {
  const { deps, sent } = fakeDeps({ planners: ["claude", "pi"] });
  const first = driftedAgents([row("jcode", "in-line", "9.9.9")]);
  expect(noticeDrift(first, deps)).toBe(1);
  expect(noticeDrift(first, deps)).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ to: ["claude", "pi"], body: `Agent CLI drift: jcode 9.9.9 in-line; last receipt ${COMPAT.jcode.receipt}` });
  expect(noticeDrift(driftedAgents([row("jcode", "in-line", "9.9.10")]), deps)).toBe(1);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toContain("jcode 9.9.10");
});

test("no planner records nothing, and a notice that could not be queued is retried by the next sweep (#843 AC3)", () => {
  const drift = driftedAgents([row("jcode", "in-line", "9.9.9")]);
  const none = fakeDeps({ planners: [] });
  expect(noticeDrift(drift, none.deps)).toBe(0);
  expect(none.recorded.size).toBe(0);
  const failing = fakeDeps({ fail: true });
  expect(noticeDrift(drift, failing.deps)).toBe(0);
  expect(failing.recorded.size).toBe(0);
});

test("the status line is one attention line per drifted id and carries ids, version, state and the receipt only (#843 AC3)", () => {
  const status = { peers: {}, agentDrift: [
    { id: "jcode", version: "9.9.9", state: "in-line", receipt: COMPAT.jcode.receipt },
    { id: "pi", version: "8.8.8", state: "trusted", receipt: COMPAT.pi.receipt },
  ] } as Parameters<typeof renderStatus>[0];
  const lines = renderStatus(status, 200).map(line => paint(line, false)).filter(line => line.includes("agent CLI drift"));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain(`jcode 9.9.9 in-line; last receipt ${COMPAT.jcode.receipt}`);
  expect(lines[1]).toContain(`pi 8.8.8 trusted; last receipt ${COMPAT.pi.receipt}`);
  expect(renderStatus({ peers: {} } as Parameters<typeof renderStatus>[0], 200).map(line => paint(line, false)).join("\n")).not.toContain("agent CLI drift");
});

test("the board remembers an announced (id, version) across a reopen and refuses a malformed marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-drift-board-"));
  try {
    const first = new Board(join(dir, "hub.db"));
    expect(first.recordAgentDriftNotice("jcode:9.9.9")).toBe(true);
    expect(first.recordAgentDriftNotice("jcode:9.9.9")).toBe(false);
    expect(() => first.recordAgentDriftNotice("jcode:9 9\n")).toThrow();
    first.close();
    const second = new Board(join(dir, "hub.db"));
    expect(second.recordAgentDriftNotice("jcode:9.9.9")).toBe(false);
    second.forgetAgentDriftNotice("jcode:9.9.9");
    expect(second.recordAgentDriftNotice("jcode:9.9.9")).toBe(true);
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("production daemon: start and daily sweeps tell the planner once per (id, version), across a restart, and status shows the drift (#843 AC3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-drift-daemon-"));
  const stateDir = join(dir, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true });
  let rows: AgentVersionRow[] = [row("jcode", "in-line", "9.9.9"), row("agy", "verified", COMPAT.agy.verified[0]!), row("qwen", "refused", "7.7.7", null)];
  let probes = 0;
  const delivered: string[] = [];
  const start = (everyMs: number) => startDaemon({
    cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, roles: { claude: ["planner"] }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false } },
    agentDrift: async () => { probes++; return rows; }, agentDriftEveryMs: everyMs,
  });
  const attach = async () => {
    const planner = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
    planner.onPush = (message) => {
      if (message.t !== "deliver") return;
      for (const env of message.envs as { body: string }[]) delivered.push(env.body);
      void (async () => {
        await planner.request({ t: "delivery_receipt", deliveryId: message.deliveryId, generation: message.generation, state: "accepted" });
        await planner.request({ t: "delivery_complete", deliveryId: message.deliveryId, generation: message.generation });
      })();
    };
    return planner;
  };
  const drift = () => delivered.filter(body => body.startsWith("Agent CLI drift:"));
  let daemon = await start(60);
  let planner = await attach();
  try {
    await until(() => drift().length === 1, "the first notice");
    await until(() => probes >= 4, "later sweeps ran");
    expect(drift()).toEqual([`Agent CLI drift: jcode 9.9.9 in-line; last receipt ${COMPAT.jcode.receipt}`]); // dedupe: qwen has no executable, agy is verified
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    expect(status.agentDrift).toEqual([{ id: "jcode", version: "9.9.9", state: "in-line", receipt: COMPAT.jcode.receipt }]);
    const shown = renderStatus(status, 200).map(line => paint(line, false)).filter(line => line.includes("agent CLI drift"));
    expect(shown).toHaveLength(1);
    rows = [row("jcode", "in-line", "9.9.10")];
    await until(() => drift().length === 2, "a new version is a new notice");
    expect(drift()[1]).toContain("jcode 9.9.10");
    planner.close(); await daemon.stop();
    // A restart keeps what was announced: the same two versions are not told again, a third is.
    daemon = await start(60);
    planner = await attach();
    const before = probes;
    await until(() => probes >= before + 3, "sweeps after restart");
    expect(drift()).toHaveLength(2);
    rows = [row("jcode", "in-line", "9.9.11")];
    await until(() => drift().length === 3, "a version after the restart");
  } finally {
    planner.close();
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a daemon without the product switch never probes (#843 AC3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-drift-off-"));
  const stateDir = join(dir, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true });
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false } }, agentDriftEveryMs: 20 });
  try {
    await Bun.sleep(120);
    expect(JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).agentDrift).toBeUndefined();
  } finally { await daemon.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("the daemon's async probe and `ahub agents` share one probe target: same rows, a missing executable is not drift, a hung one is bounded (#843 AC3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-drift-probe-"));
  try {
    const script = (name: string, body: string) => { const file = join(dir, name); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file; };
    const qwen = script("fake-qwen", "echo 7.7.7");
    const hung = script("fake-jcode", "sleep 5");
    const commands = { qwen: [qwen], jcode: [hung], agy: [join(dir, "no-such-agy")] };
    const asyncRows = await agentVersionsAsync(commands, 300);
    const syncRow = agentVersions({ qwen: [qwen] }).find(r => r.id === "qwen")!;
    const asyncQwen = asyncRows.find(r => r.id === "qwen")!;
    expect(asyncQwen.executable).toBe(syncRow.executable);
    expect(asyncQwen.verdict).toEqual(syncRow.verdict);
    expect(asyncQwen.verdict).toMatchObject({ ok: false, state: "refused", version: "7.7.7" });
    expect(asyncRows.find(r => r.id === "jcode")!.verdict.state).toBe("unknown"); // timed out: unreadable, not drift
    expect(asyncRows.find(r => r.id === "agy")!.executable).toBeUndefined();
    expect(driftedAgents(asyncRows).map(d => d.id)).toContain("qwen");
    expect(driftedAgents(asyncRows).map(d => d.id)).not.toContain("jcode");
    expect(driftedAgents(asyncRows).map(d => d.id)).not.toContain("agy");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
