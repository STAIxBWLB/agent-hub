import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { BasePeer } from "../src/hub/peers.ts";
import { type Envelope, newEnvelope } from "../src/hub/envelope.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { Board, isClosedTaskState } from "../src/hub/board.ts";
import { DOING_STUB, SESSION_TITLE_HINT, sessionTitleText } from "../src/hub/peer-doing.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { realPath } from "../src/hub/project.ts";
import { gitProject } from "./fakes/git-project.ts";

class TitlePeer extends BasePeer {
  private name = "";
  completion: "completed" | "needs_review" = "completed";
  afterDelivery?: () => void;
  constructor(readonly titleSession = "title-fixture-session", id = "local") { super(id); }
  generation = 0;
  get sessionGeneration() { return this.generation; }
  afterWrite?: () => Promise<void>;
  get sessionTitle() { return this.name; }
  async setSessionTitle(title: string, onlyIfUnnamed: boolean, current?: () => boolean): Promise<{ ok: true } | { ok: false; reason: "already_named" | "invalid" }> {
    if (current?.() === false) return { ok: false, reason: "invalid" };
    if (onlyIfUnnamed && this.name) return { ok: false, reason: "already_named" };
    this.name = title; this.onDoing?.("title", title); await this.afterWrite?.(); return { ok: true };
  }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  hold() { this.setState("busy"); }
  async deliver(_envs: Envelope[], id?: string) {
    this.setState("busy");
    if (id) this.onDelivery?.({ id, state: "accepted" });
    queueMicrotask(() => { if (id) this.onDelivery?.({ id, state: this.completion }); this.setState("idle"); this.afterDelivery?.(); });
  }
}
async function rig(cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-title-"))), session = "title-fixture-session", peerId = "local", options: { instances?: Record<string, { kind: string; start_mode: "headless" }>; roles?: Record<string, string[]> } = {}) {
  const stateDir = join(cwd, ".agenthub/state"); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  gitProject(cwd);
  const configFile = join(cwd, ".agenthub/config.local.json");
  if (!readdirSync(join(cwd, ".agenthub")).includes("config.local.json")) writeFileSync(configFile, '{"instances":{}}\n');
  writeFileSync(join(cwd, ".agenthub/routing.toml"), readFileSync(new URL("../templates/routing.toml", import.meta.url), "utf8").replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"'));
  // Production lifecycle supplies the Registry's stable project id. Omitting it makes startDaemon generate a new randomUUID;
  // journal.get filters by project_id, so reusing the state directory alone would hide every previous delivery on restart.
  const daemon = await startDaemon({ cwd, stateDir, projectId: "session-title-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, ...(options.instances ? { instances: options.instances } : {}), ...(options.roles ? { roles: options.roles } : {}), memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  const peer = new TitlePeer(session, peerId); daemon.bus.add(peer); await peer.start();
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  const agent = await ControlClient.connect(stateDir, { role: "tools", peer: peerId, projectRoot: cwd });
  const status = async () => (await person.request({ t: "status" })).status;
  const title = async (text: string) => { const response = await agent.request({ t: "task", op: "hub_set_title", args: { title: text } }); expect(response.ok).toBe(true); const result = JSON.parse(response.text); if (result.ok === false) { expect(typeof result.error).toBe("string"); expect(result.error.length).toBeGreaterThan(0); } return result; };
  const send = async (body: string) => { const done = new Promise<void>(resolve => { peer.afterDelivery = resolve; }); daemon.bus.publish(newEnvelope("user", body, { to: [peerId] })); await done; };
  return { cwd, stateDir, configFile, daemon, peer, person, agent, status, title, send,
    stop: async (remove = true) => { person.close(); agent.close(); await daemon.stop(); if (remove) rmSync(cwd, { recursive: true, force: true }); } };
}

test("session titles are first-write-final, person-replaceable, screened and independent of board/git/instance records", async () => {
  const f = await rig();
  try {
    const board = new Board(join(f.stateDir, "hub.db"));
    const active = board.propose("user", { title: "Independent active task title", class: "test" });
    board.update(active.id, "user", "fixture active", { owner: "local", state: "in_progress" });
    const before = JSON.stringify(board.list()), config = readFileSync(f.configFile, "utf8"), head = readFileSync(join(f.cwd, ".git/HEAD"), "utf8");
    try {
      expect(await f.title("  Name\nthis session  ")).toEqual({ ok: true });
      expect(await f.title("Another name")).toMatchObject({ ok: false, reason: "already_named" });
      expect((await f.status()).peers.local.doing).toMatchObject({ text: "Name this session", source: "title" });
      expect(await f.person.request({ t: "title", peer: "local", title: "Manual chosen name" })).toMatchObject({ ok: true });
      expect(await f.title("Agent replacement")).toMatchObject({ ok: false, reason: "already_named" });
      expect(f.peer.sessionTitle).toBe("Manual chosen name");
      expect(JSON.stringify(board.list())).toBe(before);
      expect(readFileSync(f.configFile, "utf8")).toBe(config); expect(readFileSync(join(f.cwd, ".git/HEAD"), "utf8")).toBe(head);
      expect(readFileSync(join(f.stateDir, "status.json"), "utf8")).not.toContain("Manual chosen name");
      expect(readFileSync(join(f.stateDir, "hub.log"), "utf8")).not.toContain("Manual chosen name");
      expect(await f.agent.request({ t: "title", peer: "local", title: "forged person" })).toMatchObject({ ok: false });
      expect(await f.person.request({ t: "title", peer: "codex", title: "native" })).toMatchObject({ ok: false, error: expect.stringContaining("own UI") });
      expect(await f.person.request({ t: "title", peer: "missing-peer", title: "unknown" })).toMatchObject({ ok: false, error: "this peer has no hub-owned title slot; choose a Pi/local peer from ahub status or rename its session in its own UI" });
      expect(await f.person.request({ t: "title", peer: "pi", title: "offline" })).toMatchObject({ ok: false, error: expect.stringContaining("start it with ahub pi") });
      expect(await f.person.request({ t: "title", peer: "not a peer", title: "invalid" })).toMatchObject({ ok: false, error: expect.stringContaining("choose") });
    } finally { board.close(); }
  } finally { await f.stop(); }
});

test("unnamed labels come only from acknowledged deliveries and restart from matching ID-only bindings", async () => {
  let f = await rig(undefined, undefined, "pi"); const cwd = f.cwd;
  try {
    const body = "Investigate\nbytecode semantics and complete a carefully bounded public regression for the dispatcher";
    expect((await f.status()).peers.pi.doing).toBeUndefined();
    await f.send(body);
    const doing = (await f.status()).peers.pi.doing;
    const projectId = (await f.status()).projectId;
    expect(doing).toMatchObject({ source: "label", text: "Investigate bytecode semantics and complete a carefully boun" });
    const binding = JSON.parse(readFileSync(join(f.stateDir, "session-title-inputs.json"), "utf8"));
    expect(Object.keys(binding.pi).sort()).toEqual(["delivery", "envelope", "session"]);
    expect(JSON.stringify(binding)).not.toContain("Investigate");
    expect(readFileSync(join(f.stateDir, "status.json"), "utf8")).not.toContain(doing.text);
    await f.stop(false); f = await rig(cwd, undefined, "pi");
    expect((await f.status()).projectId).toBe(projectId);
    expect((await f.status()).peers.pi.doing).toMatchObject({ source: "label", text: doing.text });
    await f.send("Second acknowledged message must not replace the first");
    expect((await f.status()).peers.pi.doing.text).toBe(doing.text);
    await f.stop(false); f = await rig(cwd, "different-title-session", "pi");
    expect((await f.status()).peers.pi.doing).toBeUndefined();
  } finally { await f.stop(); }
});

test("the restart binding file contains only IDs across delivery, naming and session replacement", async () => {
  let f = await rig(undefined, undefined, "pi"); const cwd = f.cwd;
  const body = "BODY_CANARY_1055\nA first message whose normalized display label is separate from its stored source";
  const title = "TITLE_CANARY_1055";
  const canaries = [body, "BODY_CANARY_1055", title];
  const bindingText = (session: string): string => {
    const text = readFileSync(join(f.stateDir, "session-title-inputs.json"), "utf8"), value = JSON.parse(text);
    expect(Object.keys(value)).toEqual(["pi"]);
    expect(value.pi).toEqual({ session, delivery: expect.any(String), envelope: expect.any(String) });
    for (const canary of canaries) expect(text).not.toContain(canary);
    return text;
  };
  try {
    await f.send(body);
    const label = (await f.status()).peers.pi.doing.text;
    expect(label).toContain("BODY_CANARY_1055"); canaries.push(label);
    const firstSession = f.peer.titleSession, beforeNaming = bindingText(firstSession);
    expect(await f.title(title)).toEqual({ ok: true }); expect(f.peer.sessionTitle).toBe(title);
    expect(bindingText(firstSession)).toBe(beforeNaming);
    await f.stop(false); f = await rig(cwd, "replacement-title-session", "pi");
    expect(bindingText(firstSession)).toBe(beforeNaming);
    expect((await f.status()).peers.pi.doing).toBeUndefined();
    const nextBody = "REPLACEMENT_BODY_CANARY_1055\nA later session must receive its own acknowledged source";
    canaries.push(nextBody, "REPLACEMENT_BODY_CANARY_1055");
    await f.send(nextBody);
    const nextLabel = (await f.status()).peers.pi.doing.text;
    expect(nextLabel).toContain("REPLACEMENT_BODY_CANARY_1055"); canaries.push(nextLabel);
    expect(bindingText(f.peer.titleSession)).not.toBe(beforeNaming);
  } finally { await f.stop(); }
});

test("the binding byte ceiling measures its actual formatted representation", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-title-bound-"))), stateDir = join(cwd, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true });
  const bindings = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`pi-p${i}`, { session: "s".repeat(512), delivery: "d".repeat(512), envelope: "e".repeat(512) }]));
  const serialize = () => JSON.stringify(bindings, null, 2) + "\n";
  // Leave less room than one new binding needs. Compact JSON still fits, but the actual writer's representation does not.
  const excess = Buffer.byteLength(serialize()) - (64 * 1024 - 32);
  expect(excess).toBeGreaterThan(0); expect(excess).toBeLessThan(1022);
  // Valid native instance prefixes consume more bytes than the old unknown pN fixture keys.
  const firstCut = Math.min(excess, 511);
  bindings["pi-p40"]!.envelope = bindings["pi-p40"]!.envelope.slice(firstCut);
  bindings["pi-p40"]!.delivery = bindings["pi-p40"]!.delivery.slice(excess - firstCut);
  const before = serialize(), file = join(stateDir, "session-title-inputs.json");
  expect(Buffer.byteLength(before)).toBe(64 * 1024 - 32);
  writeFileSync(file, before, { mode: 0o600 });
  const instances = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`pi-p${i}`, { kind: "pi", start_mode: "headless" as const }]));
  const f = await rig(cwd, undefined, "pi", { instances });
  try {
    await f.send("A public delivery still succeeds when restart binding capacity is full");
    expect((await f.status()).peers.pi.doing.source).toBe("label");
    const after = readFileSync(file, "utf8");
    expect(Buffer.byteLength(after)).toBeLessThanOrEqual(64 * 1024);
    expect(after).toBe(before);
    expect(JSON.parse(after)).not.toHaveProperty("pi");
  } finally { await f.stop(); }
});

