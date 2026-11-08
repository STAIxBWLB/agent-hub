import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { TASK_TOOLS, projectToolList } from "../src/hub/hub-tools.ts";
import { reviewCaptureExcluded } from "../src/hub/memory-policy.ts";
import { ownerToolEffect } from "../src/hub/no-writes.ts";
import { validateRawConfig, configApply } from "../src/hub/config-apply.ts";
import { settingDef } from "../src/hub/settings.ts";
import { VisualStore, validateVisualInput, VISUAL_LIMITS } from "../src/hub/visual.ts";
import { readVisualAsset } from "../src/hub/visual-assets.ts";
import { openHubDatabase } from "../src/hub/db-schema.ts";
import { runInNewContext } from "node:vm";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class FakeVisualPeer extends BasePeer {
  readonly received: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.received.push(...envs); }
}
const payload = { kind: "mermaid", title: "Flow", source: "flowchart LR\nA-->BODY-ONLY-MARKER" };
async function rig(screen?: Parameters<typeof startDaemon>[0]["piiScreen"], runningPii?: string[], initialPolicy?: { shared: Record<string, unknown>; local: Record<string, unknown> }, overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
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
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, local: { ...DEFAULT_CONFIG.local, deny: initialPolicy ? accepted.local.deny : ["secret"] }, ...overrides } });
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
  expect(ownerToolEffect("hub_visual", {})).toBe(false); expect(ownerToolEffect("hub_visual_show", {})).toBe(false);
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

