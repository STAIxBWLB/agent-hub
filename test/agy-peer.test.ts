import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, definitionOf, isSupportedPeer } from "../src/adapters/registry.ts";
import { assign, loadRouting } from "../src/hub/routing.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { ControlClient } from "../src/hub/control-client.ts";

async function until(condition: () => boolean) { const end = Date.now() + 3000; while (!condition() && Date.now() < end) await Bun.sleep(10); expect(condition()).toBe(true); }

test("agy is a real optional implementer, with no cloud PII or reviewer admission", () => {
  expect(ADAPTERS.some(adapter => adapter.kind === "agy")).toBe(true); expect(isSupportedPeer("agy")).toBe(true);
  expect(isSupportedPeer("agy-placeholder", { "agy-placeholder": { kind: "agy", roles: ["reviewer"], start_mode: "headless" } })).toBe(false);
  const definition = definitionOf("agy")!;
  expect(definition.roles).toEqual(["implementer", "verifier"]); expect(definition.defaultOnRoster).toBe(false);
  expect(definition.budget).toBeUndefined(); expect(definition.trust).toEqual({ onPrem: false, hubSandboxed: false });
  expect(definition.reviewerVariant?.reviewer?.unavailable).toBe("agy is an implementer peer (#485)");
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-pii-"));
  try {
    const routed = assign({ class: "implement", signals: ["pii"], reserved: "agy" }, { agy: "idle" }, loadRouting(root), { namedOwner: "agy", candidates: ["agy"], roles: { agy: ["implementer", "verifier"] } });
    expect(routed.owner).toBeUndefined();
    for (const className of ["plan", "review"] as const) expect(assign({ class: className, signals: [], reserved: "agy" }, { agy: "idle" }, loadRouting(root), { namedOwner: "agy", namedReviewer: "agy", candidates: ["agy"], roles: { agy: ["planner", "reviewer"] } }).owner).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agy pull attach and native hooks are bound to person launch, daemon, session and socket generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-peer-")), stateDir = join(root, "state"), savedHome = process.env.HOME;
  process.env.HOME = root;
  const session = "ee5ab2ab-7319-4a81-82ca-bf2fc84678d0";
  const logs = join(root, ".gemini/antigravity-cli/brain", session, ".system_generated/logs"), transcript = join(logs, "transcript_full.jsonl");
  mkdirSync(logs, { recursive: true }); writeFileSync(transcript, "");
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ roster: { agy: true }, memory: { enabled: false, native: false }, snapshots: { enabled: false }, pi: { enabled: false, auto_start: false }, inference: { enabled: false, triage: false }, mlx: { enabled: false } }));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: {
    ...DEFAULT_CONFIG, roster: { agy: true }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
    inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
  } });
  const person = await ControlClient.connect(stateDir, { role: "console" });
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "agy" });
  let peer: ControlClient | undefined;
  try {
    expect((await tools.request({ t: "native_hook_launch", op: "begin", peer: "agy" })).ok).toBe(false);
    let pushClient: ControlClient | undefined;
    let pushRefused = false;
    try { pushClient = await ControlClient.connect(stateDir, { role: "peer", peer: "agy", channel: true }); }
    catch { pushRefused = true; }
    finally { pushClient?.close(); }
    expect(pushRefused).toBe(true);
    const launcher = await ControlClient.connect(stateDir, { role: "console" });
    const abandoned = await launcher.request({ t: "native_hook_launch", op: "begin", peer: "agy" });
    expect(abandoned.ok).toBe(true);
    expect((await person.request({ t: "native_hook_launch", op: "begin", peer: "agy" })).ok).toBe(false);
    launcher.close();
    let admission: any;
    const reconnectDeadline = Date.now() + 3000;
    do {
      admission = await person.request({ t: "native_hook_launch", op: "begin", peer: "agy" });
      if (admission.ok) break;
      await Bun.sleep(10);
    } while (Date.now() < reconnectDeadline);
    expect(admission.ok).toBe(true);
    expect(admission.launchId).not.toBe(abandoned.launchId);
    peer = await ControlClient.connect(stateDir, { role: "peer", peer: "agy", channel: false });
    await until(() => daemon.bus.peers.get("agy")?.state === "idle");
    daemon.bus.publish(newEnvelope("user", "pull-only fixture", { to: ["agy"] }));
    expect(daemon.bus.queued("agy")).toBe(1); expect((await peer.request({ t: "inbox" })).envs.some((env: any) => env.body === "pull-only fixture")).toBe(true);
    const payload = { conversationId: session, transcriptPath: transcript, workspacePaths: [root], invocationNum: 0 };
    const facts = (event: string, extra = {}, overrides = {}) => tools.request({ t: "native_facts", event, payload: { ...payload, ...extra }, nativeInstanceId: admission.instanceId, nativeLaunchId: admission.launchId, ...overrides });
    expect((await facts("PreInvocation", {}, { nativeLaunchId: "stale" })).ok).toBe(false);
    expect((await facts("PreInvocation", { workspacePaths: ["/outside"] })).ok).toBe(false);
    expect((await facts("PreInvocation")).ok).toBe(true); expect(daemon.bus.peers.get("agy")?.state).toBe("busy");
    expect((await facts("Stop", { fullyIdle: false, terminationReason: "NO_TOOL_CALL" })).ok).toBe(false);
    writeFileSync(transcript, JSON.stringify({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "complete" }) + "\n");
    expect((await facts("Stop", { fullyIdle: true, terminationReason: "NO_TOOL_CALL" })).ok).toBe(true);
    await until(() => daemon.bus.peers.get("agy")?.state === "idle");
    const removed = await person.request({ t: "settings_set", key: "roster.agy", value: false, confirm: "agy" });
    expect(removed).toMatchObject({ ok: true });
    expect((await person.request({ t: "native_hook_launch", op: "end", peer: "agy", launchId: admission.launchId })).ok).toBe(true);
    expect((await facts("PreInvocation")).ok).toBe(false);
  } finally {
    peer?.close(); tools.close(); person.close(); await daemon.stop();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

async function claimingHooks(run: (fixture: {
  daemon: Awaited<ReturnType<typeof startDaemon>>; owner: { state: string; claiming: boolean }; tools: ControlClient;
  person: ControlClient; peer: ControlClient; admission: any; stateDir: string; transcript: string;
  release(): void; facts(event: string, extra?: Record<string, unknown>): Promise<any>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-claim-")), stateDir = join(root, "state"), savedHome = process.env.HOME;
  process.env.HOME = root;
  const session = "ee5ab2ab-7319-4a81-82ca-bf2fc84678d0";
  const directory = join(root, ".gemini/antigravity-cli/brain", session, ".system_generated/logs"), transcript = join(directory, "transcript_full.jsonl");
  mkdirSync(directory, { recursive: true }); writeFileSync(transcript, "");
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), seen = new Promise<void>(resolve => { began = resolve; });
  const memory = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/api/context/inject") { began(); await gate; return new Response("# [fixture]\n### Today\ncontext"); }
    return Response.json({ status: "ok" });
  } });
  const config = { ...DEFAULT_CONFIG, roster: { agy: true }, batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: true, native: false, worker_url: `http://127.0.0.1:${memory.port}` },
    inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } };
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify(config));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  let person: ControlClient | undefined, tools: ControlClient | undefined, peer: ControlClient | undefined;
  try {
    person = await ControlClient.connect(stateDir, { role: "console" });
    tools = await ControlClient.connect(stateDir, { role: "tools", peer: "agy" });
    const admission = await person.request({ t: "native_hook_launch", op: "begin", peer: "agy" }); expect(admission.ok).toBe(true);
    peer = await ControlClient.connect(stateDir, { role: "peer", peer: "agy", channel: false }); await seen;
    const owner = daemon.bus.peers.get("agy")! as any; expect(owner.claiming).toBe(true);
    const facts = (event: string, extra = {}) => tools!.request({ t: "native_facts", event,
      payload: { conversationId: session, transcriptPath: transcript, workspacePaths: [root], invocationNum: 0, ...extra },
      nativeInstanceId: admission.instanceId, nativeLaunchId: admission.launchId });
    await run({ daemon, owner, tools, person, peer, admission, stateDir, transcript, release, facts });
  } finally {
    release(); await until(() => !!daemon.bus.snapshot().prefaces.agy);
    peer?.close(); tools?.close(); person?.close(); await daemon.stop(); memory.stop(true);
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
}

