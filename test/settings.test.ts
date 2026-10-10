import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext, Script } from "node:vm";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { loadConfig, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { readEvents } from "../src/hub/events.ts";
import { assign, currentRouting, loadRouting, OVERLAY_FILE, overlayToml, parseOverlay } from "../src/hub/routing.ts";
import { checkSettingValue, NEVER_EDITABLE, settingDef, settingRefusal, SETTINGS, undoSetting, writeConfigSetting, writeRoutingSetting, type SettingDef, type SettingRow } from "../src/hub/settings.ts";
import { SETTINGS_MS, startDashboard, type DashboardSession } from "../src/hub/ui.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10); expect(check()).toBe(true); };
const def = (key: string): SettingDef => { const found = settingDef(key); if (typeof found === "string") throw new Error(found); return found; };
const TEMPLATE = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8");
const SHARED = `${JSON.stringify({ memory: { enabled: false }, research: { enabled: false }, pi: { auto_start: true } }, null, 2)}\n`;

/** A project with a shared config and routing file, as `ahub init` leaves it. */
function project() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ahub-settings-test-")));
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), SHARED);
  writeFileSync(join(cwd, ".agenthub/routing.toml"), TEMPLATE);
  return { cwd, stateDir: join(cwd, ".agenthub/state"), file: (name: string) => join(cwd, ".agenthub", name) };
}
const text = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);

