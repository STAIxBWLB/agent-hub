import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { createHash } from "node:crypto";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(condition: () => boolean | Promise<boolean>, label: string, timeout = 3500) {
  const deadline = Date.now() + timeout;
  while (!(await condition()) && Date.now() < deadline) await Bun.sleep(15);
  expect(await condition(), label).toBe(true);
}
async function fixture(options: { trackedRouting?: boolean; codex?: boolean; kimi?: boolean; kimiTui?: boolean; roles?: Record<string, string[]>; limits?: boolean; embedded?: boolean; malformedInitial?: boolean } = {}) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-reload-authority-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const file = (name: string) => join(dir, ".agenthub", name);
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  const shared = {
    ...(options.embedded ? {} : { batch_ms: 0 }), roster: { claude: false, codex: !!options.codex, kimi: !!options.kimi, qwen: false, jcode: false, pi: false, local: false },
    memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false },
    snapshots: { enabled: false }, research: { enabled: false }, approvals: { notify: false },
    tasks: { wip_limits: { codex: 1 } }, task_sweep: { enabled: false }, pi: { enabled: false, auto_start: false },
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.limits ? { limits: { sender_per_min: 1, pair_per_min: 0, important_per_hour: 0, repeat_window_s: 0 } } : {}),
  };
  const originalProtocol = join(dir, "known-fake-original.jsonl"), unreviewedProtocol = join(dir, "known-fake-unreviewed.jsonl");
  const fake = (record: string) => [process.execPath, join(import.meta.dir, "fakes/acp-server.ts"), "--record-protocol", record];
  const initialLocal = options.kimi ? { peers: { kimi: { start_mode: options.kimiTui ? "tui" : "headless" } }, kimi_cmd: fake(originalProtocol) } : {};
  writeFileSync(file("config.json"), JSON.stringify(shared));
  if (options.kimi) writeFileSync(file("config.local.json"), JSON.stringify(initialLocal));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8")
    .replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"').replace(/^pii = "local_only"/m, 'pii = "off"');
  writeFileSync(file("routing.toml"), routing);
  git("init", "-q"); git("add", "-f", ".agenthub/config.json", ...(options.trackedRouting === false ? [] : [".agenthub/routing.toml"])); git("commit", "-qm", "authority fixture");
  const embedded = options.embedded ? { ...loadConfig(dir), batch_ms: 0, limits: { sender_per_min: 0, pair_per_min: 0, important_per_hour: 0, repeat_window_s: 0 } } : undefined;
  if (options.malformedInitial) writeFileSync(file("config.local.json"), "{ malformed fixture");
  const daemon = await startDaemon({ cwd: dir, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0, ...(embedded ? { config: embedded } : {}) });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(state, { role: "console" }); cleanup.push(() => client.close());
  const pushes: any[] = []; client.onPush = message => pushes.push(message); client.send({ t: "tail" }); await client.request({ t: "status" });
  const row = async (key: string) => (await client.request({ t: "settings_get" })).rows.find((value: { key: string }) => value.key === key);
  const local = (patch: Record<string, unknown>) => writeFileSync(file("config.local.json"), JSON.stringify({ ...initialLocal, ...patch }));
  const reload = (confirm?: string) => client.request({ t: "settings_reload", ...(confirm ? { confirm } : {}) });
  const set = (key: string, value: unknown) => client.request({ t: "settings_set", key, value, reason: "approve this named setting only" });
  return { dir, state, file, git, shared, routing, daemon, client, pushes, row, local, reload, set, originalProtocol, unreviewedProtocol, fake };
}

