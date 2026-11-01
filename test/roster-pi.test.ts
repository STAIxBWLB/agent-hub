import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { newEnvelope, USER } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { rosterPiFixture } from "./fakes/pi-roster-tui.ts";
import { Bus } from "../src/hub/bus.ts";

for (const idle of [true, false]) test(`daemon Pi roster removal preserves its personal owner and return verifies ${idle ? "idle" : "busy"} before dispatch (#315)`, async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-pi-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "roster-pi-project", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, roster: { pi: true }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
  const client = await ControlClient.connect(stateDir, { role: "console" });
  const f = await rosterPiFixture(undefined, { cwd: root, stateDir });
  const delivered: string[] = [];
  const originalDelivered = daemon.bus.onDelivered;
  daemon.bus.onDelivered = (peer, originals) => { originalDelivered?.(peer, originals); if (peer === "pi") delivered.push(...originals.map(env => env.id)); };
  daemon.bus.add(f.peer);
  try {
    daemon.bus.pause("pi");
    const original = newEnvelope(USER, "original Pi queued work", { to: ["pi"] }); daemon.bus.publish(original);
    expect(daemon.bus.queued("pi")).toBe(1);
    const bridge = f.peer.tuiLaunch, signature = processSignature(f.owner.pid), metadata = f.peer.recoveryMetadata();
    expect(signature).toBeDefined();
    expect(await client.request({ t: "settings_set", key: "roster.pi", value: false, confirm: "pi" })).toMatchObject({ ok: true });
    expect((await client.request({ t: "status" })).status.peers.pi).toMatchObject({ state: "offline", rostered: false, queued: 1 });
    expect(f.peer.acceptingTools).toBe(false); expect(f.peer.tuiLaunch).toBe(bridge);
    expect(processSignature(f.owner.pid)).toBe(signature); expect(f.peer.recoveryMetadata()).toEqual(metadata);
    expect((f.peer as any).tuiQueue).toEqual([]); // no shutdown or replacement launch
    const offTool = await f.post("/tool", { name: "write", toolCallId: "off", sessionId: f.sessionId, generation: 0 });
    expect(offTool.status).toBe(409); expect((await offTool.json() as any).text).toContain("off roster");
    expect(await client.request({ t: "send", to: ["pi"], body: "refused off work" })).toMatchObject({ ok: false, error: "off roster: pi" });
    expect(daemon.bus.queueList("pi").flatMap(row => row.originals.map(env => env.id))).toContain(original.id);
    const adding = client.request({ t: "settings_set", key: "roster.pi", value: true });
    // A consumed control request proves the settings handler reached its awaited snapshot.
    await client.request({ t: "status" });
    expect((f.peer as any).tuiQueue.map((command: any) => command.type)).toEqual(["get_session_state"]);
    const snapshot = await f.next(); expect(snapshot.type).toBe("get_session_state");
    for (const message of [{ t: "start", peer: "pi", args: { mode: "headless" } }, { t: "peer_stop", peer: "pi" }, { t: "permission", peer: "pi", mode: "ask" }]) expect(await client.request(message)).toMatchObject({ ok: false, error: "pi roster change is in progress" });
    const expectedInstanceId = (await client.request({ t: "status" })).status.instanceId;
    expect(await client.request({ t: "recovery", op: "prepare", operationId: "blocked-roster-transition", expectedInstanceId })).toMatchObject({ ok: false, error: "roster change is in progress; wait for ahub status before preparing recovery" });
    expect(f.peer.tuiLaunch).toBe(bridge); expect(processSignature(f.owner.pid)).toBe(signature);
    await f.ack(snapshot, { sessionId: f.sessionId, sessionFile: f.sessionFile, idle });
    expect(await adding).toMatchObject({ ok: true });
    expect(f.peer.tuiLaunch).toBe(bridge); expect(processSignature(f.owner.pid)).toBe(signature);
    expect(f.peer.state).toBe(idle ? "idle" : "busy");
    expect(daemon.bus.stateOf("pi")).toBe("paused"); expect(daemon.bus.queued("pi")).toBe(1);
    expect(delivered).toEqual([]); expect((f.peer as any).tuiQueue).toEqual([]);
    daemon.bus.resume("pi");
    if (!idle) {
      await client.request({ t: "status" });
      expect(daemon.bus.queued("pi")).toBe(1); expect(delivered).toEqual([]); expect((f.peer as any).tuiQueue).toEqual([]);
      await f.post("/event", { type: "agent_settled", text: "personal answer" });
    }
    const prompt = await f.next(); expect(prompt.type).toBe("prompt"); expect(prompt.message).toContain(original.body);
    await f.ack(prompt);
    await f.post("/event", { type: "agent_start", generation: 1 });
    await f.post("/event", { type: "agent_settled", generation: 1, text: "hub answer" });
    await client.request({ t: "status" });
    expect(delivered.filter(id => id === original.id)).toHaveLength(1);
    expect(daemon.bus.queued("pi")).toBe(0); expect(f.peer.state).toBe("idle"); expect((f.peer as any).tuiQueue).toEqual([]);
  } finally {
    client.close(); await f.cleanup(); await daemon.stop(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
});

test("Pi roster verification serializes roster writes and holds dispatch through its idle replay (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-pi-fence-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true }); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "roster-pi-fence", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, roster: { pi: true }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
  const client = await ControlClient.connect(stateDir, { role: "console" }), f = await rosterPiFixture(undefined, { cwd: root, stateDir });
  const attempted: string[] = [], delivered: string[] = [];
  const onDeliver = daemon.bus.onDeliver, onDelivered = daemon.bus.onDelivered;
  daemon.bus.onDeliver = (peer, originals) => { onDeliver?.(peer, originals); if (peer === "pi") attempted.push(...originals.map(env => env.id)); };
  daemon.bus.onDelivered = (peer, originals) => { onDelivered?.(peer, originals); if (peer === "pi") delivered.push(...originals.map(env => env.id)); };
  daemon.bus.add(f.peer);
  try {
    daemon.bus.pause("pi");
    expect(await client.request({ t: "settings_set", key: "roster.pi", value: false, confirm: "pi" })).toMatchObject({ ok: true });
    const adding = client.request({ t: "settings_set", key: "roster.pi", value: true });
    void adding.catch(() => undefined); // attach the teardown rejection handler before any assertion can fail
    await client.request({ t: "status" });
    const snapshot = await f.next(); expect(snapshot.type).toBe("get_session_state");
    expect(daemon.bus.isRostered("pi")).toBe(true); expect(f.peer.state).toBe("offline");
    daemon.bus.resume("pi"); // remove the independent pause before the snapshot proof, isolating deliveryHeld
    expect(daemon.bus.stateOf("pi")).toBe("offline");
    const original = newEnvelope(USER, "verification-gated original", { to: ["pi"], priority: "important" });
    expect(await client.request({ t: "send", to: ["pi"], body: original.body, priority: original.priority })).toMatchObject({ ok: true });
    const queued = daemon.bus.queueList("pi").flatMap(row => row.originals).find(env => env.body === original.body)!;
    expect(queued).toBeDefined(); expect(daemon.bus.queued("pi")).toBe(1);
    expect(attempted).toEqual([]); expect(delivered).toEqual([]); expect((f.peer as any).tuiQueue).toEqual([]);
    expect(daemon.bus.queueList("pi").every(row => row.state === "queued")).toBe(true);
    expect(await client.request({ t: "settings_set", key: "roster.kimi", value: false, confirm: "kimi" })).toMatchObject({ ok: false, error: "roster change for pi is in progress" });
    expect(daemon.bus.isRostered("kimi")).toBe(true);
    // Preserve and execute the real bus callback, then observe the synchronous idle replay.
    // Important work avoids the condensation await, so a missing transient fence starts it here.
    const onState = f.peer.onState;
    let replay: { state: string; queued: number; attempted: string[]; states: string[] } | undefined;
    f.peer.onState = state => {
      onState?.(state);
      if (state === "idle" && replay === undefined) replay = { state: f.peer.state, queued: daemon.bus.queued("pi"), attempted: [...attempted], states: daemon.bus.queueList("pi").map(row => row.state) };
    };
    await f.ack(snapshot, { sessionId: f.sessionId, sessionFile: f.sessionFile, idle: true });
    expect(await adding).toMatchObject({ ok: true });
    expect(replay).toEqual({ state: "idle", queued: 1, attempted: [], states: ["queued"] });
    const prompt = await f.next(); expect(prompt.type).toBe("prompt"); expect(prompt.message).toContain(original.body); await f.ack(prompt);
    await f.post("/event", { type: "agent_start", generation: 1 }); await f.post("/event", { type: "agent_settled", generation: 1, text: "completed" });
    await client.request({ t: "status" });
    expect(attempted.filter(id => id === queued.id)).toHaveLength(1); expect(delivered.filter(id => id === queued.id)).toHaveLength(1);
    expect(daemon.bus.queued("pi")).toBe(0); expect((f.peer as any).tuiQueue).toEqual([]);
  } finally {
    client.close(); await f.cleanup(); await daemon.stop(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
});

test("controlled recovery refuses a removed personal Pi owner until the person ends it (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-pi-recovery-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true }); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "roster-pi-recovery", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, roster: { pi: true }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
  const client = await ControlClient.connect(stateDir, { role: "console" }), f = await rosterPiFixture(undefined, { cwd: root, stateDir }); daemon.bus.add(f.peer);
  try {
    const signature = processSignature(f.owner.pid), instance = (await client.request({ t: "status" })).status.instanceId;
    expect((await client.request({ t: "settings_set", key: "roster.pi", value: false, confirm: "pi" })).ok).toBe(true);
    expect(f.peer.state).toBe("offline"); expect(processSignature(f.owner.pid)).toBe(signature);
    const request = { t: "recovery", operationId: "roster-pi-recovery", expectedInstanceId: instance, targetFeatures: DAEMON_FEATURES };
    for (const op of ["prepare", "inspect"]) {
      const reply = await client.request({ ...request, op });
      expect(reply).toMatchObject({ ok: true, recovery: { phase: "preparing", ready: false, blockers: ["pi is not settled; end the retained Pi TUI, then prepare again"] } });
    }
    expect((await client.request({ ...request, op: "commit" })).ok).toBe(false);
    expect((await client.request({ ...request, op: "abort" })).ok).toBe(true);
    f.owner.kill(); await f.owner.exited; await f.post("/event", { type: "session_shutdown" });
    expect(await client.request({ ...request, op: "prepare" })).toMatchObject({ ok: true, recovery: { phase: "prepared", ready: true, blockers: [] } });
    expect((await client.request({ ...request, op: "abort" })).ok).toBe(true);
  } finally {
    client.close(); await f.cleanup(); await daemon.stop(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
});

for (const lifecycle of ["start", "settled", "legacy settled"] as const) test(`Pi roster return rejects a snapshot overtaken by ${lifecycle} and a fresh retry delivers once (#378)`, async () => {
  const f = await rosterPiFixture();
  const bus = new Bus({ batchMs: 0 });
  const messages: string[] = [], delivered: string[] = [];
  bus.add(f.peer); bus.pause("pi");
  f.peer.onMessage = body => messages.push(body);
  bus.onDelivered = (peer, envs) => { if (peer === "pi") delivered.push(...envs.map(env => env.id)); };
  try {
    await f.peer.detachForRoster();
    if (lifecycle !== "start") await f.post("/event", { type: "agent_start", generation: 1 });
    const queued = newEnvelope(USER, "work held through snapshot retry", { to: ["pi"] });
    bus.publish(queued); bus.resume("pi");
    const metadata = f.peer.recoveryMetadata(), signature = processSignature(f.owner.pid);
    const returning = f.peer.resumeFromRoster().catch((error: Error) => error);
    const snapshot = await f.next(); expect(snapshot.type).toBe("get_session_state");
    // The native snapshot was captured before this independently delivered lifecycle event.
    await f.post("/event", lifecycle === "start"
      ? { type: "agent_start", generation: 1 }
      : { type: "agent_settled", ...(lifecycle === "settled" ? { generation: 1 } : {}), text: "personal answer" });
    await f.ack(snapshot, { sessionId: f.sessionId, sessionFile: f.sessionFile, idle: lifecycle === "start" });
    expect(await returning).toBeInstanceOf(Error);
    expect(f.peer.state).toBe("offline"); expect(f.peer.acceptingTools).toBe(false);
    expect(f.peer.recoveryMetadata()).toEqual(metadata); expect(processSignature(f.owner.pid)).toBe(signature);
    expect(f.peer.tuiLaunch).toBe(f.launch); expect(messages).toEqual([]); expect(delivered).toEqual([]);
    expect(bus.queued("pi")).toBe(1); expect((f.peer as any).tuiQueue).toEqual([]);
    expect((await f.post("/tool", { name: "write", toolCallId: "stale-snapshot", sessionId: f.sessionId, generation: 1 })).status).toBe(409);
    // No intervening lifecycle event invalidates this new snapshot.
    await f.resume(lifecycle !== "start");
    if (lifecycle === "start") {
      expect(f.peer.state).toBe("busy"); expect(f.peer.acceptingTools).toBe(false);
      expect(bus.queued("pi")).toBe(1); expect((f.peer as any).tuiQueue).toEqual([]);
      await f.post("/event", { type: "agent_settled", generation: 1, text: "personal answer" });
    }
    const prompt = await f.next(); expect(prompt.type).toBe("prompt"); expect(prompt.message).toContain(queued.body);
    await f.ack(prompt);
    await f.post("/event", { type: "agent_start", generation: 2 });
    await f.post("/event", { type: "agent_settled", generation: 2, text: "hub answer" });
    expect(messages).toEqual(["hub answer"]); expect(delivered).toEqual([queued.id]);
    expect(bus.queued("pi")).toBe(0); expect(f.peer.state).toBe("idle"); expect((f.peer as any).tuiQueue).toEqual([]);
  } finally { bus.closeJournal(); await f.cleanup(); }
});
