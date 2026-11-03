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
  constructor(readonly titleSession = "title-fixture-session") { super("local"); }
  get sessionTitle() { return this.name; }
  async setSessionTitle(title: string, onlyIfUnnamed: boolean, current?: () => boolean): Promise<{ ok: true } | { ok: false; reason: "already_named" | "invalid" }> {
    if (current?.() === false) return { ok: false, reason: "invalid" };
    if (onlyIfUnnamed && this.name) return { ok: false, reason: "already_named" };
    this.name = title; this.onDoing?.("title", title); return { ok: true };
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
async function rig(cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-title-"))), session = "title-fixture-session") {
  const stateDir = join(cwd, ".agenthub/state"); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  gitProject(cwd);
  const configFile = join(cwd, ".agenthub/config.local.json");
  if (!readdirSync(join(cwd, ".agenthub")).includes("config.local.json")) writeFileSync(configFile, '{"instances":{}}\n');
  writeFileSync(join(cwd, ".agenthub/routing.toml"), readFileSync(new URL("../templates/routing.toml", import.meta.url), "utf8").replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"'));
  // Production lifecycle supplies the Registry's stable project id. Omitting it makes startDaemon generate a new randomUUID;
  // journal.get filters by project_id, so reusing the state directory alone would hide every previous delivery on restart.
  const daemon = await startDaemon({ cwd, stateDir, projectId: "session-title-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  const peer = new TitlePeer(session); daemon.bus.add(peer); await peer.start();
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  const agent = await ControlClient.connect(stateDir, { role: "tools", peer: "local", projectRoot: cwd });
  const status = async () => (await person.request({ t: "status" })).status;
  const title = async (text: string) => { const response = await agent.request({ t: "task", op: "hub_set_title", args: { title: text } }); expect(response.ok).toBe(true); return JSON.parse(response.text); };
  const send = async (body: string) => { const done = new Promise<void>(resolve => { peer.afterDelivery = resolve; }); daemon.bus.publish(newEnvelope("user", body, { to: ["local"] })); await done; };
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
      expect(await f.title("Another name")).toEqual({ ok: false, reason: "already_named" });
      expect((await f.status()).peers.local.doing).toMatchObject({ text: "Name this session", source: "title" });
      expect(await f.person.request({ t: "title", peer: "local", title: "Manual chosen name" })).toMatchObject({ ok: true });
      expect(await f.title("Agent replacement")).toEqual({ ok: false, reason: "already_named" });
      expect(f.peer.sessionTitle).toBe("Manual chosen name");
      expect(JSON.stringify(board.list())).toBe(before);
      expect(readFileSync(f.configFile, "utf8")).toBe(config); expect(readFileSync(join(f.cwd, ".git/HEAD"), "utf8")).toBe(head);
      expect(readFileSync(join(f.stateDir, "status.json"), "utf8")).not.toContain("Manual chosen name");
      expect(readFileSync(join(f.stateDir, "hub.log"), "utf8")).not.toContain("Manual chosen name");
      expect(await f.agent.request({ t: "title", peer: "local", title: "forged person" })).toMatchObject({ ok: false });
      expect(await f.person.request({ t: "title", peer: "codex", title: "native" })).toMatchObject({ ok: false, error: expect.stringContaining("own UI") });
      expect(await f.person.request({ t: "title", peer: "pi", title: "offline" })).toMatchObject({ ok: false, error: expect.stringContaining("start it with ahub pi") });
      expect(await f.person.request({ t: "title", peer: "not a peer", title: "invalid" })).toMatchObject({ ok: false, error: expect.stringContaining("choose") });
    } finally { board.close(); }
  } finally { await f.stop(); }
});

test("unnamed labels come only from acknowledged deliveries and restart from matching ID-only bindings", async () => {
  let f = await rig(); const cwd = f.cwd;
  try {
    const body = "Investigate\nbytecode semantics and complete a carefully bounded public regression for the dispatcher";
    expect((await f.status()).peers.local.doing).toBeUndefined();
    await f.send(body);
    const doing = (await f.status()).peers.local.doing;
    const projectId = (await f.status()).projectId;
    expect(doing).toMatchObject({ source: "label", text: "Investigate bytecode semantics and complete a carefully boun" });
    const binding = JSON.parse(readFileSync(join(f.stateDir, "session-title-inputs.json"), "utf8"));
    expect(Object.keys(binding.local).sort()).toEqual(["delivery", "envelope", "session"]);
    expect(JSON.stringify(binding)).not.toContain("Investigate");
    expect(readFileSync(join(f.stateDir, "status.json"), "utf8")).not.toContain(doing.text);
    await f.stop(false); f = await rig(cwd);
    expect((await f.status()).projectId).toBe(projectId);
    expect((await f.status()).peers.local.doing).toMatchObject({ source: "label", text: doing.text });
    await f.send("Second acknowledged message must not replace the first");
    expect((await f.status()).peers.local.doing.text).toBe(doing.text);
    await f.stop(false); f = await rig(cwd, "different-title-session");
    expect((await f.status()).peers.local.doing).toBeUndefined();
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
        expect(await f.title("Public-looking title")).toEqual({ ok: false, reason: "private" });
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
  const peer = new TitlePeer(); await peer.start();
  const privateTitleWrites = new Map(), bus = { peers: new Map([["local", peer]]) };
  const context = { privateTitleWrites, bus, stopping: false, recoveryActive: () => false, definitionOf,
    sessionTitleText, SESSION_TITLE_HINT, observeDoing: () => {}, turns: new Map(), board: { peerTaskSignals: () => [] }, isClosedTaskState,
    tasks: { publicMetadataText: (): boolean => { throw new Error("metadata screen unavailable"); }, isPii: (task: { signals: string[] }) => task.signals.includes("pii") }, extracted: undefined as unknown };
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`${contextLine}\n${source.slice(begin, end)}\nglobalThis.extracted=setSessionTitle;`);
  runInNewContext(script, context);
  const set = context.extracted as (peer: string, title: unknown, only: boolean, privateTurn?: boolean) => Promise<unknown>;
  expect(await set("local", "do not write", true)).toEqual({ ok: false, reason: "private" });
  expect(privateTitleWrites.get("local")).toBe(peer); expect(peer.sessionTitle).toBe("");
  context.tasks.publicMetadataText = () => true;
  expect(await set("local", "PII turn", true, true)).toEqual({ ok: false, reason: "private" });
  expect(peer.sessionTitle).toBe("");
});

test("a positive-ACK fallback binding survives later turn uncertainty without trusting an unbound queue", async () => {
  let f = await rig(); const cwd = f.cwd;
  try {
    f.peer.completion = "needs_review";
    await f.send("First acknowledged request remains the session label after a failed turn");
    const first = (await f.status()).peers.local.doing;
    const projectId = (await f.status()).projectId;
    expect(first.source).toBe("label");
    const binding = JSON.parse(readFileSync(join(f.stateDir, "session-title-inputs.json"), "utf8"));
    expect(f.daemon.bus.queueList("local").find(row => row.id === binding.local.delivery)?.state).toBe("needs_review");
    await f.stop(false); f = await rig(cwd);
    expect((await f.status()).projectId).toBe(projectId);
    expect((await f.status()).peers.local.doing).toMatchObject({ text: first.text, source: "label" });
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