test("PII owner and reviewer contexts refuse title writes and show a stub even when no title exists", async () => {
  for (const role of ["owner", "reviewer"] as const) {
    const f = await rig();
    try {
      const board = new Board(join(f.stateDir, "hub.db"));
      try {
        const row = board.propose("user", { title: "private fixture", class: "test", signals: ["pii"] });
        board.update(row.id, "user", "fixture", { state: "in_progress", owner: role === "owner" ? "local" : "codex", reviewer: role === "reviewer" ? "local" : null });
        expect(await f.title("Public-looking title")).toMatchObject({ ok: false, reason: "private", error: expect.any(String) });
        expect(f.peer.sessionTitle).toBe("");
        expect((await f.status()).peers.local.doing.text).toBe(DOING_STUB);
        expect(await f.person.request({ t: "title", peer: "local", title: "Person title" })).toMatchObject({ ok: false, reason: "private", error: expect.stringContaining("finish PII") });
      } finally { board.close(); }
    } finally { await f.stop(); }
  }
});

test("a thrown metadata screen and a PII turn refuse before the title setter (production host closure)", async () => {
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const begin = source.indexOf("  const titleWrites ="), end = source.indexOf("  const observeDoing =", begin);
  const contextLine = source.split("\n").find(line => line.startsWith("  const contextPii ="))!;
  const scopeStart = source.indexOf("  const reviewObserverHeld ="), scopeEnd = source.indexOf("  const invocations =", scopeStart);
  expect(scopeStart).toBeGreaterThan(0); expect(scopeEnd).toBeGreaterThan(scopeStart);
  const peer = new TitlePeer(); await peer.start();
  const privateTitleWrites = new Map(), bus = { peers: new Map([["local", peer]]) };
  const context = { privateTitleWrites, bus, stopping: false, recoveryActive: () => false, definitionOf, readReviewObserverScope: () => undefined,
    sessionTitleText, SESSION_TITLE_HINT, observeDoing: () => {}, turns: new Map(), board: { peerTaskSignals: () => [] }, isClosedTaskState,
    tasks: { publicMetadataText: (): boolean => { throw new Error("metadata screen unavailable"); }, isPii: (task: { signals: string[] }) => task.signals.includes("pii") }, extracted: undefined as unknown };
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`${contextLine}\n${source.slice(scopeStart, scopeEnd)}\n${source.slice(begin, end)}\nglobalThis.extracted=setSessionTitle;`);
  runInNewContext(script, context);
  const set = context.extracted as (peer: string, title: unknown, only: boolean, privateTurn?: boolean) => Promise<unknown>;
  expect(await set("local", "do not write", true)).toMatchObject({ ok: false, reason: "private", error: expect.any(String) });
  expect(privateTitleWrites.get("local")).toBe(peer); expect(peer.sessionTitle).toBe("");
  context.tasks.publicMetadataText = () => true;
  expect(await set("local", "PII turn", true, true)).toMatchObject({ ok: false, reason: "private", error: expect.any(String) });
  expect(peer.sessionTitle).toBe("");
  const nativeWarning = "native write was not confirmed; the title may have been applied; check ahub status before retrying";
  Object.defineProperty(peer, "setSessionTitle", { value: async () => ({ ok: false, reason: "invalid", mayHaveApplied: true, error: nativeWarning }) });
  expect(await set("local", "Public title", true)).toEqual({ ok: false, reason: "invalid", mayHaveApplied: true, error: nativeWarning });
});