test("#439 removing the settled planner is guarded and previews the automatic successor", async () => {
  const f = await fixture({ codex: true, kimi: true, roles: { claude: [], kimi: ["planner"] } });
  const status = async () => (await f.client.request({ t: "status" })).status;
  expect((await status()).planner).toEqual({ peers: ["kimi"], source: "roles" });
  f.local({ roles: { kimi: [] } });
  await until(async () => f.pushes.some(message => message.t === "notice" && String(message.line).includes("roles.kimi")) || JSON.stringify((await status()).planner.peers) !== JSON.stringify(["kimi"]), "watcher processes planner withdrawal");
  expect((await status()).planner).toEqual({ peers: ["kimi"], source: "roles" });
  const preview = await f.reload();
  expect(preview.ok).toBe(true);
  expect(preview.rejected.some((entry: { key: string }) => entry.key === "roles.kimi")).toBe(true);
  expect(preview.confirmation.keys).toContain("roles.kimi");
  const change = preview.confirmation.changes.find((entry: { key: string }) => entry.key === "roles.kimi");
  expect(JSON.parse(change.before)).toEqual(["planner"]);
  expect(JSON.parse(change.after)).toEqual([]);
  expect(change.effect).toContain("planner"); expect(change.effect).toContain("kimi"); expect(change.effect).toContain("codex");
  expect((await status()).planner.peers).toEqual(["kimi"]);
  const confirmed = await f.reload(preview.confirmation.token);
  expect(confirmed.ok, String(confirmed.error)).toBe(true);
  expect((await status()).planner).toEqual({ peers: ["codex"], source: "automatic" });
}, 15_000);

test("#439 removing the conductor remains guarded even when its role list only shrinks", async () => {
  const f = await fixture({ codex: true, kimi: true, kimiTui: true, roles: { claude: [], codex: ["planner"], kimi: ["conductor", "reviewer"] } });
  // An authenticated in-process bridge makes role status observable; it launches no native CLI or model.
  const peer = await ControlClient.connect(f.state, { role: "peer", peer: "kimi", channel: false }); cleanup.push(() => peer.close());
  const roles = async () => (await f.client.request({ t: "status" })).status.roleInfo.kimi.flowRoles as string[];
  expect(await roles()).toContain("conductor");
  f.local({ roles: { kimi: ["reviewer"] } });
  await until(async () => f.pushes.some(message => message.t === "notice" && String(message.line).includes("roles.kimi")) || !(await roles()).includes("conductor"), "watcher processes conductor withdrawal");
  expect(await roles()).toContain("conductor");
  const preview = await f.reload();
  expect(preview.ok).toBe(true);
  expect(preview.confirmation.keys).toContain("roles.kimi");
  const change = preview.confirmation.changes.find((entry: { key: string }) => entry.key === "roles.kimi");
  expect(JSON.parse(change.before)).toEqual(["conductor", "reviewer"]);
  expect(JSON.parse(change.after)).toEqual(["reviewer"]);
  expect(change.effect).toContain("conductor"); expect(change.effect).toContain("kimi");
  expect((await f.reload(preview.confirmation.token)).ok).toBe(true);
  expect(await roles()).toEqual(["reviewer"]);
}, 15_000);

test("#439 nonholder role subsets still tighten automatically without acquiring authority", async () => {
  const f = await fixture({ codex: true, kimi: true, kimiTui: true, roles: { claude: [], codex: ["planner"], kimi: ["reviewer", "implementer"] } });
  const peer = await ControlClient.connect(f.state, { role: "peer", peer: "kimi", channel: false }); cleanup.push(() => peer.close());
  const status = async () => (await f.client.request({ t: "status" })).status;
  f.local({ roles: { kimi: ["reviewer"] } });
  await until(async () => JSON.stringify((await status()).roleInfo.kimi.flowRoles) === JSON.stringify(["reviewer"]), "ordinary role reduction applies through watcher");
  const reloaded = await f.reload();
  expect(reloaded.ok).toBe(true);
  expect(reloaded.confirmation).toBeUndefined();
  expect((await status()).planner).toEqual({ peers: ["codex"], source: "roles" });
}, 15_000);

test("#439 command confirmation displays complete old and new argv as parseable JSON", async () => {
  const f = await fixture({ kimi: true });
  const before = f.fake(f.originalProtocol);
  const after = [...f.fake(f.unreviewedProtocol), "--fixture-label", "argument with spaces and literal quotes: 'safe'"];
  f.local({ kimi_cmd: after });
  const preview = await f.reload();
  expect(preview.ok).toBe(true);
  expect(preview.confirmation.keys).toContain("kimi_cmd");
  const change = preview.confirmation.changes.find((entry: { key: string }) => entry.key === "kimi_cmd");
  expect(JSON.parse(change.before)).toEqual(before);
  expect(JSON.parse(change.after)).toEqual(after);
  expect(existsSync(f.originalProtocol)).toBe(false);
  expect(existsSync(f.unreviewedProtocol)).toBe(false);
}, 15_000);

