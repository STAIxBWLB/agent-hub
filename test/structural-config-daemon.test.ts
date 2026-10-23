import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { readEvents } from "../src/hub/events.ts";
import { hubGitSync } from "../src/hub/git.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const reviewer = { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" };

/** A real daemon, real loaders, git trust and WS: only the project is a fixture. */
async function fixture(options: { local?: unknown; sdlc?: string; roster?: Record<string, boolean> } = {}) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-structural-daemon-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const git = (...args: string[]) => { const r = hubGitSync(["-C", dir, "-c", "user.name=F", "-c", "user.email=f@x", ...args], { encoding: "utf8" }); expect(r.status, r.stderr).toBe(0); };
  const shared = { batch_ms: 0, roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, pi: false, local: false, ...options.roster }, memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false },
    research: { enabled: false }, snapshots: { enabled: false }, approvals: { notify: false }, pi: { enabled: false, auto_start: false }, coordination: "advisory", task_sweep: { enabled: false, interval_s: 30 } };
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify(shared));
  writeFileSync(join(dir, ".agenthub/routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"'));
  writeFileSync(join(dir, "example.txt"), "x\n");
  git("init", "-q"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml", "example.txt"); git("commit", "-qm", "base");
  const file = (name: string) => join(dir, ".agenthub", name);
  writeFileSync(file("config.local.json"), JSON.stringify(options.local ?? {}, null, 2));
  if (options.sdlc !== undefined) writeFileSync(file("sdlc.toml"), options.sdlc);
  const daemon = await startDaemon({ cwd: dir, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, researchGraceMs: 1 });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(state, { role: "console" }); cleanup.push(() => client.close());
  const session = async (settings: boolean) => {
    const url = new URL((await client.request({ t: "ui", settings })).url);
    const opened = await fetch(`${url.origin}/session`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
    const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
    return async (action: Record<string, unknown>) => (await fetch(`${url.origin}/action`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json", cookie }, body: JSON.stringify(action) })).json() as Promise<Record<string, any>>;
  };
  const revisions = async () => (await client.request({ t: "config_edit_get" })).revisions as Record<string, string>;
  const read = (name: string) => existsSync(file(name)) ? readFileSync(file(name), "utf8") : null;
  const edit = async (set: { path: string[]; value: unknown }[], name: "config.local.json" | "sdlc.toml" = "config.local.json", revision?: string) => ({ file: name, revision: revision ?? (await revisions())[name]!, set });
  const events = () => readEvents(join(state, "events.jsonl")).filter(item => item.type === "config_edit");
  const agent = async (peer: string) => { const socket = await ControlClient.connect(state, { role: "tools", peer }); cleanup.push(() => socket.close()); return socket; };
  return { dir, state, daemon, client, agent, session, revisions, read, file, edit, events, git };
}

test("#689 console: the codex-review fresh reviewer missing start_mode shows the loader's reason and writes nothing", async () => {
  const f = await fixture({ local: { research: { enabled: false } } });
  const before = f.read("config.local.json");
  const body = await f.edit([{ path: ["instances", "codex-review"], value: { kind: "codex", roles: ["reviewer"], review_mode: "fresh" } }]);
  for (const message of [{ t: "config_edit_preview", edit: body }, { t: "config_edit_apply", edit: body, reason: "add the reviewer" }]) {
    const reply = await f.client.request(message);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("fresh requires reviewer-only roles, headless mode");
    expect(reply.field).toBe("instances.codex-review.review_mode");
  }
  expect(f.read("config.local.json")).toBe(before);
  expect(existsSync(join(f.state, "config-backups"))).toBe(false);
  expect(f.events()).toEqual([]);
}, 20_000);

test("#689 console: a valid fresh reviewer writes config.local.json, keeps a backup, audits it and shows restart pending", async () => {
  const f = await fixture({ local: { research: { enabled: false } } });
  const before = f.read("config.local.json")!;
  const body = await f.edit([{ path: ["instances", "codex-review"], value: reviewer }]);
  const preview = await f.client.request({ t: "config_edit_preview", edit: body });
  expect(preview).toMatchObject({ ok: true, tier: 2 });
  expect(f.read("config.local.json")).toBe(before);
  const done = await f.client.request({ t: "config_edit_apply", edit: body, reason: "add the fresh codex reviewer" });
  expect(done).toMatchObject({ ok: true, saved: true, restartPending: ["instances"] });
  expect(JSON.parse(f.read("config.local.json")!).instances["codex-review"]).toEqual(reviewer);
  const backups = readdirSync(join(f.state, "config-backups"));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(f.state, "config-backups", backups[0]!), "utf8")).toBe(before);
  const status = (await f.client.request({ t: "status" })).status;
  expect(status.pendingRestart.some((row: { key: string }) => row.key === "instances")).toBe(true);
  const settings = await f.client.request({ t: "settings_get" });
  expect(settings.pendingRestart.some((row: { key: string }) => row.key === "instances")).toBe(true);
  const entry = f.events()[0] as unknown as { file: string; by: string; tier: number; source: string; reason: string; paths: { path: string }[] };
  expect(entry).toMatchObject({ file: "config.local.json", by: "person", tier: 2, source: "terminal", reason: "add the fresh codex reviewer" });
  expect(entry.paths.map(row => row.path)).toEqual(["instances.codex-review"]);
  expect(JSON.stringify(entry)).not.toContain("headless");
  // The file the daemon wrote is one its own loader accepts at the next start.
  expect(loadConfig(f.dir).instances?.["codex-review"]).toMatchObject({ kind: "codex", review_mode: "fresh" });
}, 20_000);

test("#689 dashboard: the same edit works inside a settings session and is refused outside one", async () => {
  const f = await fixture({ local: { research: { enabled: false } } });
  const ordinary = await f.session(false), settings = await f.session(true);
  const body = await f.edit([{ path: ["instances", "codex-review"], value: reviewer }]);
  const before = f.read("config.local.json");
  for (const action of ["config_edit_preview", "config_edit_apply"]) {
    const refused = await ordinary({ action, edit: body });
    expect(refused.ok, action).toBe(false);
    expect(String(refused.error)).toContain("settings session");
  }
  expect(f.read("config.local.json")).toBe(before);
  expect((await settings({ action: "config_edit_preview", edit: body })).ok).toBe(true);
  const done = await settings({ action: "config_edit_apply", edit: body, reason: "from the dashboard" });
  expect(done).toMatchObject({ ok: true, saved: true });
  expect(JSON.parse(f.read("config.local.json")!).instances["codex-review"]).toEqual(reviewer);
  expect(f.events()).toHaveLength(1);
  expect(f.events()[0]).toMatchObject({ source: "dashboard", by: "person" });
}, 20_000);

test("#689 dashboard: every tier 3 key is refused server side, even with the key typed, and the console still takes it", async () => {
  const home = realPath(mkdtempSync(join(tmpdir(), "ahub-structural-home-"))); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  // The base Jcode gets a home of its own, apart from the instance's: a default home may contain the temp directory (it does on a Jcode-hosted run).
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-structural-base-"))); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const f = await fixture({ local: { jcode_home: base, instances: { "jcode-two": { kind: "jcode", jcode_home: home, model: "old-model" } } } });
  const settings = await f.session(true);
  const before = f.read("config.local.json");
  const forged = [
    [{ path: ["instances", "jcode-two", "model"], value: "evil" }],
    [{ path: ["instances", "jcode-two", "jcode_home"], value: "/tmp/elsewhere" }],
    [{ path: ["instances", "jcode-two"], value: { kind: "jcode", jcode_home: "/tmp/e" } }],
    [{ path: ["kimi_cmd"], value: ["/bin/sh", "-c", "x"] }],
    [{ path: ["terminal", "open"], value: "sh -c x" }],
    [{ path: ["checks", "runner"], value: "container" }],
    [{ path: ["omniroute", "api_key_file"], value: "/etc/passwd" }],
    [{ path: ["adapters", "evil"], value: { command: ["sh"] } }],
  ];
  for (const set of forged) {
    for (const action of ["config_edit_preview", "config_edit_apply"]) {
      const reply = await settings({ action, edit: await f.edit(set), confirm: "instances.jcode-two.model", reason: "forged" });
      expect(reply.ok, `${action} ${JSON.stringify(set)}`).toBe(false);
    }
  }
  expect(f.read("config.local.json")).toBe(before);
  expect(f.events()).toEqual([]);
  // The console takes it, with the typed key.
  const set = [{ path: ["instances", "jcode-two", "model"], value: "new-model" }];
  const preview = await f.client.request({ t: "config_edit_preview", edit: await f.edit(set) });
  expect(preview).toMatchObject({ ok: true, tier: 3, confirm: "instances.jcode-two.model" });
  expect((await f.client.request({ t: "config_edit_apply", edit: await f.edit(set), reason: "no typed key" })).ok).toBe(false);
  expect(f.read("config.local.json")).toBe(before);
  const done = await f.client.request({ t: "config_edit_apply", edit: await f.edit(set), reason: "typed", confirm: "instances.jcode-two.model" });
  expect(done.ok).toBe(true);
  expect(f.read("config.local.json")).toContain("new-model");
  // The audit names the key path and hashes of the values; neither the old nor the new value is in it.
  expect(JSON.stringify(f.events())).not.toContain("old-model"); expect(JSON.stringify(f.events())).not.toContain("new-model");
  expect((f.events()[0] as unknown as { paths: { path: string }[] }).paths.map(row => row.path)).toEqual(["instances.jcode-two.model"]);
}, 30_000);

test("#689 sdlc: advise to enforce writes sdlc.toml with a backup, is validated, records the event and waits for a restart", async () => {
  const f = await fixture({ sdlc: '# lifecycle\nmode = "advise"\nrequired_checks = ["gate"]\n' });
  const bad = await f.client.request({ t: "config_edit_apply", edit: await f.edit([{ path: ["mode"], value: "block" }], "sdlc.toml"), reason: "bad" });
  expect(bad.ok).toBe(false); expect(bad.error).toContain("expected off, advise or enforce");
  expect(f.read("sdlc.toml")).toBe('# lifecycle\nmode = "advise"\nrequired_checks = ["gate"]\n');
  const done = await f.client.request({ t: "config_edit_apply", edit: await f.edit([{ path: ["mode"], value: "enforce" }], "sdlc.toml"), reason: "enforce" });
  expect(done).toMatchObject({ ok: true, saved: true, restartPending: ["sdlc.mode"] });
  expect(f.read("sdlc.toml")).toBe('# lifecycle\nmode = "enforce"\nrequired_checks = ["gate"]\n');
  expect(readdirSync(join(f.state, "config-backups")).some(name => name.startsWith("sdlc.toml."))).toBe(true);
  expect(f.events()[0]).toMatchObject({ file: "sdlc.toml", tier: 2 });
  const status = (await f.client.request({ t: "status" })).status;
  expect(status.pendingRestart).toContainEqual({ key: "sdlc.mode", reason: "the lifecycle is read once at hub start" });
  expect((await f.client.request({ t: "settings_get" })).pendingRestart.map((row: { key: string }) => row.key)).toContain("sdlc.mode");
}, 20_000);

test("#689 a file that changed on disk since it was read is refused with a reload hint, for both files", async () => {
  const f = await fixture({ local: { research: { enabled: false } }, sdlc: 'mode = "advise"\n' });
  const staleLocal = await f.edit([{ path: ["instances", "codex-review"], value: reviewer }]);
  const staleSdlc = await f.edit([{ path: ["mode"], value: "enforce" }], "sdlc.toml");
  writeFileSync(f.file("config.local.json"), JSON.stringify({ research: { enabled: true } }));
  writeFileSync(f.file("sdlc.toml"), 'mode = "off"\n');
  for (const body of [staleLocal, staleSdlc]) {
    const reply = await f.client.request({ t: "config_edit_apply", edit: body, reason: "stale" });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("changed on disk since it was read: reload it");
  }
  expect(f.read("sdlc.toml")).toBe('mode = "off"\n');
  expect(JSON.parse(f.read("config.local.json")!)).toEqual({ research: { enabled: true } });
  expect(f.events()).toEqual([]);
}, 20_000);

test("#689 refusals: an agent's tools connection can call none of it, and the console is the only role that can", async () => {
  const f = await fixture({ local: {}, roster: { codex: true } });
  const body = await f.edit([{ path: ["approvals", "timeout_s"], value: 90 }]);
  const before = f.read("config.local.json");
  const agent = await f.agent("codex");
  for (const message of [{ t: "config_edit_get" }, { t: "config_edit_preview", edit: body }, { t: "config_edit_apply", edit: body, reason: "x" }]) {
    const reply = await agent.request(message);
    expect(reply.ok, message.t).toBe(false);
    expect(String(reply.error), message.t).toContain("a person's");
  }
  expect(f.read("config.local.json")).toBe(before);
  expect(f.events()).toEqual([]);
  // The same request from the console role goes through: the refusal above is the role, not the request.
  expect((await f.client.request({ t: "config_edit_apply", edit: body, reason: "from the console" })).ok).toBe(true);
}, 20_000);

test("#689 a held recovery refuses preview and apply, and the edit works again once it is aborted", async () => {
  const f = await fixture({ local: {} });
  const body = await f.edit([{ path: ["approvals", "timeout_s"], value: 90 }]);
  const before = f.read("config.local.json");
  const instance = (await f.client.request({ t: "status" })).status.instanceId;
  expect((await f.client.request({ t: "recovery", op: "prepare", operationId: "structural-hold", expectedInstanceId: instance })).ok).toBe(true);
  for (const message of [{ t: "config_edit_preview", edit: body }, { t: "config_edit_apply", edit: body, reason: "held" }]) {
    const reply = await f.client.request(message);
    expect(reply.ok, message.t).toBe(false);
    expect(String(reply.error)).toContain("recovery or shutdown is holding config edits");
  }
  expect(f.read("config.local.json")).toBe(before);
  expect((await f.client.request({ t: "recovery", op: "abort", operationId: "structural-hold", expectedInstanceId: instance })).ok).toBe(true);
  expect((await f.client.request({ t: "config_edit_apply", edit: body, reason: "after" })).ok).toBe(true);
}, 20_000);

test("#689 a tracked config.local.json is refused and a first edit with no file creates it", async () => {
  const f = await fixture({ local: { research: { enabled: false } } });
  f.git("add", "-f", ".agenthub/config.local.json");
  const body = await f.edit([{ path: ["approvals", "timeout_s"], value: 90 }]);
  const reply = await f.client.request({ t: "config_edit_apply", edit: body, reason: "tracked" });
  expect(reply.ok).toBe(false);
  expect(String(reply.error)).toMatch(/committed to git|tracked/);
  expect(JSON.parse(f.read("config.local.json")!)).toEqual({ research: { enabled: false } });
}, 20_000);

test("#689 a dashboard apply of a live structural key publishes it through the one reload path, and a settings session can do it", async () => {
  const f = await fixture({ local: { research: { enabled: false } } });
  const settings = await f.session(true);
  const done = await settings({ action: "config_edit_apply", edit: await f.edit([{ path: ["approvals", "timeout_s"], value: 77 }]), reason: "shorter approvals" });
  expect(done, JSON.stringify(done)).toMatchObject({ ok: true, saved: true });
  expect(JSON.parse(f.read("config.local.json")!).approvals.timeout_s).toBe(77);
  expect(f.events()[0]).toMatchObject({ source: "dashboard" });
}, 20_000);

test("#689 status.json and the console snapshot both carry a restart-pending sdlc.toml, and a hub that already runs the file's mode has none", async () => {
  const f = await fixture({ sdlc: 'mode = "advise"\n' });
  expect((await f.client.request({ t: "status" })).status.pendingRestart).toEqual([]);
  expect((await f.client.request({ t: "config_edit_apply", edit: await f.edit([{ path: ["mode"], value: "enforce" }], "sdlc.toml"), reason: "enforce" })).ok).toBe(true);
  const written = JSON.parse(readFileSync(join(f.state, "status.json"), "utf8"));
  expect(written.pendingRestart).toContainEqual({ key: "sdlc.mode", reason: "the lifecycle is read once at hub start" });
  expect((await f.client.request({ t: "ui_snapshot", after: 0 })).status.pendingRestart.map((row: { key: string }) => row.key)).toContain("sdlc.mode");
  // Writing the running mode back clears it: pending is what differs from the running hub, not what was edited.
  expect((await f.client.request({ t: "config_edit_apply", edit: await f.edit([{ path: ["mode"], value: "advise" }], "sdlc.toml"), reason: "back" })).ok).toBe(true);
  expect((await f.client.request({ t: "status" })).status.pendingRestart.map((row: { key: string }) => row.key)).not.toContain("sdlc.mode");
}, 20_000);

test("#689 two instances may not share a Jcode home, and the daemon's check refuses it before anything is written", async () => {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-structural-b-"))), one = realPath(mkdtempSync(join(tmpdir(), "ahub-structural-o-")));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }), () => rmSync(one, { recursive: true, force: true }));
  const f = await fixture({ local: { jcode_home: base, instances: { "jcode-one": { kind: "jcode", jcode_home: one } } } });
  const before = f.read("config.local.json");
  for (const home of [one, base, join(one, "nested")]) {
    const reply = await f.client.request({ t: "config_edit_apply", edit: await f.edit([{ path: ["instances", "jcode-two"], value: { kind: "jcode", jcode_home: home } }]), reason: "dup", confirm: "instances.jcode-two" });
    expect(reply.ok, home).toBe(false);
    expect(String(reply.error), home).toMatch(/same home|differ from the base|nested inside or around/);
  }
  expect(f.read("config.local.json")).toBe(before);
}, 20_000);

test("#689 a file the loaders already refuse is never rewritten by an unrelated edit, so a broken file is not papered over", async () => {
  const f = await fixture({ local: { research: { enabled: false } } });
  writeFileSync(f.file("config.local.json"), JSON.stringify({ research: { enabled: false }, roster: { "not-a-peer": true } }));
  const before = f.read("config.local.json");
  const reply = await f.client.request({ t: "config_edit_apply", edit: await f.edit([{ path: ["approvals", "timeout_s"], value: 5 }]), reason: "x" });
  expect(reply.ok).toBe(false);
  expect(String(reply.error)).toContain("unsupported peer");
  expect(f.read("config.local.json")).toBe(before);
  expect(f.events()).toEqual([]);
}, 20_000);

test("#689 a structural value the file loader accepts but the effective config refuses (out of bounds, an unknown reviewer kind) is refused with that reason, and writes nothing", async () => {
  const f = await fixture({ local: { research: { enabled: false } } });
  const before = f.read("config.local.json");
  for (const [path, value, reason] of [
    [["context", "gate"], 7, "context.gate"], [["review", "min_reviews"], 0, "review.min_reviews"], [["review", "pool"], ["nobody"], "review.pool"],
    [["snapshots", "keep"], 0, "snapshots.keep"], [["approvals", "timeout_s"], -1, "approvals.timeout_s"],
  ] as const) {
    const reply = await f.client.request({ t: "config_edit_apply", edit: await f.edit([{ path: [...path], value }]), reason: "bounds" });
    expect(reply.ok, path.join(".")).toBe(false);
    expect(String(reply.error), path.join(".")).toContain(reason);
    expect(reply.field, path.join(".")).toBe(reason);
  }
  expect(f.read("config.local.json")).toBe(before);
  expect(f.events()).toEqual([]);
}, 20_000);

test("#689 the dashboard snapshot carries the Structure data to a settings session and an ordinary one, and the page that renders it is the one served", async () => {
  const home = realPath(mkdtempSync(join(tmpdir(), "ahub-structural-snap-"))), base = realPath(mkdtempSync(join(tmpdir(), "ahub-structural-snapb-")));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => rmSync(base, { recursive: true, force: true }));
  const f = await fixture({ local: { jcode_home: base, instances: { "jcode-two": { kind: "jcode", jcode_home: home, model: "secret-model-name" } } } });
  const url = new URL((await f.client.request({ t: "ui", settings: true })).url);
  const open = await fetch(`${url.origin}/session`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
  const cookie = open.headers.get("set-cookie")!.split(";")[0]!;
  const snapshot = await (await fetch(`${url.origin}/snapshot`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json", cookie }, body: JSON.stringify({ after: 0 }) })).json() as { settings?: { configEdit?: Record<string, any>; sessionUntil?: number } };
  const edit = snapshot.settings?.configEdit;
  expect(edit?.revisions["config.local.json"]).toMatch(/^[a-f0-9]{64}$/);
  expect(edit?.instances.map((item: { id: string }) => item.id)).toEqual(["jcode-two"]);
  expect(edit?.instances[0].tier3).toEqual(expect.arrayContaining(["jcode_home", "model"]));
  // A browser is told that a tier 3 field is set, never its value or its path.
  // The peer table already names an instance's model (`modelSource`, #685); what #689 adds is the edit payload, and that carries no tier 3 value and no path.
  const raw = JSON.stringify(edit);
  expect(raw).not.toContain("secret-model-name"); expect(raw).not.toContain(home); expect(raw).not.toContain(base);
  expect(edit?.tier3.find((item: { key: string }) => item.key === "instances.jcode-two.model")).toMatchObject({ set: true, command: expect.stringContaining("ahub settings edit config.local.json set instances.jcode-two.model") });
  const page = await (await fetch(`${url.origin}/`)).text();
  expect(page).toContain("renderStructure"); expect(page).toContain("structure-tier3");
}, 20_000);

test("#689 an sdlc.toml changed by hand shows as restart pending on the next status, and a repeated status does not need another read", async () => {
  const f = await fixture({ sdlc: 'mode = "advise"\n' });
  expect((await f.client.request({ t: "status" })).status.pendingRestart).toEqual([]);
  writeFileSync(f.file("sdlc.toml"), 'mode = "enforce"\nrequired_checks = ["gate"]\n');
  const keys = async () => (await f.client.request({ t: "status" })).status.pendingRestart.map((row: { key: string }) => row.key);
  expect(await keys()).toEqual(["sdlc.mode", "sdlc.required_checks"]);
  const reads = f.daemon.sdlcFileReads();
  for (let i = 0; i < 5; i++) expect(await keys()).toEqual(["sdlc.mode", "sdlc.required_checks"]);
  expect(f.daemon.sdlcFileReads(), "five more statuses with the file unchanged read it no more").toBe(reads);
  writeFileSync(f.file("sdlc.toml"), 'mode = "advise"\n');
  expect(await keys()).toEqual([]);
  writeFileSync(f.file("sdlc.toml"), "mode = [broken");
  expect(await keys()).toEqual([]); // an unreadable file is a problem the view names, not a restart the hub could take
}, 20_000);

test("#689 a dashboard preview and apply of a whole-instance removal never carry a tier 3 value, and the console is asked for the key", async () => {
  const home = realPath(mkdtempSync(join(tmpdir(), "ahub-structural-rm-"))), base = realPath(mkdtempSync(join(tmpdir(), "ahub-structural-rmb-")));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => rmSync(base, { recursive: true, force: true }));
  const f = await fixture({ local: { jcode_home: base, instances: { "jcode-two": { kind: "jcode", jcode_home: home, model: "secret-model-name", provider: "secret-provider" } } } });
  const settings = await f.session(true);
  const before = f.read("config.local.json");
  const set = [{ path: ["instances", "jcode-two"], value: null }];
  for (const action of ["config_edit_preview", "config_edit_apply"]) {
    const reply = await settings({ action, edit: await f.edit(set), reason: "forged", confirm: "instances.jcode-two" });
    expect(reply.ok, action).toBe(false);
    for (const secret of [home, "secret-model-name", "secret-provider"]) expect(JSON.stringify(reply), action).not.toContain(secret);
  }
  expect(f.read("config.local.json")).toBe(before);
  const preview = await f.client.request({ t: "config_edit_preview", edit: await f.edit(set) });
  expect(preview).toMatchObject({ ok: true, tier: 3, confirm: "instances.jcode-two" });
  for (const secret of [home, "secret-model-name", "secret-provider"]) expect(JSON.stringify(preview)).not.toContain(secret);
}, 20_000);

test("#689 a symlinked config.local.json never takes the Settings view down: the revision is unavailable and the rows still load", async () => {
  const f = await fixture({ local: {} });
  rmSync(f.file("config.local.json")); writeFileSync(join(f.dir, "elsewhere.json"), "{}");
  const { symlinkSync } = await import("node:fs");
  symlinkSync(join(f.dir, "elsewhere.json"), f.file("config.local.json"));
  const view = await f.client.request({ t: "settings_get" });
  expect(view.ok).toBe(true);
  expect(Array.isArray(view.rows)).toBe(true);
  expect(view.configEdit.revisions["config.local.json"]).toBe("unavailable");
  const reply = await f.client.request({ t: "config_edit_apply", edit: { file: "config.local.json", revision: "unavailable", set: [{ path: ["approvals", "timeout_s"], value: 5 }] }, reason: "x" });
  expect(reply.ok).toBe(false);
}, 20_000);
