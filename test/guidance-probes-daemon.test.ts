import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { parseRole, taskRoleText } from "../src/hub/roles.ts";
import { probeHash, type ProbeRegistrationV1 } from "../src/hub/guidance-probes.ts";
import { GuidanceProbeStore } from "../src/hub/guidance-probe-store.ts";
import vectors from "./fixtures/guidance-variant-v1.json";
import { guidanceProbeFixture, guidanceProbeFixtureKey } from "./fakes/guidance-probe-provider.ts";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("daemon returns fixed probe refusals with every request rid, including production runner refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-guidance-probe-daemon-")), stateDir = join(root, "state"), home = join(root, "home");
  const previousHome = process.env.HOME;
  mkdirSync(stateDir); mkdirSync(join(home, "kimi"), { recursive: true }); mkdirSync(join(root, ".agenthub/roles"), { recursive: true });
  writeFileSync(join(root, ".agenthub/roles/test-engineer.md"), vectors.baseline);
  process.env.HOME = home;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined;
  cleanups.push(async () => {
    try { person?.close(); await daemon?.stop(); }
    finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); }
  });

  const board = new Board(join(stateDir, "hub.db"));
  const task = board.propose("user", { title: "Public probe refusal fixture", class: "implement", role: "test-engineer" });
  board.update(task.id, "user", "accepted", { owner: "user", state: "in_progress" });
  const currentTask = board.get(task.id)!;
  board.close();

  const config: HubConfig = { ...DEFAULT_CONFIG, roster: {}, start: { agents: [] }, batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { urls: [], access_hosts: [] },
    pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
    approvals: { ...DEFAULT_CONFIG.approvals, notify: false } };
  daemon = await startDaemon({ cwd: root, stateDir, instanceId: "guidance-probe-refusal-fixture", kimiHome: join(home, "kimi"), config,
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, memorySyncTrigger: () => {} });
  person = await ControlClient.connect(stateDir, { role: "console" });
  const expectRefusal = async (request: Record<string, unknown>, cause: string) => {
    const reply = await person!.request(request);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain(cause);
    expect(Number.isSafeInteger(reply.rid)).toBe(true);
    return reply;
  };

  await expectRefusal({ t: "guidance_probe_show", id: "malformed" }, "guidance probe id is invalid");
  await expectRefusal({ t: "guidance_probe_show", id: "f".repeat(64) }, "guidance probe is unavailable");
  await expectRefusal({ t: "guidance_probe_register", registration: {} }, "guidance probe declaration is invalid or oversized");

  const lineage = await person.request({ t: "lineage_show", taskId: task.id });
  expect(lineage.ok).toBe(true);
  const taskRef = lineage.lineage.nodes.find((entry: { ref: { tool: string; kind: string } }) => entry.ref.tool === "ahub" && entry.ref.kind === "task");
  if (!taskRef) throw new Error("expected project task lineage");
  const role = parseRole(vectors.baseline, "test-engineer", "project");
  const value: ProbeRegistrationV1 = guidanceProbeFixture().registration;
  value.manifest.projectKey = taskRef.ref.projectKey;
  value.manifest.task = { id: currentTask.id, created: currentTask.created, flowRevision: currentTask.history.length };
  value.manifest.role = { id: role.id, layer: "project", baselineSha256: role.hash };
  value.manifest.guidance.baselineSha256 = probeHash(taskRoleText(role));
  const registered = await person.request({ t: "guidance_probe_register", registration: value });
  expect(registered.ok === true, String(registered.error ?? "expected a registration receipt")).toBe(true);
  expect(Number.isSafeInteger(registered.rid)).toBe(true);
  await expectRefusal({ t: "guidance_probe_start", id: registered.receipt.id, revision: registered.receipt.revision },
    "guidance probe runner is unavailable in production T1");
});