test("#439 command previews over 16 KiB are rejected per key and never made confirmable", async () => {
  const f = await fixture({ kimi: true });
  // Every argument is individually valid. Only the aggregate serialized preview exceeds its display bound.
  const after = [...f.fake(f.unreviewedProtocol), ...Array.from({ length: 500 }, (_, index) => `argument-${index}-${"x".repeat(40)}`)];
  expect(JSON.stringify(after).length).toBeGreaterThan(16 * 1024);
  f.local({ kimi_cmd: after, research: { enabled: true } });
  const preview = await f.reload();
  expect(preview.ok).toBe(true);
  expect(preview.rejected.some((entry: { key: string; reason: string }) => entry.key === "kimi_cmd" && /bound|large|16|preview/i.test(entry.reason))).toBe(true);
  expect(preview.confirmation?.keys ?? []).not.toContain("kimi_cmd");
  expect((await f.row("research.enabled")).value).toBe(true);
  expect(existsSync(f.originalProtocol)).toBe(false);
  expect(existsSync(f.unreviewedProtocol)).toBe(false);
}, 15_000);

for (const trackedRouting of [true, false]) {
  test(`#439 privacy tightening in ${trackedRouting ? "tracked" : "untracked"} routing is adopted by the watcher`, async () => {
    const f = await fixture({ trackedRouting });
    const title = "private 900101-1234567";
    expect((await f.client.request({ t: "task", op: "hub_task_propose", args: { title, class: "implement" } })).ok).toBe(true);
    const publicTitle = async () => (await f.client.request({ t: "ui_snapshot", after: 0 })).tasks.find((task: { id: number }) => task.id === 1).title;
    expect(await publicTitle()).not.toBe("[pii]");
    writeFileSync(f.file("routing.toml"), f.routing.replace(/^pii = "off"/m, 'pii = "local_only"'));
    await until(async () => await publicTitle() === "[pii]", "watcher applies stricter privacy without terminal authority");
    expect((await f.set("research.enabled", true)).ok).toBe(true);
    expect((await f.row("research.enabled")).value).toBe(true);
    expect(await publicTitle()).toBe("[pii]");
  }, 15_000);
}

test("#439 rejected tracked guarded edit does not wedge unrelated safe named writes", async () => {
  const f = await fixture();
  writeFileSync(f.file("config.json"), JSON.stringify({ ...f.shared, tasks: { wip_limits: { codex: 5 } } }));
  const result = await f.reload();
  expect(result.ok).toBe(true);
  expect(result.rejected.some((entry: { key: string }) => entry.key.includes("tasks.wip_limits.codex"))).toBe(true);
  expect(result.confirmation).toBeUndefined();
  expect((await f.row("tasks.wip_limits.codex")).value).toBe(1);
  expect((await f.set("research.enabled", true)).ok).toBe(true);
  expect((await f.row("research.enabled")).value).toBe(true);
  expect((await f.row("tasks.wip_limits.codex")).value).toBe(1);
  expect((await f.client.request({ t: "settings_undo", reason: "undo the safe change" })).ok).toBe(true);
  expect((await f.row("research.enabled")).value).toBe(false);
  expect((await f.row("tasks.wip_limits.codex")).value).toBe(1);
}, 15_000);

test("#439 named write and undo cannot authorize unrelated WIP or executable changes", async () => {
  const f = await fixture({ kimi: true });
  // Both alternatives are the repository's known fake ACP agent, never arbitrary code. The recording path identifies
  // which command the real start path consumed if an unrelated setting accidentally launders the agent's edit.
  f.local({ tasks: { wip_limits: { codex: 5 } }, kimi_cmd: f.fake(f.unreviewedProtocol) });
  const preview = await f.client.request({ t: "settings_preview", key: "research.enabled", value: true });
  expect(preview.ok).toBe(true);
  expect((await f.set("research.enabled", true)).ok).toBe(true);
  expect((await f.row("research.enabled")).value).toBe(true);
  expect((await f.row("tasks.wip_limits.codex")).value).toBe(1);
  expect((await f.client.request({ t: "settings_undo", reason: "undo only research" })).ok).toBe(true);
  expect((await f.row("research.enabled")).value).toBe(false);
  expect((await f.row("tasks.wip_limits.codex")).value).toBe(1);
  const started = await f.client.request({ t: "peer_start", peer: "kimi" });
  expect(started.ok, String(started.error)).toBe(true);
  await until(() => existsSync(f.originalProtocol), "only the original approved fake receives initialize");
  expect(existsSync(f.unreviewedProtocol)).toBe(false);
}, 15_000);