test("agy first SessionStart and PreInvocation wait for the claimed socket and track its tool-free Stop", async () => {
  await claimingHooks(async ({ owner, tools, transcript, release, facts }) => {
    let sessionSettled = false, startSettled = false;
    const session = facts("SessionStart").then(result => { sessionSettled = true; return result; });
    const start = facts("PreInvocation").then(result => { startSettled = true; return result; });
    await tools.request({ t: "status" }); // consume both requests while the memory response still holds attach
    expect(sessionSettled).toBe(false); expect(startSettled).toBe(false);
    release(); expect((await session).ok).toBe(true); expect((await start).ok).toBe(true);
    expect(owner.claiming).toBe(false); expect(owner.state).toBe("busy");
    writeFileSync(transcript, JSON.stringify({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "complete" }) + "\n");
    expect((await facts("Stop", { fullyIdle: true, terminationReason: "NO_TOOL_CALL" })).ok).toBe(true);
    await until(() => owner.state === "idle");
  });
}, 10000);

for (const changed of ["launch", "socket", "detach"] as const) test(`agy queued first-turn hook refuses a changed ${changed} before attach`, async () => {
  await claimingHooks(async ({ owner, tools, person, peer, admission, stateDir, release, facts }) => {
    const start = facts("PreInvocation"); await tools.request({ t: "status" });
    let replacement: ControlClient | undefined;
    try {
      if (changed === "launch") expect((await person.request({ t: "native_hook_launch", op: "end", peer: "agy", launchId: admission.launchId })).ok).toBe(true);
      else if (changed === "socket") replacement = await ControlClient.connect(stateDir, { role: "peer", peer: "agy", channel: false });
      else { peer.close(); await until(() => !owner.claiming); }
      release(); expect((await start).ok).toBe(false);
      if (changed !== "detach") await until(() => owner.state === "idle");
      expect(owner.state).not.toBe("busy");
    } finally { replacement?.close(); }
  });
}, 10000);

test("agy queued start preserves its observation baseline when the turn finishes before attach", async () => {
  await claimingHooks(async ({ owner, tools, transcript, release, facts }) => {
    const start = facts("PreInvocation"); await tools.request({ t: "status" });
    writeFileSync(transcript, JSON.stringify({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "finished during recall" }) + "\n");
    const stop = facts("Stop", { fullyIdle: true, terminationReason: "NO_TOOL_CALL" }); await tools.request({ t: "status" });
    release(); expect((await start).ok).toBe(true); expect((await stop).ok).toBe(true);
    await until(() => !owner.claiming && owner.state === "idle");
  });
}, 10000);


test("agy claiming hook waiters are capped and every admitted request settles after attach", async () => {
  await claimingHooks(async ({ tools, release, facts }) => {
    const waiting = Array.from({ length: 64 }, () => facts("SessionStart"));
    await tools.request({ t: "status" });
    expect((await facts("SessionStart")).ok).toBe(false);
    release(); expect((await Promise.all(waiting)).every(result => result.ok === true)).toBe(true);
  });
}, 10000);