async function hub(config: Partial<HubConfig> = {}) {
  const p = project();
  const daemon = await startDaemon({ cwd: p.cwd, stateDir: p.stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0,
    config: { ...loadConfig(p.cwd), batch_ms: 0, kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")], ...config } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(p.stateDir, { role: "console" }); cleanup.push(() => client.close());
  /** A browser session from `ahub ui` (ordinary) or `ahub ui --settings`. */
  async function page(settings = false) {
    const url = new URL((await client.request({ t: "ui", ...(settings ? { settings: true } : {}) })).url);
    const post = (path: string, body: unknown, cookie?: string) => fetch(`${url.origin}${path}`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const cookie = (await post("/session", { ticket: url.hash.slice(1) })).headers.get("set-cookie")!.split(";")[0]!;
    return {
      act: async (body: Record<string, unknown>) => (await post("/action", body, cookie)).json() as Promise<Record<string, any>>,
      rows: async () => ((await (await post("/snapshot", { after: 0 }, cookie)).json()) as { settings: { rows: SettingRow[]; undo?: string; sessionUntil?: number } }).settings,
    };
  }
  const events = () => readEvents(join(p.stateDir, "events.jsonl")).filter((e) => e.type === "settings");
  return { ...p, daemon, client, page, events };
}

test("AC1: every editable setting has one registry entry with its store, apply time and risk", () => {
  expect(new Set(SETTINGS.map((s) => s.key)).size).toBe(SETTINGS.length);
  for (const s of SETTINGS) {
    expect(["runtime", "config", "routing"]).toContain(s.store);
    expect(["live", "hub start"]).toContain(s.applies);
    expect(["safe", "raises"]).toContain(s.risk);
    expect(s.type === "enum" ? s.values !== undefined || s.key.endsWith(".route") : true).toBe(true);
    expect(settingDef(s.key)).toBe(s);
  }
  // The first version's list, from the issue: modes now and at start, the Pi start, routing per class, the safe switches.
  for (const key of ["permission.kimi", "permission_modes.codex", "pi.auto_start", "routing.stay_switch", "routing.classes.implement.peers", "routing.classes.review.escalate_to", "routing.classes.test.route", "routing.classes.implement.pi_backend", "research.enabled", "approvals.notify", "snapshots.enabled", "coordination"]) expect(typeof settingDef(key)).toBe("object");
});

test("AC1: a key outside the registry, a value outside its set and every never-editable key are refused from every surface", async () => {
  const rig = await hub();
  const settings = await rig.page(true), ordinary = await rig.page();
  const before = [text(rig.file("config.json")), text(rig.file("config.local.json")), text(rig.file("routing.toml")), text(rig.file(OVERLAY_FILE))];
  const surfaces = [
    (key: string, value: unknown) => rig.client.request({ t: "settings_set", key, value }),
    (key: string, value: unknown) => settings.act({ action: "setting", key, value }),
    (key: string, value: unknown) => ordinary.act({ action: "setting", key, value }),
  ];
  for (const set of surfaces) {
    for (const key of ["kimi_cmd", "codex_bin", "pi.cmd", "checks", "checks.implement", "mlx.model", "omniroute.urls", "omniroute.api_key_file", "memory.worker_url", "local.read_allow", "local.bash_network", "local.network_allow", "bench.enabled", "terminal.open"]) {
      const reply = await set(key, "x");
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain("never editable from settings");
    }
    for (const key of ["watchdog_ms", "roles.claude", "routing.signals.pii_patterns", "routing.constraints.pii", "routing.local.fixed_model", "__proto__", "constructor.prototype", ""]) expect((await set(key, "x")).error).toContain("unknown setting");
    expect((await set("research.enabled", "yes")).error).toContain("true or false");
    expect((await set("coordination", "anarchy")).error).toContain("advisory, turn-free");
    expect((await set("permission.kimi", "always")).error).toContain("ask, ask-when-needed, never-ask");
    expect((await set("routing.classes.implement.pi_backend", "cloud")).error).toContain("dgx, mlx");
    expect((await set("routing.classes.implement.route", "no/such-route")).error).toContain("takes one of");
    for (const peers of ["codex", ["codex", "codex"], ["Bad Peer"], ["a; rm -rf /"], Array.from({ length: 9 }, (_, i) => `p${i}`), [1]]) expect((await set("routing.classes.implement.peers", peers)).error).toContain("distinct peer ids");
  }
  for (const key of NEVER_EDITABLE) expect(typeof settingDef(key)).toBe("string");
  expect([text(rig.file("config.json")), text(rig.file("config.local.json")), text(rig.file("routing.toml")), text(rig.file(OVERLAY_FILE))]).toEqual(before);
  expect(rig.events()).toEqual([]);
}, 20_000);

test("AC2: writes land only in the machine-local files, the real loaders read them, undo puts the previous version back, and each change is one event", async () => {
  const rig = await hub();
  const local = rig.file("config.local.json"), overlay = rig.file(OVERLAY_FILE);
  writeFileSync(local, `${JSON.stringify({ budget: { gate: 0.9 } })}\n`);
  const set = (key: string, value: unknown) => rig.client.request({ t: "settings_set", key, value });
  const shared = loadRouting(rig.cwd).classes.implement!.peers;

  expect(await set("research.enabled", true)).toMatchObject({ ok: true });
  expect(JSON.parse(text(local)!)).toEqual({ budget: { gate: 0.9 }, research: { enabled: true } }); // other keys kept
  expect(loadConfig(rig.cwd).research.enabled).toBe(true);
  const afterFirst = text(local);

  expect(await set("routing.classes.implement.peers", ["kimi", "codex"])).toMatchObject({ ok: true });
  expect(loadRouting(rig.cwd).classes.implement!.peers).toEqual(["kimi", "codex"]);
  expect(parseOverlay(text(overlay)!)).toEqual({ classes: { implement: { peers: ["kimi", "codex"] } } });

  // The tracked files are byte-identical, and nothing else appeared beside them (no temp file left behind).
  expect(text(rig.file("config.json"))).toBe(SHARED);
  expect(text(rig.file("routing.toml"))).toBe(TEMPLATE);
  expect(readdirSync(join(rig.cwd, ".agenthub")).sort()).toEqual(["config.json", "config.local.json", OVERLAY_FILE, "routing.toml", "state"].sort());

  // One step of undo: the routing write goes, the config write stays.
  expect(await rig.client.request({ t: "settings_undo" })).toMatchObject({ ok: true });
  expect(text(overlay)).toBeNull();
  expect(text(local)).toBe(afterFirst);
  expect((await rig.client.request({ t: "settings_undo" })).error).toBe("nothing to undo");

  // `inherit` removes the machine-local value and the shared file's applies again.
  expect(await set("research.enabled", null)).toMatchObject({ ok: true });
  expect(JSON.parse(text(local)!)).toEqual({ budget: { gate: 0.9 } });
  expect(await rig.client.request({ t: "settings_undo" })).toMatchObject({ ok: true });
  expect(text(local)).toBe(afterFirst);

  expect(rig.events().map(({ key, from, to, source, undo }) => ({ key, from, to, source, undo }))).toEqual([
    { key: "research.enabled", from: false, to: true, source: "terminal", undo: undefined },
    { key: "routing.classes.implement.peers", from: shared, to: ["kimi", "codex"], source: "terminal", undo: undefined },
    { key: "routing.classes.implement.peers", from: ["kimi", "codex"], to: shared, source: "terminal", undo: true },
    { key: "research.enabled", from: true, to: false, source: "terminal", undo: undefined },
    { key: "research.enabled", from: false, to: true, source: "terminal", undo: true },
  ]);
  expect(JSON.stringify(rig.events())).not.toContain("gate"); // a neighbour's value is never carried along
}, 20_000);

test("AC2: a candidate the loader refuses, a broken machine-local file, a hand edit before undo and a tracked file all leave the disk as it was", () => {
  const p = project();
  const load = (scratch: string) => loadConfig(scratch);
  // The loader's own check decides: a second conductor in the shared roles makes any candidate fail to load.
  writeFileSync(p.file("config.json"), JSON.stringify({ roles: { claude: ["conductor"], codex: ["conductor"] } }));
  expect(() => writeConfigSetting(p.cwd, p.stateDir, def("research.enabled"), true, load)).toThrow();
  expect(text(p.file("config.local.json"))).toBeNull();
  writeFileSync(p.file("config.json"), SHARED);

  writeFileSync(p.file("config.local.json"), "{ not json");
  expect(() => writeConfigSetting(p.cwd, p.stateDir, def("research.enabled"), true, load)).toThrow("not valid JSON");
  expect(text(p.file("config.local.json"))).toBe("{ not json");
  writeFileSync(p.file("config.local.json"), JSON.stringify({ pi: "oops" }));
  expect(() => writeConfigSetting(p.cwd, p.stateDir, def("pi.auto_start"), false, load)).toThrow("pi is not an object");

  // The overlay goes through the real routing parser: a route the project does not define never reaches the disk.
  expect(() => writeRoutingSetting(p.cwd, p.stateDir, def("routing.classes.implement.route"), "sy/missing")).toThrow("names no route");
  expect(text(p.file(OVERLAY_FILE))).toBeNull();

  // Undo refuses once the file changed by hand since the write it would undo.
  writeRoutingSetting(p.cwd, p.stateDir, def("routing.stay_switch"), "shadow");
  expect(loadRouting(p.cwd).stay_switch).toBe("shadow");
  writeFileSync(p.file(OVERLAY_FILE), 'stay_switch = "enforce"\n');
  expect(() => undoSetting(p.cwd, p.stateDir, load)).toThrow("changed since the last settings write");
  expect(text(p.file(OVERLAY_FILE))).toBe('stay_switch = "enforce"\n');

  // A machine-local file somebody committed is never written: the repository's files stay byte-identical.
  const git = (...args: string[]) => expect(spawnSync("git", ["-C", p.cwd, ...args], { encoding: "utf8" }).status).toBe(0);
  const tracked = `${JSON.stringify({ research: { enabled: false } })}\n`;
  writeFileSync(p.file("config.local.json"), tracked);
  git("init", "-q"); git("add", "-f", ".agenthub/config.local.json"); // -f: a global ignore file may list .agenthub
  expect(() => writeConfigSetting(p.cwd, p.stateDir, def("research.enabled"), true, load)).toThrow("committed to git");
  expect(text(p.file("config.local.json"))).toBe(tracked);
  git("rm", "-q", "--cached", ".agenthub/config.local.json"); git("add", "-f", `.agenthub/${OVERLAY_FILE}`);
  expect(() => writeRoutingSetting(p.cwd, p.stateDir, def("routing.stay_switch"), "off")).toThrow("committed to git");
  expect(text(p.file(OVERLAY_FILE))).toBe('stay_switch = "enforce"\n');
});

test("AC3: routing.local.toml merges over routing.toml key by key, assign and route explain agree and name the source, and nothing else can be set there", async () => {
  const p = project();
  const shared = loadRouting(p.cwd);
  expect(shared.sources).toBeUndefined();
  writeFileSync(p.file(OVERLAY_FILE), overlayToml({ stay_switch: "enforce", classes: { implement: { peers: ["kimi", "codex"], pi_backend: "dgx" }, review: { escalate_to: ["codex"] } } }));
  const merged = loadRouting(p.cwd);
  expect(merged.stay_switch).toBe("enforce");
  expect(merged.classes.implement).toEqual({ ...shared.classes.implement!, peers: ["kimi", "codex"], pi_backend: "dgx" }); // route and escalate_to stay routing.toml's
  expect(merged.classes.review).toEqual({ ...shared.classes.review!, escalate_to: ["codex"] });
  expect(merged.classes.test).toEqual(shared.classes.test);
  expect(merged.sources).toEqual({ stay_switch: OVERLAY_FILE, "classes.implement.peers": OVERLAY_FILE, "classes.implement.pi_backend": OVERLAY_FILE, "classes.review.escalate_to": OVERLAY_FILE });
  // Everything outside the overlay's keys is the shared file's, untouched.
  for (const key of ["local", "routes", "signals", "constraints", "pi"] as const) expect(merged[key]).toEqual(shared[key]);

  const states = { kimi: "idle", codex: "idle", pi: "idle" } as const;
  const a = assign({ class: "implement", signals: [] }, states, merged);
  expect(a.owner).toBe("kimi");
  expect(assign({ class: "implement", signals: [] }, states, shared).owner).toBe("pi");
  expect(a.trace).toContain(`policy source: peers, pi_backend from ${OVERLAY_FILE}; the rest from routing.toml`);
  expect(assign({ class: "test", signals: [] }, states, merged).trace.join("\n")).not.toContain("policy source");

  // The overlay holds these keys and nothing else: a settings write can never reach targets, routes, signals or the PII constraint.
  for (const bad of ['[constraints]\npii = "off"\n', '[signals]\npii_patterns = []\n', '[local]\nfixed_model = "x"\n', '[classes.implement]\nlocal_allowed = true\n', '[classes.nonsense]\npeers = ["kimi"]\n', '[classes.implement]\npeers = ["Kimi!"]\n', 'stay_switch = "sometimes"\n', '[routes."sy/x"]\ntype = "passthrough"\n']) {
    expect(() => parseOverlay(bad)).toThrow(OVERLAY_FILE);
  }
  // A running hub re-reads on a change to either file and keeps the last good policy when the overlay breaks.
  expect(currentRouting(p.cwd).classes.implement!.peers).toEqual(["kimi", "codex"]);
  const lines: string[] = [];
  writeFileSync(p.file(OVERLAY_FILE), '[constraints]\npii = "off"\n');
  expect(currentRouting(p.cwd, (line) => lines.push(line)).constraints.pii).toBe("local_only");
  expect(lines.join("\n")).toContain("keeping the previous policy");
});

test("AC3: the preview shows route explain for the open tasks before and after, saves nothing, and the saved change routes the next task", async () => {
  const rig = await hub();
  const propose = async (title: string) => (await rig.client.request({ t: "task", op: "hub_task_propose", args: { title, class: "implement" } })).text as string;
  expect((await rig.client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => rig.daemon.bus.stateOf("kimi") !== "offline");
  const codex = await ControlClient.connect(rig.stateDir, { role: "peer", peer: "reviewer-one" }); cleanup.push(() => codex.close());
  await until(() => rig.daemon.bus.stateOf("reviewer-one") === "idle");
  expect(await propose("an open task")).toContain("task #1");

  const preview = await rig.client.request({ t: "settings_preview", key: "routing.classes.implement.peers", value: ["reviewer-one", "kimi"] });
  expect(preview.ok).toBe(true);
  expect(preview.lines[0]).toBe(`routing.classes.implement.peers: ${loadRouting(rig.cwd).classes.implement!.peers.join(",")} -> reviewer-one,kimi`);
  expect(preview.tasks).toHaveLength(1);
  const [task] = preview.tasks;
  expect(task.id).toBe(1);
  expect(task.before[0]).toContain("#1 an open task");
  expect(task.before.join("\n")).not.toContain("policy source");
  expect(task.after.join("\n")).toContain(`policy source: peers from ${OVERLAY_FILE}`);
  expect(task.before.join("\n")).not.toBe(task.after.join("\n"));
  expect(text(rig.file(OVERLAY_FILE))).toBeNull(); // a preview writes nothing
  expect(rig.events()).toEqual([]);

  // Saved, the same policy decides the next assignment, and `ahub route explain` names where it came from.
  expect((await rig.client.request({ t: "settings_set", key: "routing.classes.implement.peers", value: ["reviewer-one", "kimi"] })).ok).toBe(true);
  expect(await propose("the next task")).toContain("owner reviewer-one");
  const explained = (await rig.client.request({ t: "task", op: "route_explain", args: { class: "implement", title: "another" } })).text as string;
  expect(explained).toContain(`policy source: peers from ${OVERLAY_FILE}; the rest from routing.toml`);
  // A permission preview says what the mode grants and the bounds the peer runs in.
  const mode = await rig.client.request({ t: "settings_preview", key: "permission.kimi", value: "never-ask" });
  expect(mode.lines).toEqual(["kimi: runs its own tools; NO hub sandbox", "never-ask: Kimi's auto mode: nothing asks"]);
}, 30_000);

test("AC4: an ordinary session reads, lowers and changes safe settings only; a settings session raises; never-ask needs the peer id typed", async () => {
  const rig = await hub();
  expect((await rig.client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => rig.daemon.bus.stateOf("kimi") === "idle");
  const ordinary = await rig.page(), settings = await rig.page(true);
  expect((await ordinary.rows()).sessionUntil).toBeUndefined();
  expect((await settings.rows()).sessionUntil).toBeGreaterThan(Date.now());
  const mode = async () => (await rig.client.request({ t: "permission", peer: "kimi" })).permissionMode;

  // Ordinary: every raise is refused with the way to get there, and nothing is written.
  for (const [key, value] of [["permission.kimi", "ask-when-needed"], ["permission_modes.kimi", "ask-when-needed"], ["pi.auto_start", true], ["routing.stay_switch", "enforce"], ["routing.classes.implement.peers", ["kimi"]], ["permission_modes.kimi", null], ["routing.stay_switch", null]] as const) {
    const reply = await ordinary.act({ action: "setting", key, value });
    expect(reply).toMatchObject({ ok: false });
    expect(reply.error).toContain("ahub ui --settings");
  }
  expect((await ordinary.act({ action: "setting_undo" })).error).toContain("ahub ui --settings");
  expect(await mode()).toBe("ask");
  expect([text(rig.file("config.local.json")), text(rig.file(OVERLAY_FILE))]).toEqual([null, null]);
  // Ordinary: a safe switch, and the floor of a raising one.
  expect(await ordinary.act({ action: "setting", key: "research.enabled", value: true })).toMatchObject({ ok: true });
  expect(await ordinary.act({ action: "setting", key: "pi.auto_start", value: false })).toMatchObject({ ok: true });
  expect(JSON.parse(text(rig.file("config.local.json"))!)).toEqual({ research: { enabled: true }, pi: { auto_start: false } });

  // Settings session: the same request the console makes, announced with its source.
  expect(await settings.act({ action: "setting", key: "permission.kimi", value: "ask-when-needed" })).toMatchObject({ ok: true });
  expect(await mode()).toBe("ask-when-needed");
  // never-ask: refused without the typed peer id, with another peer's id, and from the terminal request without it.
  for (const confirm of [undefined, "", "pi", "KIMI", true]) expect((await settings.act({ action: "setting", key: "permission.kimi", value: "never-ask", confirm })).error).toContain("needs its peer id");
  expect((await rig.client.request({ t: "settings_set", key: "permission.kimi", value: "never-ask" })).error).toContain("needs its peer id");
  expect((await settings.act({ action: "setting", key: "permission_modes.kimi", value: "never-ask" })).error).toContain("needs its peer id");
  expect(await mode()).toBe("ask-when-needed");
  expect(await settings.act({ action: "setting", key: "permission.kimi", value: "never-ask", confirm: "kimi" })).toMatchObject({ ok: true });
  expect(await mode()).toBe("never-ask");
  // Ordinary lowers it again.
  expect(await ordinary.act({ action: "setting", key: "permission.kimi", value: "ask" })).toMatchObject({ ok: true });
  expect(await mode()).toBe("ask");
  expect(rig.events().filter((e) => e.type === "settings" && e.key === "permission.kimi").map((e) => e.type === "settings" && [e.from, e.to, e.source])).toEqual([
    ["ask", "ask-when-needed", "dashboard"], ["ask-when-needed", "never-ask", "dashboard"], ["never-ask", "ask", "dashboard"]]);
  expect(readFileSync(join(rig.stateDir, "hub.log"), "utf8")).toContain("setting permission.kimi: ask -> ask-when-needed (dashboard)");
}, 30_000);

test("AC4: the settings window is fifteen minutes of a session that then stays ordinary, and only a marked ticket opens it", async () => {
  let time = 1_000;
  const seen: (DashboardSession | undefined)[] = [];
  const ui = startDashboard({ now: () => time, snapshot: (_after, _input, session) => { seen.push(session); return { ok: true }; }, action: (_input, session) => { seen.push(session); return { ok: true }; } });
  cleanup.push(ui.stop);
  const post = (path: string, body: unknown, cookie?: string) => fetch(`${ui.origin}${path}`, { method: "POST", headers: { origin: ui.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const open = async (settings: boolean) => (await post("/session", { ticket: new URL(ui.issue(settings)).hash.slice(1) })).headers.get("set-cookie")!.split(";")[0]!;
  const plain = await open(false), marked = await open(true);
  await post("/action", {}, plain); await post("/action", {}, marked); await post("/snapshot", { after: 0 }, marked);
  expect(seen).toEqual([{ settings: false }, { settings: true, settingsUntil: 1_000 + SETTINGS_MS }, { settings: true, settingsUntil: 1_000 + SETTINGS_MS }]);
  time += SETTINGS_MS - 1; await post("/action", {}, marked);
  expect(seen.at(-1)).toEqual({ settings: true, settingsUntil: 1_000 + SETTINGS_MS });
  time += 1; await post("/action", {}, marked); // the window closed; the session itself has 45 minutes left
  expect(seen.at(-1)).toEqual({ settings: false });
  expect((await post("/snapshot", { after: 0 }, marked)).status).toBe(200);
  expect(SETTINGS_MS).toBe(15 * 60_000);
});

test("AC4 and AC8: an agent shell cannot open a settings session or write a setting, and the commands are a person's", async () => {
  const rig = await hub();
  const tools = await ControlClient.connect(rig.stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => tools.close());
  expect(await tools.request({ t: "ui", settings: true })).toMatchObject({ ok: false, error: "ui is a console command" });
  for (const t of ["settings_get", "settings_set", "settings_undo", "settings_preview"]) expect((await tools.request({ t, key: "research.enabled", value: true })).error).toContain("run ahub settings in a terminal");
  expect(text(rig.file("config.local.json"))).toBeNull();
  for (const args of [["--settings"], ["--settings", "--no-open"], []]) expect(classifyPeerCommand("ui", args)).toBe("console");
  for (const args of [[], ["list"], ["get", "research.enabled"], ["set", "research.enabled", "true"], ["undo"]]) expect(classifyPeerCommand("settings", args)).toBe("console");
  // The dashboard's other authority is unchanged: an unknown action is still refused, whatever the session.
  expect(await (await rig.page(true)).act({ action: "setting_everything" })).toMatchObject({ ok: false });
});

test("AC5: a mode set from the dashboard takes the console's own path, with its refusals and its pending never-ask default", async () => {
  const rig = await hub({ permission_modes: { kimi: "never-ask" }, permission_default_sources: { kimi: { mode: "never-ask", source: ".agenthub/config.local.json" } } });
  const settings = await rig.page(true);
  const set = (key: string, value: unknown, confirm?: string) => settings.act({ action: "setting", key, value, ...(confirm ? { confirm } : {}) });
  const row = async (key: string) => (await settings.rows()).rows.find((r) => r.key === key)!;
  // A peer that is not attached: only ask, exactly as `ahub permission` answers.
  expect((await set("permission.pi", "ask-when-needed")).error).toBe((await rig.client.request({ t: "permission", peer: "pi", mode: "ask-when-needed" })).error);
  expect((await set("permission.pi", "ask-when-needed")).error).toBe("pi is not attached; start it through ahub first");
  expect(await row("permission.pi")).toMatchObject({ value: "ask", note: "not attached: only ask can be set", hint: "pi: inside hub sandbox, path guard and denylist" });
  // An unverified Claude session.
  const claude = await ControlClient.connect(rig.stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => claude.close());
  await until(() => rig.daemon.bus.stateOf("claude") === "idle");
  expect((await set("permission.claude", "ask-when-needed")).error).toBe((await rig.client.request({ t: "permission", peer: "claude", mode: "ask-when-needed" })).error);
  expect((await row("permission.claude")).value).toBe("unverified");
  // The never-ask default from the config still waits for the console's y: the row says so and the mode in force is ask.
  expect(await row("permission.kimi")).toMatchObject({ value: "ask", note: "a never-ask default waits for y in ahub console" });
  expect((await rig.client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => rig.daemon.bus.stateOf("kimi") === "idle");
  expect((await rig.client.request({ t: "permission", peer: "kimi" })).permissionMode).toBe("ask");
  // Start reconciliation and the native change are the console's: the fake Kimi is told the mode, and status shows it.
  expect(await set("permission.kimi", "ask-when-needed")).toMatchObject({ ok: true, text: "permission.kimi: ask-when-needed" });
  expect((await rig.client.request({ t: "status" })).status.peers.kimi.permissionMode).toBe("ask-when-needed");
  const modes = readEvents(join(rig.stateDir, "events.jsonl")).filter((e) => e.type === "permission_mode");
  expect(modes).toContainEqual(expect.objectContaining({ peer: "kimi", from: "ask", to: "ask-when-needed" }));
  // A stored never-ask default is written only with the typed peer id, and the next start still asks the console.
  expect(await set("permission_modes.kimi", "never-ask", "kimi")).toMatchObject({ ok: true });
  expect(JSON.parse(text(rig.file("config.local.json"))!)).toEqual({ permission_modes: { kimi: "never-ask" } });
}, 30_000);

test("AC7: the Settings section renders every row from the registry with its source, apply time and pending restart, and every control has a label", () => {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const code = /const SETTING_GROUPS = [\s\S]*?\nfunction render\(snapshot\) \{/.exec(html)![0].replace(/\nfunction render\(snapshot\) \{$/, "");
  class Node {
    children: Node[] = []; attrs: Record<string, string> = {}; listeners: Record<string, () => void> = {}; dataset: Record<string, string> = {};
    value = ""; hidden = false; disabled = false; open = false; htmlFor = ""; id = ""; type = ""; placeholder = "";
    constructor(public tag: string, public textContent = "", public className = "") {}
    append(...nodes: Node[]) { this.children.push(...nodes); }
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
    addEventListener(name: string, fn: () => void) { this.listeners[name] = fn; }
    all(): Node[] { return [this, ...this.children.flatMap((child) => child.all())]; }
    text(): string { return this.all().map((node) => node.textContent).join("\n"); }
  }
  const session = new Node("span"), root = new Node("div"), sent: Record<string, unknown>[] = [];
  const rows: SettingRow[] = [
    { key: "permission.kimi", group: "Permissions", label: "kimi: mode now", type: "enum", values: ["ask", "ask-when-needed", "never-ask"], file: "this hub run", applies: "live", risk: "raises", floor: "ask", value: "ask-when-needed", source: "this hub run", hint: "kimi: runs its own tools; NO hub sandbox" },
    { key: "pi.auto_start", group: "Start", label: "Start Pi with the hub", type: "boolean", file: "config.local.json", applies: "hub start", risk: "raises", floor: false, value: true, source: "config.json", pending: false },
    { key: "routing.classes.implement.peers", group: "Routing", label: "implement: owner preference order", type: "peers", file: "routing.local.toml", applies: "live", risk: "raises", value: ["pi", "codex"], source: "routing.local.toml" },
    { key: "research.enabled", group: "Switches", label: "Research records", type: "boolean", file: "config.local.json", applies: "hub start", risk: "safe", value: false, source: "default" },
  ];
  const context = {
    $: (id: string) => (id === "settings-session" ? session : root), managerMode: false, snapshotValid: true, stopped: false, Date,
    el: (tag: string, text?: string, cls?: string) => new Node(tag, text === undefined ? "" : String(text), cls ?? ""),
    badge: (text: string, cls = "") => new Node("span", text, `badge ${cls}`.trim()),
    empty: (target: Node, text: string) => target.append(new Node("p", text)),
    update: (_id: string, _data: unknown, render: (target: Node) => void) => { root.children = []; render(root); },
    button: (text: string, payload: Record<string, unknown>) => { const node = new Node("button", text); node.listeners.click = () => sent.push(payload); return node; },
    action: (payload: Record<string, unknown>) => { sent.push(payload); return Promise.resolve(true); },
    canMutate: () => true, context: () => ({}), notice: () => {}, post: () => Promise.resolve({ lines: [] }),
    settings: { rows, undo: "pi.auto_start" } as { rows: SettingRow[]; undo?: string; sessionUntil?: number },
  };
  runInNewContext(`${code}; renderSettings(settings)`, context);
  const page = root.text();
  expect(session.textContent).toBe("Read, lower and safe switches only");
  for (const group of ["Permissions (1)", "Start (1)", "Routing (1)", "Switches (1)"]) expect(page).toContain(group);
  expect(page).toContain("permission.kimi / from this hub run / applies at once / written to this hub run");
  expect(page).toContain("pi.auto_start / from config.json / read at hub start / written to config.local.json");
  expect(page).toContain("Pending restart: false at the next hub start.");
  expect(page).toContain("Bounds: kimi: runs its own tools; NO hub sandbox");
  expect(page).toContain("Raising this needs a settings session: run ahub ui --settings. Setting it to ask works here.");
  expect(page).toContain("Last settings write: pi.auto_start");
  // Every control is a native one a keyboard reaches, and each has a text label: a <label for>, or an aria-label.
  const nodes = root.all(), labels = new Set(nodes.filter((n) => n.tag === "label").map((n) => n.htmlFor));
  const controls = nodes.filter((n) => ["select", "input", "button"].includes(n.tag));
  expect(controls.length).toBeGreaterThanOrEqual(4 + 4 + 2 + 1 + 1); // a value control and Save per row, two previews, the typed confirmation, undo
  for (const control of controls) expect(!!control.textContent || !!control.attrs["aria-label"] || labels.has(control.id)).toBe(true);
  expect(nodes.filter((n) => n.tag === "details").map((n) => n.open)).toEqual([true, false, false, false]);
  // Saving sends the registry key and the typed value; never-ask sends the typed confirmation with it.
  const kimi = nodes.find((n) => n.id === "setting-permission-kimi")!, confirm = nodes.find((n) => n.attrs["aria-label"] === "Type kimi to confirm never-ask for kimi")!;
  expect(kimi.value).toBe("ask-when-needed"); expect(confirm.hidden).toBe(true);
  kimi.value = "never-ask"; kimi.listeners.change!(); expect(confirm.hidden).toBe(false);
  confirm.value = " kimi ";
  nodes.find((n) => n.attrs["aria-label"] === "Save kimi: mode now")!.listeners.click!();
  const peers = nodes.find((n) => n.id === "setting-routing-classes-implement-peers")!;
  expect(peers.value).toBe("pi, codex"); peers.value = " kimi ,codex,";
  nodes.find((n) => n.attrs["aria-label"] === "Save implement: owner preference order")!.listeners.click!();
  peers.value = "  ";
  nodes.find((n) => n.attrs["aria-label"] === "Save implement: owner preference order")!.listeners.click!();
  nodes.find((n) => n.textContent === "Undo last write")!.listeners.click!();
  expect(sent).toEqual([
    { action: "setting", key: "permission.kimi", value: "never-ask", confirm: "kimi" },
    { action: "setting", key: "routing.classes.implement.peers", value: ["kimi", "codex"] },
    { action: "setting", key: "routing.classes.implement.peers", value: null },
    { action: "setting_undo" },
  ]);
  // A settings session says how long it has, and the raise hint goes.
  context.settings = { rows, sessionUntil: Date.now() + 14.5 * 60_000 };
  runInNewContext(`${code}; renderSettings(settings)`, context);
  expect(session.textContent).toBe("Settings session: 15 min left");
  expect(root.text()).not.toContain("needs a settings session");
  // The page stays inside its CSP: no inline handler came with the section, and both inline scripts still compile.
  expect(html).not.toMatch(/\son[a-z]+="/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(scripts).toHaveLength(2);
  for (const source of scripts) expect(() => new Script(source)).not.toThrow();
  expect(html.match(/<section aria-labelledby="settings-title">/g)).toHaveLength(1);
});

test("checkSettingValue and settingRefusal: the pure rules behind every surface", () => {
  expect(checkSettingValue(def("routing.classes.implement.peers"), ["kimi", "codex"])).toEqual(["kimi", "codex"]);
  expect(checkSettingValue(def("routing.classes.implement.route"), "sy/coding", ["sy/coding"])).toBe("sy/coding");
  expect(checkSettingValue(def("research.enabled"), null)).toBeNull();
  expect(() => checkSettingValue(def("permission.kimi"), null)).toThrow("no stored value");
  expect(settingRefusal(def("research.enabled"), true, "ordinary")).toBeUndefined();
  expect(settingRefusal(def("permission.kimi"), "ask", "ordinary")).toBeUndefined();
  expect(settingRefusal(def("permission.kimi"), "ask-when-needed", "ordinary")).toContain("ahub ui --settings");
  expect(settingRefusal(def("permission_modes.kimi"), null, "ordinary")).toContain("ahub ui --settings"); // removing a local ask can raise
  for (const authority of ["settings", "terminal"] as const) expect(settingRefusal(def("permission.kimi"), "never-ask", authority)).toBeUndefined();
});

const CLI = join(import.meta.dir, "../src/cli/main.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION"];
/** The real CLI in a child whose agent markers are bound in a wrapper, as test/identity-cli.test.ts does. */
async function cli(root: string, args: string[], markers: Record<string, string> = {}) {
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify(markers)}, { AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))} });
process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(CLI)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test("AC8: ahub settings list, get, set, undo and ahub ui --settings work from a terminal and are refused in an agent shell", async () => {
  const rig = await hub();
  const local = rig.file("config.local.json");
  const listed = await cli(rig.cwd, ["settings"]);
  expect(listed.code).toBe(0);
  for (const heading of ["Permissions", "Start", "Routing", "Switches"]) expect(listed.stdout).toContain(`${heading}\n`);
  expect(listed.stdout).toMatch(/ {2}pi\.auto_start +true +from config\.json; read at hub start\n/);
  expect(listed.stdout).toMatch(/ {2}permission\.kimi +ask +from this hub run; applies at once; not attached: only ask can be set\n/);
  expect(JSON.parse((await cli(rig.cwd, ["settings", "list", "--json"])).stdout).rows).toHaveLength(SETTINGS.length);

  expect(await cli(rig.cwd, ["settings", "set", "research.enabled", "true"])).toEqual({ code: 0, stdout: "research.enabled: true (applies at the next hub start)\n", stderr: "" });
  expect(JSON.parse(text(local)!)).toEqual({ research: { enabled: true } });
  const got = await cli(rig.cwd, ["settings", "get", "research.enabled"]);
  // The hub in this test was started with the value false: the row shows what runs and what the next start reads.
  expect(got.stdout).toContain("research.enabled  false  from config.local.json; read at hub start; true at the next hub start\n");
  expect(got.stdout).toContain("written to config.local.json; takes true, false, or inherit to remove the machine-local value");
  expect(JSON.parse((await cli(rig.cwd, ["settings", "get", "research.enabled", "--json"])).stdout)).toMatchObject({ key: "research.enabled", value: false, pending: true, source: "config.local.json" });

  const order = await cli(rig.cwd, ["settings", "set", "routing.classes.implement.peers", "kimi,codex", "--preview"]);
  expect(order.code).toBe(0);
  expect(order.stdout).toContain("-> kimi,codex\n"); expect(order.stdout).toContain("preview only; nothing was changed\n");
  expect(text(rig.file(OVERLAY_FILE))).toBeNull();
  expect((await cli(rig.cwd, ["settings", "set", "routing.classes.implement.peers", "kimi,codex"])).stdout).toBe("routing.classes.implement.peers: kimi,codex (in force now)\n");
  expect(currentRouting(rig.cwd).classes.implement!.peers).toEqual(["kimi", "codex"]);
  expect((await cli(rig.cwd, ["settings", "undo"])).stdout).toContain("routing.classes.implement.peers: put back to ");
  expect(text(rig.file(OVERLAY_FILE))).toBeNull();
  expect((await cli(rig.cwd, ["settings", "set", "research.enabled", "inherit"])).code).toBe(0);
  expect(JSON.parse(text(local)!)).toEqual({});

  // never-ask: --yes is the terminal's confirmation, checked before anything is sent; the bounds are printed with it.
  const refused = await cli(rig.cwd, ["settings", "set", "permission_modes.kimi", "never-ask"]);
  expect(refused).toMatchObject({ code: 1, stdout: "" }); expect(refused.stderr).toContain("never-ask requires --yes; nothing was changed");
  const confirmed = await cli(rig.cwd, ["settings", "set", "permission_modes.kimi", "never-ask", "--yes"]);
  expect(confirmed.code).toBe(0); expect(confirmed.stderr).toContain("never-ask: kimi: runs its own tools; NO hub sandbox");
  expect(JSON.parse(text(local)!)).toEqual({ permission_modes: { kimi: "never-ask" } });

  for (const args of [["settings", "set", "research.enabled"], ["settings", "get"], ["settings", "list", "extra"], ["settings", "frobnicate"], ["settings", "set", "research.enabled", "true", "--force"], ["settings", "undo", "now"]]) {
    const bad = await cli(rig.cwd, args);
    expect(bad.code).toBe(1); expect(bad.stderr).toContain("usage: ahub settings");
  }
  expect((await cli(rig.cwd, ["settings", "set", "kimi_cmd", "sh"])).stderr).toContain("never editable from settings");
  expect((await cli(rig.cwd, ["settings", "set", "research.enabled", "maybe"])).stderr).toContain("true or false");

  const opened = await cli(rig.cwd, ["ui", "--settings", "--no-open"]);
  expect(opened.code).toBe(0);
  expect(opened.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64}\n$/);
  expect(opened.stderr).toContain("Settings session: for 15 minutes");
  expect((await cli(rig.cwd, ["ui", "--settings", "--all"])).stderr).toContain("run it without --all");
  expect(readFileSync(join(rig.stateDir, "hub.log"), "utf8")).toContain("settings session opened from ahub ui --settings");

  // An agent shell: refused by the identity gate before any connection, for reads and writes alike.
  const before = text(local);
  for (const args of [["settings"], ["settings", "get", "research.enabled"], ["settings", "set", "research.enabled", "false"], ["settings", "undo"], ["ui", "--settings", "--no-open"]]) {
    for (const markers of [{ AGENTHUB_PEER_ID: "kimi" }, { CLAUDECODE: "1" }] as Record<string, string>[]) {
      const result = await cli(rig.cwd, args, markers);
      expect(result).toMatchObject({ code: 1, stdout: "" });
      expect(result.stderr).toContain("the person runs it in ahub console or a terminal");
    }
  }
  expect(text(local)).toBe(before);
}, 60_000);