test("#439 explicit reload previews exact guarded keys and requires its token before applying them", async () => {
  const f = await fixture();
  f.local({ tasks: { wip_limits: { codex: 5 } } });
  const preview = await f.reload();
  expect(preview.ok).toBe(true);
  expect(typeof preview.confirmation?.token).toBe("string");
  expect(preview.confirmation.keys).toContain("tasks.wip_limits.codex");
  expect((await f.row("tasks.wip_limits.codex")).value).toBe(1);
  const confirmed = await f.reload(preview.confirmation.token);
  expect(confirmed.ok, String(confirmed.error)).toBe(true);
  expect(confirmed.confirmation).toBeUndefined();
  expect((await f.row("tasks.wip_limits.codex")).value).toBe(5);
}, 15_000);

test("#439 reload confirmation refuses changed candidate bytes and cannot authorize new guarded keys", async () => {
  const f = await fixture();
  f.local({ tasks: { wip_limits: { codex: 5 } } });
  const first = await f.reload();
  expect(typeof first.confirmation?.token).toBe("string");
  f.local({ tasks: { wip_limits: { codex: 6 } }, limits: { sender_per_min: 500 } });
  const stale = await f.reload(first.confirmation.token);
  expect(stale.ok).toBe(false);
  expect(String(stale.error)).toMatch(/stale|changed|confirmation/i);
  expect((await f.row("tasks.wip_limits.codex")).value).toBe(1);
  const fresh = await f.reload();
  expect(fresh.ok).toBe(true);
  expect(fresh.confirmation.token).not.toBe(first.confirmation.token);
  expect(fresh.confirmation.keys).toContain("tasks.wip_limits.codex");
  expect(fresh.confirmation.keys).toContain("limits.sender_per_min");
}, 15_000);

test("#439 confirmation cannot make a tracked machine-local declaration trusted", async () => {
  const f = await fixture();
  f.local({ tasks: { wip_limits: { codex: 5 } } });
  const preview = await f.reload();
  expect(typeof preview.confirmation?.token).toBe("string");
  writeFileSync(f.file("config.json"), JSON.stringify({ ...f.shared, kimi_cmd: f.fake(f.unreviewedProtocol) }));
  const stale = await f.reload(preview.confirmation.token);
  expect(stale.ok).toBe(false);
  const fresh = await f.reload();
  expect(fresh.ok).toBe(true);
  expect(fresh.rejected.some((entry: { key: string; reason: string }) => entry.key.includes("kimi_cmd") && /tracked|committed/i.test(entry.reason))).toBe(true);
  expect(fresh.confirmation?.keys ?? []).not.toContain("kimi_cmd");
  if (fresh.confirmation) expect((await f.reload(fresh.confirmation.token)).ok).toBe(true);
  expect(existsSync(f.unreviewedProtocol)).toBe(false);
}, 15_000);

test("#439 non-registry rate-limit relaxation remains guarded until explicit confirmation", async () => {
  const f = await fixture({ limits: true });
  class Sink extends BasePeer {
    async start() { this.setState("idle"); }
    async stop() { this.setState("offline"); }
    async deliver() {}
  }
  const sink = new Sink("reload-sink"); f.daemon.bus.add(sink); await sink.start();
  const as = async (peer: string) => { const client = await ControlClient.connect(f.state, { role: "tools", peer }); cleanup.push(() => client.close()); return client; };
  const send = (client: ControlClient, body: string) => client.request({ t: "send", to: ["reload-sink"], body });
  f.local({ limits: { sender_per_min: 500 } });
  const preview = await f.reload();
  expect(preview.ok).toBe(true);
  expect(preview.confirmation.keys).toContain("limits.sender_per_min");
  const before = await as("reload-before");
  expect((await send(before, "first message")).ok).toBe(true);
  const blocked = await send(before, "second distinct message");
  expect(blocked.ok).toBe(false); expect(String(blocked.error)).toContain("rate limited");
  expect((await f.reload(preview.confirmation.token)).ok).toBe(true);
  const after = await as("reload-after");
  expect((await send(after, "first after confirmation")).ok).toBe(true);
  expect((await send(after, "second after confirmation")).ok).toBe(true);
}, 15_000);