test("a positive-ACK fallback binding survives later turn uncertainty without trusting an unbound queue", async () => {
  let f = await rig(undefined, undefined, "pi"); const cwd = f.cwd;
  try {
    f.peer.completion = "needs_review";
    await f.send("First acknowledged request remains the session label after a failed turn");
    const first = (await f.status()).peers.pi.doing;
    const projectId = (await f.status()).projectId;
    expect(first.source).toBe("label");
    const binding = JSON.parse(readFileSync(join(f.stateDir, "session-title-inputs.json"), "utf8"));
    expect(f.daemon.bus.queueList("pi").find(row => row.id === binding.pi.delivery)?.state).toBe("needs_review");
    await f.stop(false); f = await rig(cwd, undefined, "pi");
    expect((await f.status()).projectId).toBe(projectId);
    expect((await f.status()).peers.pi.doing).toMatchObject({ text: first.text, source: "label" });
  } finally { await f.stop(); }
});

test("queued unacknowledged messages never become an unnamed label or title binding", async () => {
  const f = await rig();
  try {
    f.peer.hold();
    f.daemon.bus.publish(newEnvelope("user", "A queued request is not a delivered session label", { to: ["local"] }));
    expect(f.daemon.bus.queued("local")).toBeGreaterThan(0);
    expect((await f.status()).peers.local.doing).toBeUndefined();
    expect(existsSync(join(f.stateDir, "session-title-inputs.json"))).toBe(false);
  } finally { await f.stop(); }
});