const quietConfig = (): HubConfig => ({ ...DEFAULT_CONFIG, roster: {}, start: { agents: [] }, batch_ms: 0,
  memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
  mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { urls: [], access_hosts: [] },
  pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
  snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
  approvals: { ...DEFAULT_CONFIG.approvals, notify: false } });

// #1226 T3: the explicit host call. A session a dead process left `reserved` is recorded as unknown (never launched, retried or succeeded) when the daemon starts.
test("daemon start reconciles a probe session left reserved by a crashed process into an unknown receipt, once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-guidance-probe-reconcile-")), stateDir = join(root, "state"), home = join(root, "home");
  const previousHome = process.env.HOME;
  mkdirSync(stateDir); mkdirSync(join(home, "kimi"), { recursive: true });
  process.env.HOME = home;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  cleanups.push(async () => {
    try { await daemon?.stop(); }
    finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); }
  });
  const dbFile = join(stateDir, "hub.db");
  // The previous process: registered an experiment, reserved its baseline session, and died before settling it.
  const source = guidanceProbeFixture(), key = guidanceProbeFixtureKey(source.registration);
  const seed = new GuidanceProbeStore(dbFile, () => 1000);
  seed.register(source.registration, source.host, () => source.host);
  const reserved = seed.reserveSession({ key, expectedRevision: 0, host: source.host, now: 1000 }, () => ({ host: source.host }));
  if (reserved.kind !== "granted") throw new Error("expected a reservation");
  expect(seed.receipts(key)).toEqual([]);
  expect(seed.read(key)!.sessions[0]!.state).toBe("reserved");
  seed.close();

  daemon = await startDaemon({ cwd: root, stateDir, instanceId: "guidance-probe-reconcile-fixture", kimiHome: join(home, "kimi"), config: quietConfig(),
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, memorySyncTrigger: () => {} });

  const reader = new GuidanceProbeStore(dbFile, () => 2000, true);
  try {
    const state = reader.read(key)!;
    expect(state.sessions[0]!.state).toBe("unknown_held");
    expect(state.receipt.state).toBe("unknown_held");
    const [sealed] = reader.receipts(key);
    expect(sealed).toMatchObject({ slotId: "baseline", state: "unknown", servedModel: null });
    expect(sealed!.limits).toContain("teardown_unverified");
    expect(reader.outcome(key)!.counts).toMatchObject({ unknown: 1, failed: 0, succeeded: 0 });
    // Nothing was launched or retried: the attempt counter is the one the dead process left.
    expect(state.counters.workerAttempts).toBe(1);
  } finally { reader.close(); }
  expect(readFileSync(join(stateDir, "hub.log"), "utf8")).toContain("guidance probe reconcile: 1 session left by a previous process recorded as unknown");
});

test("daemon start reconciles nothing when no session was left open, and writes no probe row", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-guidance-probe-reconcile-none-")), stateDir = join(root, "state"), home = join(root, "home");
  const previousHome = process.env.HOME;
  mkdirSync(stateDir); mkdirSync(join(home, "kimi"), { recursive: true });
  process.env.HOME = home;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  cleanups.push(async () => {
    try { await daemon?.stop(); }
    finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); }
  });
  const dbFile = join(stateDir, "hub.db"), source = guidanceProbeFixture(), key = guidanceProbeFixtureKey(source.registration);
  const seed = new GuidanceProbeStore(dbFile, () => 1000);
  seed.register(source.registration, source.host, () => source.host);
  const before = seed.integrity().digest;
  seed.close();
  daemon = await startDaemon({ cwd: root, stateDir, instanceId: "guidance-probe-reconcile-none", kimiHome: join(home, "kimi"), config: quietConfig(),
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, memorySyncTrigger: () => {} });
  const reader = new GuidanceProbeStore(dbFile, () => 2000, true);
  try { expect(reader.integrity().digest).toBe(before); expect(reader.receipts(key)).toEqual([]); } finally { reader.close(); }
  expect(readFileSync(join(stateDir, "hub.log"), "utf8")).not.toContain("guidance probe reconcile");
});