for (const malformedInitial of [false, true]) {
  test(`#439 embedded zero limits and batching survive ${malformedInitial ? "repair of an initially malformed file" : "first unrelated local file appearance"}`, async () => {
    const f = await fixture({ embedded: true, malformedInitial });
    class Sink extends BasePeer {
      received = 0;
      async start() { this.setState("idle"); }
      async stop() { this.setState("offline"); }
      async deliver() { this.received++; }
    }
    const sink = new Sink("embedded-sink"); f.daemon.bus.add(sink); await sink.start();
    const sender = await ControlClient.connect(f.state, { role: "tools", peer: "embedded-sender" }); cleanup.push(() => sender.close());
    f.local({ research: { enabled: true } });
    const result = await f.reload();
    expect(result.ok, String(result.error)).toBe(true);
    expect(result.confirmation).toBeUndefined();
    expect((await f.row("research.enabled")).value).toBe(true);
    for (const body of ["first embedded message", "second embedded message"]) {
      expect((await sender.request({ t: "send", to: [sink.id], body })).ok).toBe(true);
    }
    await until(() => sink.received >= 1, "embedded batch_ms=0 delivers without the file default window", 1000);

    // An explicit file declaration may replace the embedding, but deleting that declaration restores the
    // original embedding, not loadConfig's project defaults. Confirmation remains required wherever classified.
    f.local({ research: { enabled: true }, batch_ms: 5000, limits: { sender_per_min: 1 } });
    const explicit = await f.reload();
    expect(explicit.ok, String(explicit.error)).toBe(true);
    if (explicit.confirmation) expect((await f.reload(explicit.confirmation.token)).ok).toBe(true);
    const changedSender = await ControlClient.connect(f.state, { role: "tools", peer: "explicit-sender" }); cleanup.push(() => changedSender.close());
    expect((await changedSender.request({ t: "send", to: [sink.id], body: "held by explicit batch" })).ok).toBe(true);
    const limited = await changedSender.request({ t: "send", to: [sink.id], body: "blocked by explicit limit" });
    expect(limited.ok).toBe(false); expect(String(limited.error)).toContain("rate limited");
    expect(f.daemon.bus.queued(sink.id)).toBeGreaterThan(0);
    f.local({ research: { enabled: true } });
    const restored = await f.reload();
    expect(restored.ok, String(restored.error)).toBe(true);
    if (restored.confirmation) expect((await f.reload(restored.confirmation.token)).ok).toBe(true);
    // A reload retains the old batch timer; the restored value belongs to a new batch.
    expect(f.daemon.bus.queued(sink.id)).toBeGreaterThan(0);
    const nextSink = new Sink("embedded-next-sink"); f.daemon.bus.add(nextSink); await nextSink.start();
    for (const body of ["first embedded after removal", "second embedded after removal"]) expect((await changedSender.request({ t: "send", to: [nextSink.id], body })).ok).toBe(true);
    await until(() => nextSink.received > 0, "removing explicit batching restores the next embedded batch", 1000);
  }, 15_000);
}

test("#439 named inherit cannot adopt an unapproved tracked value hidden by a local overlay", async () => {
  const f = await fixture();
  expect((await f.set("tasks.wip_limits.codex", 1)).ok).toBe(true);
  writeFileSync(f.file("config.json"), JSON.stringify({ ...f.shared, tasks: { wip_limits: { codex: 5 } } }));
  const status = (await f.client.request({ t: "status" })).status;
  await f.client.request({ t: "ui_action", instanceId: status.instanceId, action: { action: "setting_reload" } });
  const result = await f.set("tasks.wip_limits.codex", null);
  expect(result.ok).toBe(false);
  expect((await f.row("tasks.wip_limits.codex")).value).toBe(1);
  expect(JSON.parse(readFileSync(f.file("config.local.json"), "utf8")).tasks.wip_limits.codex).toBe(1);
}, 15_000);

