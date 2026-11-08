import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { ModelOverrides, ModelOverrideLatches } from "../src/hub/model-overrides.ts";
import { runInNewContext } from "node:vm";
import { isNativeModelToken } from "../src/adapters/model-token.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
class Passive extends BasePeer { async start() { this.setState("idle"); } async stop() { this.setState("offline"); } async deliver(_envs: Envelope[]) {} }
async function fixture(configured = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-live-model-")), stateDir = join(root, "state"); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const adapters: NonNullable<HubConfig["adapters"]> = configured ? { fixture: { transport: "acp", command: process.execPath, args: [], displayName: "Fixture ACP", roles: ["implementer"] } } : {};
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.local.json"), configured ? JSON.stringify({ adapters }) : "{}");
  const config = { ...DEFAULT_CONFIG, adapters, roster: {}, start: { agents: [] }, batch_ms: 0, configWatch: false,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { urls: [], access_hosts: [] },
    pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } };
  const start = () => startDaemon({ cwd: root, stateDir, config, configWatch: false, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, memorySyncTrigger: () => {} });
  let daemon = await start();
  cleanup.push(() => daemon.stop());
  let console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  const store = new ModelOverrides(join(stateDir, "hub.db")); cleanup.push(() => store.close());
  const request = (input: Record<string, unknown>, client = console_) => client.request({ t: "model", ...input });
  const session = async (settings: boolean, liveTest = false) => {
    const issued = await console_.request({ t: "ui", settings, liveTest }); expect(issued.ok).toBe(true);
    const url = new URL(issued.url);
    const response = await fetch(url.origin + "/session", { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
    expect(response.status).toBe(200); const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return { post: async (input: Record<string, unknown>) => {
      const result = await fetch(url.origin + "/action", { method: "POST", headers: { origin: url.origin, cookie, "content-type": "application/json" }, body: JSON.stringify(input) });
      return await result.json() as any;
    } };
  };
  const restart = async () => { console_.close(); await daemon.stop(); daemon = await start(); console_ = await ControlClient.connect(stateDir, { role: "console" }); };
  return { root, stateDir, daemon, console_, store, request, session, restart };
}

test("person set/list/clear persist desired next-turn state and audit only model metadata", async () => {
  const f = await fixture(), rawBefore = readFileSync(join(f.root, ".agenthub/config.local.json"), "utf8");
  const set = await f.request({ op: "set", peer: "codex", model: "provider/model-one" });
  expect(set).toMatchObject({ ok: true, appliesFrom: "next_turn", model: { peer: "codex", desiredModel: "provider/model-one", effectiveModel: null, source: "native default", pendingNextTurn: true } });
  expect(set.afterTurn).toBeUndefined(); expect(f.store.get("codex")?.by).toBe("person");
  expect((await f.request({ op: "list" })).models.find((row: { peer: string }) => row.peer === "codex").desiredModel).toBe("provider/model-one");
  const status = (await f.console_.request({ t: "status" })).status;
  expect(status.runtimeModels.find((row: { peer: string }) => row.peer === "codex").pendingNextTurn).toBe(true);
  expect(status.models).not.toBeInstanceOf(Array);
  expect((await f.console_.request({ t: "ui_snapshot" })).runtimeModels).toBeInstanceOf(Array);
  expect(await f.request({ op: "clear", peer: "codex" })).toMatchObject({ ok: true, appliesFrom: "next_turn", model: { desiredModel: null, source: "native default" } });
  expect(f.store.hasRecords()).toBe(false); expect(readFileSync(join(f.root, ".agenthub/config.local.json"), "utf8")).toBe(rawBefore);
  const events = readFileSync(join(f.stateDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.type === "model_change");
  expect(events).toHaveLength(2); expect(events[0]).toMatchObject({ peer: "codex", previousModel: null, model: "provider/model-one", source: "cli", by: "person", appliesFrom: "next_turn" });
  expect(events[1]).toMatchObject({ previousModel: "provider/model-one", model: null });
  for (const row of events) { expect(row).not.toHaveProperty("body"); expect(row).not.toHaveProperty("token"); }
});
test("tools cannot list or mutate override state and no hub tool gains a model mutation", async () => {
  const f = await fixture(), peer = new Passive("codex"); f.daemon.bus.add(peer); await peer.start();
  const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" }); cleanup.push(() => tools.close());
  for (const op of ["list", "set", "clear", "preview", "confirm"]) {
    const result = await f.request({ op, peer: "codex", model: "other", token: "forged" }, tools);
    expect(result.ok).toBe(false); expect(result.error).toContain("person-only");
  }
  const tool = await tools.request({ t: "task", op: "hub_model_set", args: { peer: "codex", model: "other" } });
  expect(tool.ok).toBe(false); expect(f.store.list()).toEqual([]);
});
test("unsupported ACP and raw attachment changes have no write or restart; retained rows remain clearable", async () => {
  const f = await fixture();
  for (const peer of ["kimi", "qwen", "jcode"]) {
    const result = await f.request({ op: "set", peer, model: "other" }); expect(result.ok).toBe(false);
    expect(result.error).toContain("unsupported live"); expect(result.error).toContain(`ahub restart ${peer}`);
    expect(f.daemon.bus.peers.has(peer)).toBe(false);
  }
  const raw = new Passive("codex"); f.daemon.bus.add(raw); await raw.start();
  expect((await f.request({ op: "set", peer: "codex", model: "other" })).ok).toBe(false); expect(f.store.list()).toEqual([]);
  f.store.set("kimi", "retained", 1);
  const row = (await f.request({ op: "list" })).models.find((value: { peer: string }) => value.peer === "kimi");
  expect(row).toMatchObject({ desiredModel: "retained", effectiveModel: null, source: "native default", pendingNextTurn: false }); expect(row.unsupported.reason).toContain("unsupported live");
  expect((await f.request({ op: "clear", peer: "kimi" })).ok).toBe(true); expect(f.store.hasRecords()).toBe(false);
});
test("invalid model input is refused before state/audit effects", async () => {
  const f = await fixture();
  for (const model of ["--flag", "bad model", "x".repeat(129), "é"]) expect((await f.request({ op: "set", peer: "codex", model })).ok).toBe(false);
  expect(f.store.list()).toEqual([]); expect(readFileSync(join(f.stateDir, "events.jsonl"), "utf8")).not.toContain('"type":"model_change"');
});
test("dashboard requires a real person settings session, binds confirmation to that session and consumes it once", async () => {
  const f = await fixture(), ordinary = await f.session(false), person = await f.session(true), other = await f.session(true), live = await f.session(true, true);
  const input = { action: "model_preview", modelAction: "set", peer: "codex", model: "dashboard-model" };
  for (const session of [ordinary, live]) expect((await session.post({ ...input, authorityId: "forged", settings: true })).ok).toBe(false);
  expect(f.store.hasRecords()).toBe(false);
  const preview = await person.post(input); expect(preview.ok).toBe(true); expect(preview.confirmation.appliesFrom).toBe("next_turn");
  const confirm = { action: "model_confirm", token: preview.confirmation.token };
  expect((await other.post(confirm)).ok).toBe(false); expect(f.store.hasRecords()).toBe(false);
  const accepted = await person.post(confirm); expect(accepted).toMatchObject({ ok: true, appliesFrom: "next_turn" });
  expect((await person.post(confirm)).ok).toBe(false); expect(f.store.get("codex")?.model).toBe("dashboard-model");
});
test("a newer desired write invalidates dashboard preview before any stale change", async () => {
  const f = await fixture(), person = await f.session(true);
  const preview = await person.post({ action: "model_preview", modelAction: "set", peer: "codex", model: "first" }); expect(preview.ok).toBe(true);
  expect((await f.request({ op: "set", peer: "codex", model: "newer" })).ok).toBe(true);
  const refused = await person.post({ action: "model_confirm", token: preview.confirmation.token }); expect(refused.ok).toBe(false); expect(refused.error).toContain("changed after preview");
  expect(f.store.get("codex")?.model).toBe("newer");
});
test("controlled recovery refuses an unsupported target while overrides are retained and permits one after clear", async () => {
  const f = await fixture(); expect(DAEMON_FEATURES).toContain("model_overrides"); expect((await f.request({ op: "set", peer: "codex", model: "keep" })).ok).toBe(true);
  const status = (await f.console_.request({ t: "status" })).status;
  const recovery = (op: string) => f.console_.request({ t: "recovery", op, operationId: "model-test", expectedInstanceId: status.instanceId, targetFeatures: DAEMON_FEATURES.filter(feature => feature !== "model_overrides") });
  const refused = await recovery("prepare"); expect(refused.ok).toBe(false); expect(refused.error).toContain("target lacks model_overrides"); expect(f.daemon.bus.isRecoveryHeld).toBe(false);
  expect((await f.request({ op: "clear", peer: "codex" })).ok).toBe(true); expect((await recovery("prepare")).ok).toBe(true);
});

test("desired override survives an actual daemon restart without claiming a boundary ACK", async () => {
  const f = await fixture(); expect((await f.request({ op: "set", peer: "codex", model: "persisted" })).ok).toBe(true);
  const before = f.store.integrity(); await f.restart();
  const row = (await f.request({ op: "list" })).models.find((value: { peer: string }) => value.peer === "codex");
  expect(row).toMatchObject({ desiredModel: "persisted", effectiveModel: null, source: "native default", pendingNextTurn: true });
  expect(f.store.integrity()).toEqual(before);
});
test("peer replacement after dashboard preview refuses confirmation without changing desired state", async () => {
  const f = await fixture(), person = await f.session(true);
  const preview = await person.post({ action: "model_preview", modelAction: "set", peer: "codex", model: "first" }); expect(preview.ok).toBe(true);
  const replacement = new Passive("codex"); f.daemon.bus.add(replacement); await replacement.start();
  const result = await person.post({ action: "model_confirm", token: preview.confirmation.token });
  expect(result.ok).toBe(false); expect(result.error).toContain("changed after preview"); expect(f.store.hasRecords()).toBe(false);
});

test("actual confirm comparison refuses changed effective model before effects with unchanged desired row and owner", async () => {
  const f = await fixture(), owner = {}, latches = new ModelOverrideLatches(f.store);
  f.store.set("codex", "retained", 1); const before = f.store.integrity();
  const runtimeModelRow = (peer: string) => latches.status(peer, owner, { source: "native default" });
  latches.capture("codex", owner, {}, () => true).applied();
  const preview = { peer: "codex", config: 0, revision: f.store.revision("codex"), runtime: JSON.stringify(runtimeModelRow("codex")), owner, generation: undefined, afterTurn: undefined };
  // Simulated accepted native-model fact only, not native identity or transport qualification.
  latches.observeNative("codex", owner, "native-second");
  expect(runtimeModelRow("codex").effectiveModel).toBe("native-second"); expect(f.store.revision("codex")).toBe(preview.revision);
  const source = readFileSync(join(import.meta.dir, "../src/hub/daemon.ts"), "utf8");
  const start = source.indexOf("      if (preview.config !== configRevision"), end = source.indexOf("\n    } else {", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  let effects = 0;
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`(function(){${source.slice(start, end)}\nreturn effect();})()`);
  const result = runInNewContext(script, { preview, configRevision: 0, modelOverrides: f.store, runtimeModelRow,
    bus: { peers: new Map([["codex", owner]]) }, connectionGeneration: () => undefined, turns: new Map(),
    modelFailure: (error: string) => ({ ok: false, error }), effect: () => { effects++; throw Error("changed preview reached a write/effect"); } });
  expect(result.ok).toBe(false); expect(result.error).toContain("changed after preview"); expect(effects).toBe(0); expect(f.store.integrity()).toEqual(before);
});

test("audit append failure reports the saved override explicitly without rollback or a false success", async () => {
  const f = await fixture(), file = join(f.stateDir, "events.jsonl"), original = readFileSync(file);
  rmSync(file); mkdirSync(file);
  try {
    const result = await f.request({ op: "set", peer: "codex", model: "saved-model" });
    expect({ ok: result.ok, saved: result.saved, error: result.error }).toEqual({ ok: false, saved: true, error: "model override was saved but its model_change audit could not be appended; run ahub model list before retrying and repair events.jsonl" });
    expect(f.store.get("codex")?.model).toBe("saved-model");
    const listed = await f.request({ op: "list" }); expect(listed.ok).toBe(true);
    expect(listed.models.find((row: { peer: string }) => row.peer === "codex").desiredModel).toBe("saved-model");
    expect(result.error).not.toContain("saved-model"); expect(result.error).not.toContain(f.root);
  } finally { rmSync(file, { recursive: true, force: true }); writeFileSync(file, original); }
});

test("list preserves all current peers alongside 128 retained removed-peer overrides and permits person cleanup", async () => {
  const f = await fixture(), initial = await f.request({ op: "list" }); expect(initial.ok).toBe(true);
  const current = initial.models.map((row: { peer: string }) => row.peer) as string[];
  const retired = Array.from({ length: 128 }, (_, index) => `retired-model-${String(index).padStart(3, "0")}`);
  expect(current.some(peer => retired.includes(peer))).toBe(false);
  for (const peer of retired) f.store.set(peer, "retained-model", 1);
  const listed = await f.request({ op: "list" }); expect(listed.ok).toBe(true);
  const rows = listed.models as { peer: string; desiredModel: string | null }[];
  expect(rows.length).toBeGreaterThan(128); expect(rows.length).toBeLessThanOrEqual(512);
  expect(rows).toHaveLength(current.length + retired.length); expect(new Set(rows.map(row => row.peer)).size).toBe(rows.length);
  for (const peer of current) expect(rows.some(row => row.peer === peer)).toBe(true);
  for (const peer of retired) expect(rows.find(row => row.peer === peer)?.desiredModel).toBe("retained-model");
  for (const peer of retired) {
    const cleared = await f.request({ op: "clear", peer }); expect(cleared.ok, peer).toBe(true); expect(cleared.model.desiredModel).toBeNull();
  }
  expect(f.store.hasRecords()).toBe(false);
  expect((await f.request({ op: "list" })).models.map((row: { peer: string }) => row.peer)).toEqual(current);
}, 20_000);

test("configured peers and valid local bus IDs are listed as unsupported without running recovery hooks", async () => {
  const f = await fixture(true); let hookReads = 0;
  class ExternalAttachment extends Passive { recoveryMetadata(): Record<string, unknown> { hookReads++; throw Error("unexpected recovery hook on a model poll"); } }
  for (const id of ["fixture", "legacy-extra", "kimi@remote", "codex~session"]) {
    const owner = new ExternalAttachment(id); f.daemon.bus.add(owner); await owner.start();
  }
  hookReads = 0; // Setup and unrelated legacy status readers are outside this feature's list boundary.
  const listed = await f.request({ op: "list" }); expect(listed.ok).toBe(true);
  expect(hookReads).toBe(0);
  const rows = listed.models as { peer: string; effectiveModel: string | null; unsupported?: { reasonCode: string } }[];
  for (const id of ["fixture", "legacy-extra"]) expect(rows.find(row => row.peer === id)).toMatchObject({ effectiveModel: null, unsupported: { reasonCode: "unverified_setter" } });
  expect(rows.some(row => row.peer === "kimi@remote" || row.peer === "codex~session")).toBe(false);
  const refused = await f.request({ op: "set", peer: "fixture", model: "unverified" });
  expect(refused.ok).toBe(false); expect(refused.error).toContain("unsupported live: fixture"); expect(refused.error).toContain("ahub restart fixture");
  expect(f.store.hasRecords()).toBe(false); expect(f.daemon.bus.peers.get("fixture")?.state).toBe("idle");
  await f.console_.request({ t: "status" }); await f.console_.request({ t: "ui_snapshot" });
});

test("model display overflow is explicit while status and single-peer writes remain usable", async () => {
  const f = await fixture(), initial = await f.request({ op: "list" }); expect(initial.ok).toBe(true);
  const added: string[] = [];
  // Owned fixture metadata only: no sockets, native starts, state events or new transport admission policy.
  const add = (id: string) => { added.push(id); f.daemon.bus.peers.set(id, new Passive(id)); };
  try {
    for (let i = 0; i < 512 - initial.models.length; i++) add(`display-peer-${i}`);
    const edge = await f.request({ op: "list" }); expect(edge.ok).toBe(true); expect(edge.models).toHaveLength(512);
    add("display-overflow");
    const overflow = await f.request({ op: "list" }); expect(overflow.ok).toBe(false); expect(overflow.models).toBeUndefined();
    expect(overflow.error).toContain("model list exceeds its display bound"); expect(overflow.error).toContain("close unused peer sessions"); expect(overflow.error).toContain("ahub model clear");
    const status = (await f.console_.request({ t: "status" })).status;
    expect(status.instanceId).toBeDefined(); expect(status.runtimeModels).toEqual([]); expect(status.runtimeModelsUnavailable).toBe(true);
    const snapshot = await f.console_.request({ t: "ui_snapshot" }); expect(snapshot.ok).toBe(true); expect(snapshot.runtimeModels).toEqual([]); expect(snapshot.runtimeModelsUnavailable).toBe(true);
    const set = await f.request({ op: "set", peer: "codex", model: "single-peer-still-works" }); expect(set.ok).toBe(true); expect(f.store.get("codex")?.model).toBe("single-peer-still-works");
    expect((await f.request({ op: "clear", peer: "codex" })).ok).toBe(true); expect(f.store.hasRecords()).toBe(false);
  } finally { for (const id of added) f.daemon.bus.peers.delete(id); }
});

test("actual model fallback repeatedly reads cached scalar metadata and never invokes a recovery hook", () => {
  const source = readFileSync(join(import.meta.dir, "../src/hub/daemon.ts"), "utf8");
  const start = source.indexOf("  const modelFallback ="), end = source.indexOf("  const registerModelOwner =", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  let reads = 0;
  const owner = { recoveryMetadata() { reads++; throw Error("model fallback invoked a recovery hook"); } }, external = { recoveryMetadata() { reads++; throw Error("external recovery hook invoked"); } };
  const cache = new WeakMap<object, string>([[owner, "launch-model"]]);
  const context = { declarations: { declared: { model: "instance-model" } }, isNativeModelToken,
    bus: { peers: new Map([["codex", owner], ["external", external], ["declared", owner]]) }, modelLaunchModels: cache,
    fallback: undefined as unknown as (peer: string) => { model?: string; source: string } };
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end) + "\nglobalThis.fallback = modelFallback;");
  runInNewContext(script, context);
  for (let index = 0; index < 3; index++) {
    expect(context.fallback("codex")).toEqual({ model: "launch-model", source: "launch" });
    expect(context.fallback("external")).toEqual({ source: "native default" });
    expect(context.fallback("declared")).toEqual({ model: "instance-model", source: "instance" });
  }
  expect(reads).toBe(0);
});
