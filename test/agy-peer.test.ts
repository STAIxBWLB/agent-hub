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
    const admission = await person.request({ t: "native_hook_launch", op: "begin", peer: "agy" }); expect(admission.ok).toBe(true);
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