test("#439 generic reload cannot bypass the confirmed roster lifecycle even for a removal", async () => {
  const f = await fixture({ kimi: true });
  f.local({ roster: { kimi: false }, research: { enabled: true } });
  const result = await f.reload();
  expect(result.ok).toBe(true);
  expect(result.rejected.some((row: { key: string }) => row.key === "roster.kimi")).toBe(true);
  expect(result.confirmation?.keys ?? []).not.toContain("roster.kimi");
  expect(f.daemon.bus.isRostered("kimi")).toBe(true);
  expect((await f.row("research.enabled")).value).toBe(true);
  expect((await f.client.request({ t: "settings_set", key: "roster.kimi", value: false, confirm: "kimi" })).ok).toBe(true);
  expect(f.daemon.bus.isRostered("kimi")).toBe(false);
}, 15_000);

test("#439 nested routing extension keys cannot traverse an object prototype during reload planning", async () => {
  const f = await fixture();
  const prototype = Object.prototype as Record<string, unknown>;
  const prior = Object.getOwnPropertyDescriptor(prototype, "reload439Proof");
  Object.defineProperty(prototype, "reload439Proof", { value: "retained", writable: true, configurable: true });
  try {
    f.local({ research: { enabled: true } });
    f.git("rm", "--cached", "-f", ".agenthub/routing.toml");
    writeFileSync(f.file("routing.toml"), f.routing + '\n[targets.dsv4f.extra.__proto__]\nreload439Proof = "mutated"\n');
    const preview = await f.reload();
    expect(preview.ok).toBe(false);
    expect(String(preview.error)).toMatch(/invalid|unknown|unsafe/i);
    expect(preview.confirmation).toBeUndefined();
    expect((await f.row("research.enabled")).value).toBe(false);
    expect(Object.hasOwn(prototype, "reload439Proof")).toBe(true);
    expect(prototype.reload439Proof).toBe("retained");
  } finally {
    if (prior) Object.defineProperty(prototype, "reload439Proof", prior);
    else delete prototype.reload439Proof;
  }
}, 15_000);

test("#439 confirmed routing dictionaries preserve quoted route names containing dots", async () => {
  const f = await fixture();
  f.git("rm", "--cached", "-f", ".agenthub/routing.toml");
  writeFileSync(f.file("routing.toml"), f.routing + '\n[routes."sy/model.v1"]\ntype = "passthrough"\ntarget = "dsv4f"\n');
  const preview = await f.reload();
  expect(preview.ok).toBe(true);
  expect(preview.confirmation?.keys).toContain("routing.routes");
  expect((await f.row("routing.classes.implement.route")).values).not.toContain("sy/model.v1");
  expect((await f.reload(preview.confirmation.token)).ok).toBe(true);
  expect((await f.row("routing.classes.implement.route")).values).toContain("sy/model.v1");
}, 15_000);

test("#439 undo preview cannot undo a different key written by another console", async () => {
  const f = await fixture();
  expect((await f.set("research.enabled", true)).ok).toBe(true);
  const preview = await f.client.request({ t: "settings_preview", undo: true });
  expect(preview.ok).toBe(true);
  const oldRecord = readFileSync(join(f.state, "settings-undo.json"), "utf8");
  // The fallback reaches the actual stale-undo effect on the pre-fix daemon rather than failing only on
  // missing reply metadata. The reply's identity contract is asserted separately below.
  const oldDigest = preview.undoDigest ?? createHash("sha256").update(oldRecord).digest("hex");
  const other = await ControlClient.connect(f.state, { role: "console" }); cleanup.push(() => other.close());
  expect((await other.request({ t: "settings_set", key: "snapshots.enabled", value: true, reason: "another person's console" })).ok).toBe(true);
  const localBefore = readFileSync(f.file("config.local.json"), "utf8");
  const undoBefore = readFileSync(join(f.state, "settings-undo.json"), "utf8");
  const stale = await f.client.request({ t: "settings_undo", key: preview.key ?? "research.enabled", undoDigest: oldDigest });
  expect(stale.ok).toBe(false);
  expect(String(stale.error)).toContain("changed");
  expect((await f.row("research.enabled")).value).toBe(true);
  expect((await f.row("snapshots.enabled")).value).toBe(true);
  expect(readFileSync(f.file("config.local.json"), "utf8")).toBe(localBefore);
  expect(readFileSync(join(f.state, "settings-undo.json"), "utf8")).toBe(undoBefore);
  expect(preview.key).toBe("research.enabled");
  expect(preview.undoDigest).toMatch(/^[a-f0-9]{64}$/);
}, 15_000);