test("title refusals expose actionable causes and post-write generation/privacy changes require readback", async () => {
  const f = await rig();
  try {
    const invalid = await f.title("가".repeat(81));
    expect(invalid).toMatchObject({ ok: false, reason: "invalid", error: expect.stringContaining("1-80 normalized") });
    f.peer.afterWrite = async () => { f.peer.generation++; };
    const changed = await f.title("Name may already be applied");
    expect(changed).toMatchObject({ ok: false, reason: "invalid", mayHaveApplied: true });
    expect(changed.error).toContain("may have been applied"); expect(changed.error).toContain("ahub status");
    expect(f.peer.sessionTitle).toBe("Name may already be applied");
    await f.peer.stop();
    expect(await f.title("Offline name")).toMatchObject({ ok: false, reason: "invalid", error: expect.stringContaining("start or reconnect") });
  } finally { await f.stop(); }
  const p = await rig();
  try {
    const board = new Board(join(p.stateDir, "hub.db"));
    try {
      p.peer.afterWrite = async () => { const row = board.propose("user", { title: "private after write", class: "test", signals: ["pii"] }); board.update(row.id, "user", "fixture", { state: "in_progress", owner: "local" }); };
      const changed = await p.title("A public title before the context changed");
      expect(changed).toMatchObject({ ok: false, reason: "private", mayHaveApplied: true });
      expect(changed.error).toContain("may have been applied"); expect(changed.error).toContain("ahub status");
      expect((await p.status()).peers.local.doing.text).toBe(DOING_STUB);
    } finally { board.close(); }
  } finally { await p.stop(); }
});

