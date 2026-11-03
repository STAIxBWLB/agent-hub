import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER } from "../src/hub/envelope.ts";
import { Board } from "../src/hub/board.ts";
import { ControlWriteTelemetry, controlWriteMetadata, controlWriteSpan } from "../src/hub/control-write-trace.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { renderStatus } from "../src/cli/output.ts";
import { paint } from "../src/cli/console-state.ts";

test("control admission precedes argument traversal and both privacy screens", async () => {
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const from = source.indexOf("  function onControlMessage(");
  const to = source.indexOf("  function onMessage(", from);
  expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(from, to));
  let traversals = 0, screens = 0, dispatches = 0;
  const telemetry = new ControlWriteTelemetry({ emit: () => {} });
  const handler = new Function("controlWriteMetadata", "controlWriteTelemetry", "controlWritePrivacyGuard", "controlWriteSpan", "tasks", "boundedSafe", "onMessage",
    `${body}\nreturn onControlMessage;`)(controlWriteMetadata, telemetry, () => () => true, controlWriteSpan,
    { publicMetadataText: () => { screens++; return true; } }, () => { screens++; return true; },
    (_socket: unknown, _message: unknown, finish?: () => void) => { dispatches++; finish?.(); });
  const message = { t: "task", op: "hub_task_propose", get args() { traversals++; return { title: "synthetic input" }; } };
  handler({ data: { authed: false } }, message);
  expect([dispatches, traversals, screens]).toEqual([1, 0, 0]);
  expect(telemetry.status().active).toBe(0);
  handler({ data: { authed: true, role: "console" } }, message);
  await Promise.resolve();
  expect([dispatches, traversals, screens]).toEqual([2, 1, 2]);
});

test("an unauthenticated control write keeps its existing wire refusal", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-control-auth-timing-"))), stateDir = join(root, "state");
  const config = { ...DEFAULT_CONFIG,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
    inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
    mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
    research: { ...DEFAULT_CONFIG.research, enabled: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
    specs: { ...DEFAULT_CONFIG.specs, enabled: false },
  };
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config, configWatch: false });
  let socket: WebSocket | undefined;
  try {
    const code = await new Promise<number>((resolve, reject) => {
      socket = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
      socket.onopen = () => socket!.send(JSON.stringify({ t: "task", rid: 1, op: "hub_task_propose", args: { title: "synthetic unauthenticated input" } }));
      socket.onclose = event => resolve(event.code);
      socket.onerror = () => reject(new Error("fixture control socket failed"));
      socket.onmessage = () => { resolve(0); socket!.close(); };
    });
    expect(code).toBe(4401);
    expect(readFileSync(join(stateDir, "hub.log"), "utf8")).not.toContain('"kind":"hub_task_propose"');
  } finally { socket?.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
});

