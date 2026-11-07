import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { TASK_TOOLS, projectToolList } from "../src/hub/hub-tools.ts";
import { reviewCaptureExcluded } from "../src/hub/memory-policy.ts";
import { ownerToolEffect } from "../src/hub/no-writes.ts";
import { validateRawConfig, configApply } from "../src/hub/config-apply.ts";
import { settingDef } from "../src/hub/settings.ts";
import { VisualStore, validateVisualInput } from "../src/hub/visual.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class FakeVisualPeer extends BasePeer {
  readonly received: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.received.push(...envs); }
}
const payload = { kind: "mermaid", title: "Flow", source: "flowchart LR\nA-->BODY-ONLY-MARKER" };
async function rig(screen?: Parameters<typeof startDaemon>[0]["piiScreen"], runningPii?: string[], initialPolicy?: { shared: Record<string, unknown>; local: Record<string, unknown> }) {
  const root = mkdtempSync(join(tmpdir(), "ahub-visual-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agenthub"));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8")
    .replace(/^pii_patterns = .*$/m, 'pii_patterns = ["PRIVATE-VISUAL"]')
    .replace(/^pii_screen = .*$/m, `pii_screen = "${screen ? "local" : "off"}"`);
  writeFileSync(join(root, ".agenthub/routing.toml"), routing);
  if (initialPolicy) {
    writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify(initialPolicy.shared));
    writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify(initialPolicy.local));
  }
  const accepted = initialPolicy ? loadConfig(root) : DEFAULT_CONFIG;
  const stateDir = join(root, "state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    ...(screen ? { piiScreen: screen } : {}), config: { ...accepted, ...(runningPii ? { pii: { paths: runningPii } } : {}), batch_ms: 0, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, local: { ...DEFAULT_CONFIG.local, deny: initialPolicy ? accepted.local.deny : ["secret"] } } });
  cleanup.push(() => daemon.stop());
  const sender = new FakeVisualPeer("codex"); daemon.bus.add(sender); await sender.start();
  const receiver = new FakeVisualPeer("kimi"); daemon.bus.add(receiver); await receiver.start();
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "codex" }); cleanup.push(() => tools.close());
  const op = (name: string, args: Record<string, unknown>, client = tools) => client.request({ t: "task", op: name, args });
  const snapshot = (args: Record<string, unknown> = {}) => console_.request({ t: "ui_snapshot", ...args });
  const store = new VisualStore(join(stateDir, "hub.db")); cleanup.push(() => store.close());
  const post = async (value: unknown, extra: Record<string, unknown> = {}) => {
    const result = await op("hub_visual", { payload: value, ...extra });
    expect(result.ok, String(result.error)).toBe(true);
    return String(result.text).slice("visual ".length);
  };
  return { root, stateDir, daemon, sender, receiver, console_, tools, op, snapshot, store, post };
}

test("ordinary and readonly visual publication is shared; input/result capture is excluded even on refusal", () => {
  expect(TASK_TOOLS.map(tool => tool.name)).toEqual(expect.arrayContaining(["hub_visual", "hub_visual_show"]));
  const readonly = projectToolList(TASK_TOOLS, true).map(tool => tool.name);
  expect(readonly).toContain("hub_visual_show"); expect(readonly).not.toContain("hub_visual");
  for (const name of ["hub_visual", "hub_visual_show", "mcp__agent_hub__hub_visual", "mcp__agent_hub__hub_visual_show"])
    expect(reviewCaptureExcluded(name, "not even valid JSON")).toBe(true);
  expect(reviewCaptureExcluded("hub_task_show", "{}")).toBe(false);
  expect(ownerToolEffect("hub_visual", {})).toBe(true); expect(ownerToolEffect("hub_visual_show", {})).toBe(false);
});

test("published table column minimum accepts the runtime's empty table boundary", () => {
  const schema = TASK_TOOLS.find(tool => tool.name === "hub_visual")!.inputSchema.properties.payload as {
    oneOf: { properties: { kind: { const: string }; columns?: { minItems?: number } } }[];
  };
  const columns = schema.oneOf.find(shape => shape.properties.kind.const === "table")!.properties.columns!;
  const accepted = validateVisualInput({ kind: "table", columns: [], rows: [] }, () => true);
  expect(accepted.kind).toBe("table");
  if (accepted.kind !== "table") throw new Error("table validation returned another kind");
  expect(accepted.columns.length).toBeGreaterThanOrEqual(columns.minItems ?? 0);
});