test("incoming labels are visible only to the console and configured conductor, without peer authorship", async () => {
  const f = await rig(undefined, undefined, "local", { roles: { claude: ["conductor"], codex: ["implementer"] } });
  const clients: ControlClient[] = [];
  try {
    await f.send("PRIVATE_DM_LABEL_CANARY A message sent only to the local worker");
    const person = (await f.status()).peers.local.doing;
    expect(person.text).toContain("PRIVATE_DM_LABEL_CANARY"); expect(person.source).toBe("label"); expect(person.note).toContain("incoming hub message");
    for (const peer of ["local", "codex", "claude"]) {
      const client = await ControlClient.connect(f.stateDir, { role: "tools", peer, projectRoot: f.cwd }); clients.push(client);
      const status = await client.request({ t: "status" });
      if (peer === "claude") {
        expect(status.status.peers.local.doing.text).toContain("PRIVATE_DM_LABEL_CANARY");
        const response = await client.request({ t: "task", op: "hub_status", args: {} }); expect(response.ok).toBe(true);
        const view = JSON.parse(response.text), label = view.peers.find((row: { peer: string }) => row.peer === "local").doing;
        expect(label.text).toContain("PRIVATE_DM_LABEL_CANARY"); expect(label.note).toContain("incoming hub message");
        expect(label).not.toHaveProperty("from"); expect(view).not.toHaveProperty("doingNote");
      } else {
        expect(status.status.peers.local.doing).toMatchObject({ text: "unnamed", source: "label" });
        expect(JSON.stringify(status)).not.toContain("PRIVATE_DM_LABEL_CANARY");
        const denied = await client.request({ t: "task", op: "hub_status", args: {} }); expect(denied.ok).toBe(false);
        expect(JSON.stringify(denied)).not.toContain("PRIVATE_DM_LABEL_CANARY");
      }
    }
  } finally { for (const client of clients) client.close(); await f.stop(); }
});

test("startup drops ephemeral and removed-instance bindings but retains offline known native Pi", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-title-cleanup-"))), stateDir = join(cwd, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true });
  const ids = { session: "saved-session", delivery: "saved-delivery", envelope: "saved-envelope" };
  const file = join(stateDir, "session-title-inputs.json");
  writeFileSync(file, JSON.stringify({ local: ids, "pi-removed": ids, pi: ids }), { mode: 0o600 });
  const f = await rig(cwd);
  try {
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ pi: ids });
    await f.send("A new ephemeral Local session has its own live label");
    expect((await f.status()).peers.local.doing.source).toBe("label");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ pi: ids });
  } finally { await f.stop(); }
});