test("#439 undo identity distinguishes replacement records for the same key and keeps legacy clients working", async () => {
  const f = await fixture();
  expect((await f.set("research.enabled", true)).ok).toBe(true);
  const oldPreview = await f.client.request({ t: "settings_preview", undo: true });
  expect(oldPreview.ok).toBe(true);
  const oldDigest = oldPreview.undoDigest ?? createHash("sha256").update(readFileSync(join(f.state, "settings-undo.json"))).digest("hex");
  const other = await ControlClient.connect(f.state, { role: "console" }); cleanup.push(() => other.close());
  expect((await other.request({ t: "settings_set", key: "research.enabled", value: false, reason: "replace this key's undo record" })).ok).toBe(true);
  const localBefore = readFileSync(f.file("config.local.json"), "utf8");
  const undoBefore = readFileSync(join(f.state, "settings-undo.json"), "utf8");
  const stale = await f.client.request({ t: "settings_undo", key: "research.enabled", undoDigest: oldDigest });
  expect(stale.ok).toBe(false);
  expect(String(stale.error)).toContain("changed");
  expect((await f.row("research.enabled")).value).toBe(false);
  expect(readFileSync(f.file("config.local.json"), "utf8")).toBe(localBefore);
  expect(readFileSync(join(f.state, "settings-undo.json"), "utf8")).toBe(undoBefore);
  expect(oldPreview.undoDigest).toMatch(/^[a-f0-9]{64}$/);
  const fresh = await f.client.request({ t: "settings_preview", undo: true });
  expect(fresh.ok).toBe(true); expect(fresh.key).toBe("research.enabled");
  expect(fresh.undoDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(fresh.undoDigest).not.toBe(oldDigest);
  expect((await f.client.request({ t: "settings_undo", key: fresh.key, undoDigest: fresh.undoDigest })).ok).toBe(true);
  expect((await f.row("research.enabled")).value).toBe(true);
  // Protocol 16 clients that supplied neither identity field retain their existing immediate-undo operation.
  expect((await f.set("research.enabled", false)).ok).toBe(true);
  expect((await f.client.request({ t: "settings_undo" })).ok).toBe(true);
  expect((await f.row("research.enabled")).value).toBe(true);
}, 15_000);

test("#439 partial or malformed undo identity refuses without consuming the current record", async () => {
  const f = await fixture();
  expect((await f.set("research.enabled", true)).ok).toBe(true);
  const localBefore = readFileSync(f.file("config.local.json"), "utf8");
  const undoBefore = readFileSync(join(f.state, "settings-undo.json"), "utf8");
  const digest = createHash("sha256").update(undoBefore).digest("hex");
  for (const identity of [
    { key: "research.enabled" }, { undoDigest: digest },
    { key: 3, undoDigest: digest }, { key: "", undoDigest: digest },
    { key: "research.enabled", undoDigest: "not-a-digest" }, { key: "research.enabled", undoDigest: null },
  ]) {
    expect((await f.client.request({ t: "settings_undo", ...identity })).ok).toBe(false);
    expect((await f.row("research.enabled")).value).toBe(true);
    expect(readFileSync(f.file("config.local.json"), "utf8")).toBe(localBefore);
    expect(readFileSync(join(f.state, "settings-undo.json"), "utf8")).toBe(undoBefore);
  }
  expect((await f.client.request({ t: "settings_undo" })).ok).toBe(true);
  expect((await f.row("research.enabled")).value).toBe(false);
}, 15_000);