test("four payloads round-trip locally; ordinary snapshot and observer files contain metadata/stubs only", async () => {
  const r = await rig();
  const values = [payload, { kind: "comparison", options: [{ title: "A", pros: ["simple"] }, { title: "B", recommended: true }] },
    { kind: "table", columns: [{ key: "name", label: "Name" }], rows: [{ name: "row" }] },
    { kind: "beforeAfter", before: { text: "old" }, after: { text: "new" } }];
  for (const value of values) {
    const id = await r.post(value);
    expect(JSON.parse((await r.op("hub_visual_show", { id })).text).payload).toEqual(value);
    const selected = await r.snapshot({ visual: id });
    expect(selected.visual.payload).toEqual(value); expect(selected.instanceId).toBeDefined(); expect(selected.projectId).toBeDefined();
  }
  const ordinary = await r.snapshot();
  expect(ordinary.visuals).toHaveLength(4); expect(JSON.stringify(ordinary.visuals)).not.toContain("BODY-ONLY-MARKER");
  expect(r.receiver.received).toHaveLength(0);
  for (const name of ["events.jsonl", "hub.log"])
    expect(readFileSync(join(r.stateDir, name), "utf8")).not.toContain("BODY-ONLY-MARKER");
  const visualEvents = readFileSync(join(r.stateDir, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"type":"visual"')).map(line => JSON.parse(line));
  expect(visualEvents).toHaveLength(4);
  expect(visualEvents.every(row => !Object.hasOwn(row, "title") && !Object.hasOwn(row, "payload") && !Object.hasOwn(row, "path"))).toBe(true);
  for (let i = 0; i < 21; i++) r.store.insert({ id: randomUUID(), from: "codex", kind: "mermaid", title: "Flow", payload: { kind: "mermaid", title: "Flow", source: "flowchart LR\nA-->B" }, files: [], created: Date.now() });
  expect((await r.snapshot()).visuals).toHaveLength(20);
});

test("explicit local recipients receive only the visual stub and unknown/remote recipients have no store effect", async () => {
  const r = await rig(), id = await r.post(payload, { to: "kimi" });
  const queued = r.receiver.received.length ? r.receiver.received : r.daemon.bus.queueIds("kimi").map(id => r.daemon.bus.get(id)!);
  expect(queued.some(env => env.refs?.visual === id && env.body === `[visual ${id}] mermaid: Flow`)).toBe(true);
  expect(JSON.stringify(queued)).not.toContain("BODY-ONLY-MARKER");
  for (const to of ["unknown-peer", "kimi@remote", ["kimi", 42]]) expect((await r.op("hub_visual", { payload, to })).ok).toBe(false);
  expect(r.store.list()).toHaveLength(1);
});

test("PII text, private paths, invalid task and a PII task refuse before any visual row", async () => {
  const r = await rig();
  const made = await r.op("hub_task_propose", { title: "PRIVATE-VISUAL task", class: "implement" }, r.console_);
  expect(made.ok).toBe(true); const task = Number(/#(\d+)/.exec(made.text)![1]);
  for (const args of [{ payload: { ...payload, title: "PRIVATE-VISUAL" } }, { payload, task }, { payload, task: 9999 },
    { payload: { kind: "beforeAfter", before: { path: "secret/image.png", alt: "secret" }, after: { text: "new" } } }]) {
    const result = await r.op("hub_visual", args); expect(result.ok).toBe(false); expect(result.error).not.toContain("secret/image.png");
  }
  expect(r.store.list()).toHaveLength(0); expect((await r.snapshot()).visuals).toEqual([]);
});

test("generation change during the awaited privacy screen has no store/bus effect", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const r = await rig(async () => { entered(); await gate; return { label: "clear", ms: 0 }; });
  const request = r.op("hub_visual", { payload });
  await started;
  const replacement = new FakeVisualPeer("codex"); r.daemon.bus.add(replacement); await replacement.start();
  release(); const result = await request;
  expect(result.ok).toBe(false); expect(r.store.list()).toHaveLength(0); expect(r.receiver.received).toHaveLength(0);
});

test("asset selectors return only host-recorded metadata, then fail after current file policy changes", async () => {
  const r = await rig();
  writeFileSync(join(r.root, "image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const id = await r.post({ kind: "beforeAfter", before: { path: "image.png", alt: "before" }, after: { text: "new" } });
  const selected = await r.snapshot({ visualAsset: `${id}:before` });
  expect(selected.visualAsset).toMatchObject({ id, file: { asset: `${id}:before`, path: "image.png", bytes: 8, mime: "image/png" } });
  expect(selected.visualAsset.file.sha256).toMatch(/^[a-f0-9]{64}$/); expect(selected.visualAsset.file.data).toBeUndefined();
  writeFileSync(join(r.root, ".agenthub/config.local.json"), JSON.stringify({ pii: { paths: ["image.png"] } }));
  let reload = await r.console_.request({ t: "settings_reload" });
  if (reload.confirmation?.token) reload = await r.console_.request({ t: "settings_reload", confirm: reload.confirmation.token });
  expect(reload.ok).toBe(true);
  expect((await r.snapshot({ visualAsset: `${id}:before` })).visualAsset).toBeNull();
  expect((await r.snapshot({ visual: id })).visual).toBeNull();
  expect((await r.op("hub_visual_show", { id })).ok).toBe(false);
  expect((await r.snapshot()).visuals).toEqual([]);
  expect((await r.tools.request({ t: "ui_snapshot", visual: id })).ok).toBe(false);
});

test("pending weaker raw file policy cannot release an accepted runtime restriction", async () => {
  const r = await rig(undefined, ["image.png"]), id = randomUUID();
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); writeFileSync(join(r.root, "image.png"), bytes);
  // A retained public visual predating the current runtime classification, not a bypass of the posting tool.
  r.store.insert({ id, from: "codex", kind: "beforeAfter", title: "", created: Date.now(),
    payload: { kind: "beforeAfter", before: { asset: `${id}:before`, alt: "before" }, after: { text: "new" } },
    files: [{ asset: `${id}:before`, path: "image.png", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mime: "image/png" }] });
  expect((await r.snapshot({ visualAsset: `${id}:before` })).visualAsset).toBeNull();
  writeFileSync(join(r.root, ".agenthub/config.local.json"), JSON.stringify({ pii: { paths: [] }, local: { deny: [] } }));
  expect((await r.snapshot({ visualAsset: `${id}:before` })).visualAsset).toBeNull();
  expect((await r.snapshot({ visual: id })).visual).toBeNull();
  expect((await r.op("hub_visual_show", { id })).ok).toBe(false);
  expect((await r.op("hub_visual", { payload: { kind: "beforeAfter", before: { path: "image.png", alt: "before" }, after: { text: "new" } } })).ok).toBe(false);
  expect(r.store.list()).toHaveLength(1);
});

test("adopted effective local override does not resurrect a shadowed shared file restriction", async () => {
  const r = await rig(undefined, undefined, {
    shared: { pii: { paths: ["image.png"] }, local: { deny: ["image.png"] } },
    local: { pii: { paths: [] }, local: { deny: [] } },
  });
  expect(loadConfig(r.root)).toMatchObject({ pii: { paths: [] }, local: { deny: [] } });
  writeFileSync(join(r.root, "image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const id = await r.post({ kind: "beforeAfter", before: { path: "image.png", alt: "before" }, after: { text: "new" } });
  expect((await r.snapshot({ visualAsset: `${id}:before` })).visualAsset).toMatchObject({ id, file: { path: "image.png" } });
  expect((await r.op("hub_visual_show", { id })).ok).toBe(true);
});

test("new raw deny policy and malformed file policy close visual metadata and new file reads", async () => {
  const r = await rig();
  writeFileSync(join(r.root, "image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const image = { kind: "beforeAfter", before: { path: "image.png", alt: "before" }, after: { text: "new" } };
  const id = await r.post(image);
  for (const raw of [JSON.stringify({ local: { deny: ["image.png"] } }), JSON.stringify({ pii: { paths: "image.png" } }), "invalid-json"]) {
    writeFileSync(join(r.root, ".agenthub/config.local.json"), raw);
    expect((await r.snapshot({ visualAsset: `${id}:before` })).visualAsset).toBeNull();
    expect((await r.snapshot({ visual: id })).visual).toBeNull();
    expect((await r.op("hub_visual_show", { id })).ok).toBe(false);
    const refused = await r.op("hub_visual", { payload: image });
    expect(refused.ok).toBe(false); expect(refused.error).not.toContain("image.png");
    expect(r.store.list()).toHaveLength(1);
  }
});

test("closed bus refuses before a visual row is written", async () => {
  const r = await rig();
  r.daemon.bus.closeJournal();
  expect((await r.op("hub_visual", { payload })).ok).toBe(false);
  expect(r.store.list()).toHaveLength(0);
});

test("retention config shares live bounds and marks broader retention as privacy raising", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-visual-config-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agenthub"));
  expect(loadConfig(root).visuals.retention_days).toBe(30);
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ visuals: { retention_days: 7 } }));
  expect(loadConfig(root).visuals.retention_days).toBe(7);
  for (const retention_days of [0, -1, 1.5, 3651, "30"]) expect(() => validateRawConfig({ visuals: { retention_days } })).toThrow();
  expect(() => validateRawConfig({ visuals: { retention_days: 3650 } })).not.toThrow();
  expect(configApply("visuals.retention_days").applies).toBe("live");
  expect(settingDef("visuals.retention_days")).toMatchObject({ risk: "raises", min: 1, max: 3650 });
});