test("published image alt minimum accepts the runtime's empty alt while keeping alt required", () => {
  const schema = TASK_TOOLS.find(tool => tool.name === "hub_visual")!.inputSchema.properties.payload as {
    oneOf: { properties: { kind: { const: string }; before?: { oneOf: { properties: { path?: unknown; alt?: { minLength?: number } }; required: string[] }[] } } }[];
  };
  const image = schema.oneOf.find(shape => shape.properties.kind.const === "beforeAfter")!.properties.before!.oneOf.find(side => side.properties.path)!;
  const accepted = validateVisualInput({ kind: "beforeAfter", before: { path: "image.png", alt: "" }, after: { text: "" } }, () => true);
  if (accepted.kind !== "beforeAfter" || !("path" in accepted.before)) throw new Error("image validation returned another side");
  expect(accepted.before.alt.length).toBeGreaterThanOrEqual(image.properties.alt!.minLength ?? 0);
  expect(image.required).toContain("alt");
  expect(() => validateVisualInput({ kind: "beforeAfter", before: { path: "image.png" }, after: { text: "" } }, () => true)).toThrow();
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

function operationalRefusal(result: { ok: boolean; error?: string }, cause: RegExp) {
  expect(result.ok).toBe(false); expect(result.error).toMatch(cause); expect(result.error).toMatch(/retry|ask the person|ordinary turn/);
  expect(result.error).not.toContain("PRIVATE-VISUAL"); expect(result.error).not.toContain("PRIVATE-ERROR");
}
for (const kind of ["role", "membership", "recovery", "storage"] as const) test(`nonprivacy visual refusal names its cause and next step: ${kind}`, async () => {
  const r = await rig(undefined, undefined, kind === "membership" ? { shared: {}, local: {} } : undefined, kind === "role" ? { capabilities: { ...DEFAULT_CONFIG.capabilities, codex: [] } } : {});
  // Connect first, then withdraw the actual roster membership. An initially off-roster peer cannot complete hello.
  if (kind === "membership") {
    // The passive fake has no native stop evidence. The saved membership is authoritative; stop remains unqualified.
    expect(await r.console_.request({ t: "settings_set", key: "roster.codex", value: false, confirm: "codex" })).toMatchObject({
      ok: false, saved: true,
      error: "roster saved; codex stop is unconfirmed; permission reset and task handoff were not attempted; inspect ahub status and reapply roster.codex false to retry",
    });
    const settings = await r.console_.request({ t: "settings_get" });
    expect(settings.rows.find((row: { key: string }) => row.key === "roster.codex").value).toBe(false);
  }
  if (kind === "recovery") r.daemon.bus.setRecoveryHold(true);
  const journalAvailable = r.daemon.bus.deliveryJournalAvailable;
  // Closing the real journal also holds recovery. Inject only the unavailable-storage observation to isolate this cause.
  if (kind === "storage") { expect(r.daemon.bus.isRecoveryHeld).toBe(false); r.daemon.bus.deliveryJournalAvailable = () => false; }
  try {
    const result = await r.op("hub_visual", { payload });
    operationalRefusal(result, { role: /remember capability.*writable peer role/, membership: /off roster/, recovery: /controlled recovery/, storage: /storage.*unavailable/ }[kind]);
    expect(r.store.list()).toEqual([]); expect(r.receiver.received).toEqual([]);
  } finally {
    if (kind === "recovery") r.daemon.bus.setRecoveryHold(false);
    if (kind === "storage") { r.daemon.bus.deliveryJournalAvailable = journalAvailable; expect(r.daemon.bus.isRecoveryHeld).toBe(false); }
  }
});
for (const kind of ["unknown", "throw", "pii"] as const) test(`privacy screen ${kind} keeps the right public refusal without leaking input or errors`, async () => {
  const r = await rig(async () => {
    if (kind === "throw") throw Error("PRIVATE-ERROR");
    return kind === "pii" ? { label: "pii", ms: 0 } : { label: "unknown", miss: "unreadable", ms: 0 };
  });
  const result = await r.op("hub_visual", { payload });
  if (kind === "pii") { expect(result.ok).toBe(false); expect(result.error).toContain("visual unavailable under the current privacy or project policy"); }
  else operationalRefusal(result, /privacy screen is unavailable or returned no clear verdict/);
  expect(result.error).not.toContain("BODY-ONLY-MARKER"); expect(result.error).not.toContain("PRIVATE-ERROR"); expect(r.store.list()).toEqual([]);
});

test("an explicit user recipient receives the same bounded stub and succeeds", async () => {
  const r = await rig(), events: Envelope[] = [];
  const off = r.daemon.bus.tap(event => { if (event.t === "envelope") events.push(event.env); });
  try {
    const id = await r.post(payload, { to: "user" });
    expect(r.store.get(id)).toBeDefined();
    const sent = events.find(env => env.refs?.visual === id);
    expect(sent?.to).toEqual(["user"]); expect(sent?.body).toBe(`[visual ${id}] mermaid: Flow`); expect(JSON.stringify(sent)).not.toContain("BODY-ONLY-MARKER");
  } finally { off(); }
});

test("a missing image preserves posted visual metadata and text while its guarded asset read fails", async () => {
  const r = await rig(); writeFileSync(join(r.root, "image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const id = await r.post({ kind: "beforeAfter", before: { path: "image.png", alt: "before" }, after: { text: "preserved text" } });
  const file = r.store.get(id)!.files[0]!; rmSync(join(r.root, "image.png"));
  expect((await r.snapshot()).visuals.map((row: { id: string }) => row.id)).toContain(id);
  const shown = await r.op("hub_visual_show", { id }); expect(shown.ok).toBe(true); expect(JSON.parse(shown.text).payload.after).toEqual({ text: "preserved text" });
  expect((await r.snapshot({ visual: id })).visual.id).toBe(id);
  await expect(readVisualAsset(file, { cwd: r.root, deny: [], private: () => false })).rejects.toThrow("changed since posted or no longer allowed");
});

for (const kind of ["task", "config"] as const) test(`awaited visual admission refuses concurrent ${kind} changes with no store effect`, async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const r = await rig(async text => {
    // Task setup may also use the model screen. Hold only the actual visual input, not the setup request.
    if (text.includes("BODY-ONLY-MARKER")) { enter(); await held; }
    return { label: "clear", ms: 0 };
  });
  let task: number | undefined;
  if (kind === "task") { const made = await r.op("hub_task_propose", { title: "public visual task", class: "implement" }, r.console_); expect(made.ok).toBe(true); task = Number(/#(\d+)/.exec(made.text)![1]); }
  const request = r.op("hub_visual", { payload, ...(task === undefined ? {} : { task }) });
  try {
    await entered;
    if (kind === "task") expect((await r.op("hub_task_cancel", { id: task, reason: "fixture concurrent change" }, r.console_)).ok).toBe(true);
    else {
      writeFileSync(join(r.root, ".agenthub/config.local.json"), JSON.stringify({ visuals: { retention_days: 29 } }));
      let reload = await r.console_.request({ t: "settings_reload" });
      expect(reload.ok).toBe(true);
      if (reload.confirmation?.token) reload = await r.console_.request({ t: "settings_reload", confirm: reload.confirmation.token });
      expect(reload.ok).toBe(true); expect(reload.applied).toContain("visuals.retention_days");
    }
    release(); operationalRefusal(await request, /generation, task or policy changed/);
    expect(r.store.list()).toEqual([]); expect(r.receiver.received).toEqual([]);
  } finally { release(); await request; }
});

for (const size of ["tiny", "maximum-table"] as const) test(`ordinary snapshots stay metadata-only for twenty ${size} visuals`, async () => {
  const r = await rig();
  const table = { kind: "table" as const, caption: "public metadata", columns: Array.from({ length: VISUAL_LIMITS.columns }, (_, i) => ({ key: `c${i}`, label: `Column ${i}` })),
    rows: Array.from({ length: VISUAL_LIMITS.rows }, () => Object.fromEntries(Array.from({ length: VISUAL_LIMITS.columns }, (_, i) => [`c${i}`, "BODY-ONLY-MARKER".padEnd(120, "x")])) ) };
  for (let i = 0; i < 20; i++) r.store.insert(size === "tiny" ? { id: randomUUID(), from: "codex", kind: "mermaid", title: "Flow", payload: { ...payload, kind: "mermaid" }, files: [], created: Date.now() }
    : { id: randomUUID(), from: "codex", kind: "table", title: "public metadata", payload: table, files: [], created: Date.now() });
  const originalGet = VisualStore.prototype.get; let gets = 0;
  VisualStore.prototype.get = function(id) { gets++; return originalGet.call(this, id); };
  try {
    for (let i = 0; i < 3; i++) {
      const snapshot = await r.snapshot(); expect(snapshot.visuals).toHaveLength(20);
      expect(JSON.stringify(snapshot.visuals)).not.toContain("BODY-ONLY-MARKER");
      expect(snapshot.visuals.every((row: Record<string, unknown>) => !Object.hasOwn(row, "payload") && !Object.hasOwn(row, "files"))).toBe(true);
    }
    expect(gets).toBe(0);
  } finally { VisualStore.prototype.get = originalGet; }
});

test("metadata projection never deserializes corrupt or oversized payload bodies but still screens title and paths", async () => {
  const r = await rig(), id = await r.post(payload), db = openHubDatabase(join(r.stateDir, "hub.db"));
  try {
    for (const body of ["{broken", "x".repeat(VISUAL_LIMITS.payload + 1)]) {
      db.query("UPDATE visuals SET payload_json=? WHERE id=?").run(body, id);
      expect((await r.snapshot()).visuals.map((row: { id: string }) => row.id)).toContain(id);
      expect((await r.op("hub_visual_show", { id })).ok).toBe(false);
    }
    db.query("UPDATE visuals SET title=? WHERE id=?").run("PRIVATE-VISUAL", id);
    expect((await r.snapshot()).visuals).toEqual([]);
  } finally { db.close(); }
});

test("snapshot policy and metadata reader structurally exclude full config and payload reads", () => {
  const source = readFileSync(join(import.meta.dir, "../src/hub/daemon.ts"), "utf8");
  const start = source.indexOf("  const visualFilePolicy ="), end = source.indexOf("  const visualSafeText =", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  expect(source.slice(start, end)).not.toMatch(/\bloadConfig\s*\(/);
  expect(VisualStore.prototype.list.toString()).not.toContain("payload_json");
});

test("review-observer input holds visual publication with an operational cause and no payload effect", async () => {
  const r = await rig(); let delivered!: () => void;
  const delivery = new Promise<void>(resolve => { delivered = resolve; });
  r.sender.deliver = async envs => { r.sender.received.push(...envs); delivered(); };
  r.daemon.bus.publish(newEnvelope("hub", "synthetic review package", { kind: "review", to: ["codex"], refs: { reviewPackage: "visual-review-fixture" } }));
  await delivery;
  expect(r.daemon.bus.lastDeliveredTo("codex").some(env => env.refs?.reviewPackage === "visual-review-fixture")).toBe(true);
  const result = await r.op("hub_visual", { payload }); operationalRefusal(result, /open review observer scope/);
  expect(r.store.list()).toEqual([]); expect(r.receiver.received).toEqual([]);
});

test("a known rate refusal precedes model screening and image reads and does not consume another admission", async () => {
  let screens = 0;
  const r = await rig(async () => { screens++; return { label: "clear", ms: 0 }; }, undefined, undefined, { limits: { sender_per_min: 1, pair_per_min: 0, important_per_hour: 0, repeat_window_s: 0 } });
  await r.post(payload, { to: "kimi" }); expect(screens).toBe(1);
  for (let i = 0; i < 3; i++) {
    const refused = await r.op("hub_visual", { to: "kimi", payload: { kind: "beforeAfter", before: { path: "missing.png", alt: "before" }, after: { text: "after" } } });
    operationalRefusal(refused, /rate limited/); expect(screens).toBe(1); expect(r.store.list()).toHaveLength(1);
  }
});

for (const cause of ["stopping", "stale-authority", "wrong-owner", "throwing-authority"] as const) test(`production visual actor refuses ${cause} before privacy or effect ports`, () => {
  // Unit evidence only: execute the actual closure; this does not qualify a native child's identity or lifecycle.
  const source = readFileSync(join(import.meta.dir, "../src/hub/daemon.ts"), "utf8");
  const operationalStart = source.indexOf("  const visualOperational ="), operationalEnd = source.indexOf("  type VisualFilePolicy =", operationalStart);
  const toolStart = source.indexOf("  async function visualTool("), actorStart = source.indexOf("    const actor =", toolStart), actorEnd = source.indexOf("    actor(op !==", actorStart);
  expect(operationalStart).toBeGreaterThan(0); expect(operationalEnd).toBeGreaterThan(operationalStart);
  expect(toolStart).toBeGreaterThan(0); expect(actorStart).toBeGreaterThan(toolStart); expect(actorEnd).toBeGreaterThan(actorStart);
  let unexpectedCalls = 0, authorityChecks = 0;
  const unexpected = () => { unexpectedCalls++; throw Error("unexpected later visual port"); };
  const authority = { by: cause === "wrong-owner" ? "kimi" : "codex", current() {
    authorityChecks++;
    if (cause === "stopping" || cause === "wrong-owner") return unexpected();
    if (cause === "throwing-authority") throw Error("PRIVATE-ERROR");
    return false;
  } };
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(operationalStart, operationalEnd) + source.slice(actorStart, actorEnd) + "\nglobalThis.actorUnderTest = actor;");
  const context = { PreEffectToolRefusal, stopping: cause === "stopping", authority, by: "codex", piiTurn: false,
    turns: { get: unexpected }, contextPii: unexpected, visualUnavailable: unexpected, membershipAllowed: unexpected,
    recoveryActive: unexpected, readOnlyPeer: unexpected, may: unexpected, reviewObserverHeld: unexpected,
    bus: new Proxy({}, { get: unexpected }), isReviewObserverExcluded: unexpected,
    actorUnderTest: undefined as unknown as (publishing: boolean) => void };
  runInNewContext(script, context);
  let error: unknown;
  try { context.actorUnderTest(true); } catch (value) { error = value; }
  expect(error).toBeInstanceOf(PreEffectToolRefusal);
  if (!(error instanceof PreEffectToolRefusal)) throw Error("actor did not return a pre-effect refusal");
  expect(error.message).toMatch(cause === "stopping" ? /hub is stopping; wait for the hub to restart and retry/ : /request authority changed; reconnect your current peer session and retry/);
  expect(error.message).not.toContain("PRIVATE-ERROR"); expect(unexpectedCalls).toBe(0);
  expect(authorityChecks).toBe(cause === "stopping" || cause === "wrong-owner" ? 0 : 1);
});

for (const op of ["hub_visual", "hub_visual_show", "hub_task_list"] as const) test(`actual outer stopping guard returns the correct guidance before dispatch: ${op}`, () => {
  const source = readFileSync(join(import.meta.dir, "../src/hub/daemon.ts"), "utf8");
  const start = source.indexOf("  const visualOperational ="), end = source.indexOf("  type VisualFilePolicy =", start);
  const lines = source.split("\n").filter(line => line.trimStart().startsWith("if (stopping && !committedSourceProof &&"));
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start); expect(lines).toHaveLength(1);
  const replies: unknown[] = []; let fallthroughs = 0;
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end) + `\n(function(){${lines[0]}\nfallthrough();})();`);
  runInNewContext(script, { PreEffectToolRefusal, stopping: true, committedSourceProof: false, c: { role: "tools" }, msg: { t: "task", op },
    reply: (value: unknown) => replies.push(value), fallthrough: () => { fallthroughs++; throw Error("unexpected dispatch after stopping guard"); } });
  expect(replies).toEqual([{ ok: false, error: op === "hub_task_list" ? "hub is stopping" : "visual unavailable: hub is stopping; wait for the hub to restart and retry" }]);
  expect(fallthroughs).toBe(0);
});