// The real SQL callback and control transport are used; the only injected fault is a blocked loop.
for (const mode of ["public", "public-quiet", "private", "private-string"] as const) test(mode === "public" ? "a blocked board write keeps its result and logs bounded phase metadata after the loop resumes" : mode === "public-quiet" ? "client timing is quiet by default while daemon spans still name a late block" : `a blocked ${mode} review suppresses daemon phase metadata after the task closes`, async () => {
  const privateTask = mode === "private" || mode === "private-string";
  const timingEnabled = mode !== "public-quiet";
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-control-timing-"))), stateDir = join(root, "state");
  const config = { ...DEFAULT_CONFIG,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
    inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
    mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
    research: { ...DEFAULT_CONFIG.research, enabled: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
    specs: { ...DEFAULT_CONFIG.specs, enabled: false },
  };
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config, configWatch: false });
  let client: ControlClient | undefined;
  const prototype = Board.prototype as unknown as { taskWrite<T extends { changes: number }>(write: () => T): T };
  const original = prototype.taskWrite;
  const stderr = console.error, clientLines: string[] = [];
  const timingEnv = process.env.AHUB_CONTROL_WRITE_TIMING;
  let blocked = false;
  try {
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    if (timingEnabled) process.env.AHUB_CONTROL_WRITE_TIMING = "1";
    else delete process.env.AHUB_CONTROL_WRITE_TIMING;
    const marker = "timing-private-input-not-for-logs";
    let privateId: number | undefined;
    if (privateTask) {
      const seed = new Board(join(stateDir, "hub.db"));
      try {
        privateId = seed.propose(USER, { title: marker, class: "implement", signals: ["pii"] }).id;
        seed.update(privateId, USER, "accepted", { owner: "local", reviewer: USER, state: "in_progress" });
        seed.update(privateId, "local", "done", { state: "in_review" });
      } finally { seed.close(); }
    }
    prototype.taskWrite = function<T extends { changes: number }>(this: Board, write: () => T): T {
      return original.call(this, () => {
        if (!blocked) {
          blocked = true;
          for (let index = 0; index < 40; index++) controlWriteSpan("status-hook", () => {});
          controlWriteSpan("memory", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1600));
        }
        return write();
      }) as T;
    };
    console.error = (...items: unknown[]) => { clientLines.push(items.map(String).join(" ")); };
    const reply = privateTask
      ? await client.request({ t: "task", op: "hub_review", args: { id: mode === "private-string" ? String(privateId) : privateId, verdict: "approved", note: marker } })
      : await client.request({ t: "task", op: "hub_task_propose", args: { title: marker, detail: marker, class: "implement", backlog: true } });
    prototype.taskWrite = original;
    expect(blocked).toBe(true); expect(reply.ok).toBe(true);
    await Bun.sleep(250); // Consume the first delayed probe tick, never poll the daemon.
    const status = await client.request({ t: "status" });
    if (!privateTask) expect(status.status.controlWriteTiming.slowRequests).toBeGreaterThanOrEqual(1);
    expect(status.status.controlWriteTiming.blockedLoopSamples).toBeGreaterThanOrEqual(1);
    const log = readFileSync(join(stateDir, "hub.log"), "utf8");
    const records = log.split("\n").flatMap(line => {
      const start = line.indexOf("{"); if (start < 0) return [];
      try { const value = JSON.parse(line.slice(start)); return value.type === "control_write_slow" || value.type === "control_write_loop_delay" ? [value] : []; } catch { return []; }
    });
    if (privateTask) {
      expect(records.filter(record => record.kind === "hub_review")).toHaveLength(0);
      expect(records.some(record => record.type === "control_write_loop_delay" && record.spans.some((span: { kind: string }) => span.kind === "hub_review"))).toBe(false);
    } else {
      const slow = records.find(record => record.type === "control_write_slow" && record.kind === "hub_task_propose");
      expect(slow).toBeDefined();
      expect(slow.phases.some((phase: { phase: string }) => phase.phase === "board-write")).toBe(true);
      expect(slow.phases.some((phase: { phase: string }) => phase.phase === "memory")).toBe(true);
      const lag = records.find(record => record.type === "control_write_loop_delay" && record.spans.some((span: { phase: string }) => span.phase === "board-write"));
      expect(lag).toBeDefined();
      expect(lag.spans.some((span: { phase: string }) => span.phase === "memory")).toBe(true);
    }
    expect(JSON.stringify(records)).not.toContain(marker);
    expect(JSON.stringify(records)).not.toContain(root);
    expect(JSON.stringify(records)).not.toContain("requestId");
    if (timingEnabled) expect(clientLines.join("\n")).toContain("client-wait");
    else expect(clientLines.some(line => line.includes('"type":"control_write_slow"'))).toBe(false);
    expect(clientLines.join("\n")).not.toContain(marker);
    expect(clientLines.join("\n")).not.toContain('"task":');
  } finally {
    prototype.taskWrite = original; console.error = stderr;
    if (timingEnv === undefined) delete process.env.AHUB_CONTROL_WRITE_TIMING;
    else process.env.AHUB_CONTROL_WRITE_TIMING = timingEnv;
    client?.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true });
  }
});

test("full status shows aggregate timing counters while ordinary and older status stay quiet", () => {
  const counters = { active: 0, slowRequests: 2, blockedLoopSamples: 1, droppedActive: 0, droppedRecent: 1000, droppedLogs: 3, expiredRequests: 2 };
  const text = (full: boolean, timing = true) => renderStatus({ peers: {}, ...(timing ? { controlWriteTiming: counters } : {}) }, 140, 0, full).map(line => paint(line, false)).join("\n");
  expect(text(true)).toContain("control writes: active 0, slow 2, loop delays 1, dropped 3");
  expect(text(true)).toContain("dropped 3, expired 2");
  expect(text(false)).not.toContain("control writes:");
  expect(text(true, false)).not.toContain("control writes:");
});
