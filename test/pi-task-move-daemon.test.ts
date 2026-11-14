import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiPeer } from "../src/adapters/pi.ts";
import { Board } from "../src/hub/board.ts";
import type { BusOptions } from "../src/hub/bus.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { gitProject } from "./fakes/git-project.ts";

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}

async function currentState(ready: () => boolean, label: string) {
  const deadline = performance.now() + 5_000;
  while (!ready() && performance.now() < deadline) await Bun.sleep(10);
  expect(ready(), label).toBe(true);
}

test("a real task escalation while Pi chat is queued puts the withdrawal in the next actual native prompt (#1447 T4)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-pi-move-daemon-"))), stateDir = join(root, "state");
  const condensing = barrier(), releaseCondense = barrier(), delivered = barrier();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, other: ControlClient | undefined, board: Board | undefined;
  let restoreCondense: (() => void) | undefined;
  try {
    gitProject(root); mkdirSync(join(root, ".agenthub"));
    const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8");
    const escalation = 'escalate_to = ["codex", "kimi", "claude"]';
    expect(routing).toContain(escalation);
    writeFileSync(join(root, ".agenthub", "routing.toml"), routing.replace(escalation, 'escalate_to = ["other"]'));
    daemon = await startDaemon({ cwd: root, stateDir, projectId: "pi-task-move-fixture", instanceId: "pi-task-move-instance",
      controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, sdlc: sdlcConfig(undefined), memorySyncTrigger: () => {},
      config: { ...DEFAULT_CONFIG, batch_ms: 0, start: { agents: [] },
        roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, local: false, pi: true },
        roles: { pi: ["implementer"], other: ["implementer", "reviewer"] },
        pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")] },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
        inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
        mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] },
        task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
    const running = daemon;
    person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    // Like daemon-context fixtures, this attached legacy external WS peer is absent
    // from roster declarations; explicit unknown roster keys are intentionally refused.
    other = await ControlClient.connect(stateDir, { role: "peer", peer: "other", projectRoot: root });
    await currentState(() => running.bus.stateOf("other") === "idle", "the attached fixture recipient is ready for real assignment");
    const started = await person.request({ t: "start", peer: "pi", args: { mode: "headless", backend: "dgx" } });
    expect(started.ok === true, String(started.error ?? "")).toBe(true);
    const pi = running.bus.peers.get("pi");
    if (!(pi instanceof PiPeer)) throw new Error("fixture requires the real Pi adapter with its existing native fake");
    await currentState(() => pi.state === "idle", "the existing fake Pi completed native startup");

    // Seed an already accepted task; escalation itself uses the real console, Tasks and routing.
    board = new Board(join(stateDir, "hub.db"));
    const task = board.propose("user", { title: "Pi task-move delivery fixture", class: "implement" });
    board.update(task.id, "pi", "accepted", { owner: "pi", reviewer: "user", state: "in_progress" });
    const prompts: string[] = [], steers: string[] = [];
    const transport = pi as unknown as { sendRpc(command: Record<string, unknown>): Promise<unknown> };
    const sendRpc = transport.sendRpc.bind(pi);
    transport.sendRpc = command => {
      if (command.type === "prompt") prompts.push(String(command.message));
      if (command.type === "steer") steers.push(String(command.message));
      return sendRpc(command);
    };
    const nativeDeliver = pi.deliver.bind(pi);
    pi.deliver = async (envs, deliveryId) => { await nativeDeliver(envs, deliveryId); delivered.release(); };
    const options = (running.bus as unknown as { opts: Partial<BusOptions> }).opts, priorCondense = options.condense;
    let first = true;
    options.condense = async envs => {
      if (first) { first = false; condensing.release(); await releaseCondense.reached; }
      return envs;
    };
    restoreCondense = () => { options.condense = priorCondense; };
    const chat = newEnvelope("user", "QUEUED_PI_CHAT_BEFORE_TASK_MOVE", { to: ["pi"], refs: { task: String(task.id) } });
    expect(running.bus.publish(chat)).toContain("pi");
    await condensing.reached;
    expect(pi.state).toBe("idle"); expect(prompts).toEqual([]);
    // The console/CLI form invokes Tasks.escalate; no task-flow method is replaced or spied.
    const moved = await person.request({ t: "task", op: "task_escalate", args: { id: task.id } });
    expect(moved.ok === true, String(moved.error ?? "")).toBe(true);
    expect(board.get(task.id)?.owner).toBe("other");
    const withdrawal = running.bus.pendingEnvelopes("pi").find(env => env.from === HUB && env.kind === "task"
      && env.refs?.task === String(task.id) && env.body.includes("moved to other") && env.body.includes("Stop working on it."));
    expect(withdrawal, "real Tasks.escalate published the former owner's pending withdrawal").toBeDefined();
    expect(withdrawal?.priority).toBe("important");
    expect(prompts).toEqual([]); expect(running.bus.attemptState()).toEqual({});
    releaseCondense.release(); await delivered.reached;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(withdrawal!.body);
    expect(prompts[0]).toContain(chat.body);
    expect(prompts[0]!.indexOf(withdrawal!.body)).toBeLessThan(prompts[0]!.indexOf(chat.body));
    expect(steers).toEqual([]);
    expect(running.bus.queueIds("pi")).not.toContain(withdrawal!.id);
    expect(running.bus.attemptState()).toEqual({});
    expect(board.get(task.id)?.owner).toBe("other");
  } finally {
    releaseCondense.release(); restoreCondense?.();
    try { await daemon?.stop(); }
    finally { person?.close(); other?.close(); board?.close(); rmSync(root, { recursive: true, force: true }); }
  }
}, 30_000);
