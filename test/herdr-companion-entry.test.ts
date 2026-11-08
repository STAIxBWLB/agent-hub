import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdrModHost, HERDR_FIXTURE_COMMANDS, type HerdrFixtureCliPort, type HerdrFixtureExecCall, type HerdrFixtureFocus, type HerdrFixtureSpace } from "./helpers/herdr-mod-host.ts";
// @ts-ignore TS7016: untyped plain JavaScript by design
import * as core from "../integrations/herdr/mod/core.js";

// #1199 H1 (task #794): the entry point's decisions, run against the H0 fake host. Nothing here starts Herdr, loads the mod into a profile or reaches a machine. The native open
// and disable receipt is person-run, and `herdr-app check` below (skipped where the binary is absent) proves only that the host accepts the files, not what they do in a window.
const MOD = join(import.meta.dir, "../integrations/herdr/mod");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Row = { id: string; root: string; state?: string; status?: unknown; stateDir?: string };
interface Cfg {
  rows?: Record<string, Row[] | string>;               // by machine ("" = this computer): rows, or raw stdout
  status?: (cwd: string | undefined, on: string | null | undefined) => { stdout?: string; stderr?: string; exitCode?: number | null; truncated?: boolean; timedOut?: boolean };
  ui?: { stdout?: string; exitCode?: number };
  hold?: { status?: Promise<void>; reached?: () => void };
}
const space = (id: string, machine: string | null, tabs = 1): HerdrFixtureSpace => ({ id, index: 1, name: id, folder: "/home", machine, tabs: Array.from({ length: tabs }, (_, i) => ({ id: `${id}/t${i + 1}`, index: i + 1, name: `${i + 1}` })) });
const focus = (cwd: string | null, extra: Partial<HerdrFixtureFocus> = {}): HerdrFixtureFocus => ({ space: "s1", tab: "s1/t1", pane: "p1", terminal: "t7", shown: null, agent: null, cwd, ...extra });
const b64 = (s: string) => s;

function setup(cfg: Cfg = {}, opts: { machine?: string | null; cwd?: string | null; platform?: string; machines?: { name: string | null; layout: "loading" | "ready" | "unavailable" }[] } = {}) {
  const machine = opts.machine === undefined ? null : opts.machine;
  const rows = cfg.rows ?? { "": [{ id: "p_a", root: "/work/a", state: "running" }] };
  const execs: HerdrFixtureExecCall[] = [];
  const cli: HerdrFixtureCliPort = async call => {
    execs.push({ ...call, args: [...call.args] });
    const key = call.on ?? "";
    // ahub's own rule (src/cli/main.ts): `--project <id>` selects the registration with the state directory it recorded; with no selector the project is resolved from the cwd and the DEFAULT
    // state directory is assumed. The fake models both, so a command that forgets the selector fails for a project with a custom state directory, as it does for real.
    const selector = call.args[0] === "--project" ? call.args[1] : null;
    const j = (selector === null ? call.args : call.args.slice(2)).join(" ");
    const ok = (stdout: string, exitCode = 0, extra = {}) => ({ stdout, stderr: "", exitCode, timedOut: false, truncated: false, ...extra });
    if (j === "projects --json") {
      const r = rows[key];
      if (r === undefined) return ok("", 1, { stderr: "ahub: command not found" });
      return ok(typeof r === "string" ? r : JSON.stringify(r.map(x => ({ stateDir: `${x.root}/.agenthub/state`, basePort: 4600, ...x, state: x.state ?? "running", status: x.status ?? { big: "x".repeat(200) } }))));
    }
    if (j === "status --json") {
      if (cfg.hold?.status) { cfg.hold.reached?.(); await cfg.hold.status; }
      if (cfg.status) { const r = cfg.status(call.cwd, call.on); return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode === undefined ? 0 : r.exitCode, timedOut: r.timedOut ?? false, truncated: r.truncated ?? false }; }
      const list = rows[key];
      const hit = !Array.isArray(list) ? undefined
        : selector !== null ? list.find(x => x.id === selector)
        : list.find(x => x.root === call.cwd && (x.stateDir ?? `${x.root}/.agenthub/state`) === `${x.root}/.agenthub/state`);
      return hit ? ok(JSON.stringify({ projectId: hit.id, cwd: hit.root })) : ok("", 1, { stderr: "ahub: no hub running for /x/.agenthub/state (run: ahub up)\n" });
    }
    if (j === "ui") return ok(cfg.ui?.stdout ?? "", cfg.ui?.exitCode ?? 0);
    throw new Error(`unexpected exec ${j}`);
  };
  const fake = new FakeHerdrModHost({ offeredFunctions: ["exec", "run", "spaces", "panes", "focused", "machines", "terminals", "commands"], offeredCommands: Object.keys(HERDR_FIXTURE_COMMANDS),
    spaces: [space("s1", machine)], focused: focus(opts.cwd === undefined ? "/work/a/src" : opts.cwd), cli,
    machines: opts.machines ?? [{ name: null, layout: "ready" }, { name: "vps", layout: "ready" }], syntheticState: { terminals: ["t7"], agents: ["a1"] } });
  const runs: { name: string; args: Record<string, unknown> }[] = [];
  const host = {
    exec: (c: string, a?: string[], o?: unknown) => fake.exec(c, a, o), spaces: () => fake.spaces(), machines: () => fake.machines(), focused: () => fake.focused(),
    // the fake's run records the call; here a successful tab.new also adds a tab, as the real host does when it applies the command
    run: (name: string, args: Record<string, unknown>) => { fake.run(name, args); runs.push({ name, args: JSON.parse(JSON.stringify(args)) });
      if (name === "tab.new") fake.setSpaces(fake.spaces().map(s => s.id === args.space ? { ...s, tabs: [...s.tabs, { id: `${s.id}/t${s.tabs.length + 1}`, index: s.tabs.length + 1, name: "new" }] } : s)); return null; },
    platform: () => opts.platform ?? "macos",
  };
  const entry = core.createHerdrEntry({ host });
  return { fake, host, entry, execs, runs };
}
const pick = async (s: ReturnType<typeof setup>, id = "p_a") => { await s.entry.refresh(); return s.entry.select(id); };

test("refresh shows the machine and folder, lists registered projects, and marks the one that contains the folder without choosing it", async () => {
  const s = setup({ rows: { "": [{ id: "p_a", root: "/work/a" }, { id: "p_ab", root: "/work/ab" }, { id: "p_z", root: "/zzz", state: "stopped" }] } });
  const v = await s.entry.refresh();
  expect(v).toMatchObject({ status: "ready", machine: null, machineLabel: "this computer", cwd: "/work/a/src", candidate: "single", highlighted: "p_a", selection: null });
  expect(v.rows.map((r: { id: string }) => r.id)).toEqual(["p_a", "p_ab", "p_z"]);
  expect(v.rows[0]).toEqual({ id: "p_a", root: "/work/a", state: "running", candidate: true });
  // only id, root and state are kept: the embedded status each row carries is dropped and never appears in the view
  expect(JSON.stringify(v)).not.toContain("xxxxxxxx"); expect(JSON.stringify(v)).not.toContain("stateDir");
  expect(s.execs.map(c => c.args.join(" "))).toEqual(["projects --json"]);
  expect(s.runs).toEqual([]); // opening the entry runs nothing in Herdr
});

test("AC1: a single candidate is only a default: nothing opens until the person selects, and ambiguity is never resolved silently", async () => {
  const s = setup({ rows: { "": [{ id: "p_o", root: "/work" }, { id: "p_i", root: "/work/a" }] } });
  const v = await s.entry.refresh();
  expect(v).toMatchObject({ candidate: "ambiguous", highlighted: "p_i", selection: null });
  expect(await s.entry.openConsole()).toMatchObject({ ok: false, refusal: "no_selection" });
  expect(s.entry.copyCommand()).toMatchObject({ ok: false, refusal: "no_selection" });
  expect(s.runs).toEqual([]);
  const sel = s.entry.select("p_o");
  expect(sel).toMatchObject({ ok: true, selection: { id: "p_o", root: "/work", machine: null } });
});

test("AC2: after the selection, Open console is ONE explicit action: it re-reads, proves the project, and opens one tab with fixed argv and the root as the folder", async () => {
  const s = setup(); await pick(s);
  const r = await s.entry.openConsole();
  expect(r).toMatchObject({ ok: true, opened: "console", machineLabel: "this computer" });
  expect(s.runs).toEqual([{ name: "tab.new", args: { space: "s1", folder: "/work/a", argv: ["ahub", "--project", "p_a", "console"], name: "ahub: a" } }]);
  // the exec calls are the two bounded reads and the project proof, all fixed argv, the proof run from the project folder
  expect(s.execs.map(c => [c.command, c.args.join(" "), c.cwd, c.on])).toEqual([["ahub", "projects --json", undefined, undefined], ["ahub", "projects --json", undefined, undefined], ["ahub", "--project p_a status --json", "/work/a", undefined]]);
  for (const c of s.execs) { expect(c.timeoutMs).toBe(30_000); expect(c.maxOutputBytes).toBe(8 * 1024 * 1024); }
});

test("AC1/AC8: special-character folders are opaque: never in a command line, only as the tab's folder, and a copied command is one quoted word", async () => {
  const weird = "/work/it's a \"proj\" $(rm -rf x);`y` ü 한글 & | > <";
  const s = setup({ rows: { "": [{ id: "p_w", root: weird }] } }, { cwd: `${weird}/sub` });
  await pick(s, "p_w");
  expect((await s.entry.openConsole()).ok).toBe(true);
  expect(s.runs[0]!.args.folder).toBe(weird);
  expect(JSON.stringify(s.runs[0]!.args.argv)).toBe('["ahub","--project","p_w","console"]');
  expect(s.execs.find(c => c.args.includes("status"))!.cwd).toBe(weird);
  for (const c of s.execs) expect(c.args.join(" ")).not.toContain("rm -rf");
  const copy = s.entry.copyCommand();
  expect(copy.command).toBe(`ahub --project '/work/it'\\''s a "proj" $(rm -rf x);\`y\` ü 한글 & | > <' console`);
  // the quoted word survives a real POSIX shell as exactly the original text
  const echoed = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${core.posixQuote(weird)}`]).stdout.toString();
  expect(echoed).toBe(weird);
  expect(core.posixQuote("a\nb")).toBeNull(); expect(core.posixQuote("")).toBeNull(); expect(core.posixQuote("a\u0000b")).toBeNull();
});

test("AC1: a remote space reads and proves its project ON its machine, opens the tab in that space, and never runs anything here", async () => {
  const s = setup({ rows: { vps: [{ id: "p_r", root: "/home/dev/app" }] } }, { machine: "vps", cwd: "/home/dev/app/src" });
  expect((await s.entry.refresh())).toMatchObject({ status: "ready", machine: "vps", machineLabel: "vps", candidate: "single" });
  s.entry.select("p_r");
  expect(await s.entry.openConsole()).toMatchObject({ ok: true, opened: "console", machineLabel: "vps" });
  expect(s.execs.every(c => c.on === "vps")).toBe(true);
  expect(s.execs.some(c => c.on === null || c.on === undefined)).toBe(false);
  expect(s.execs.find(c => c.args.includes("status"))!.cwd).toBe("/home/dev/app");
  expect(s.runs[0]).toMatchObject({ name: "tab.new", args: { space: "s1", folder: "/home/dev/app" } });
  expect(JSON.stringify(s.runs[0])).not.toMatch(/vps/); // tab.new takes no machine: the space is the machine
  expect(existsSync("/home/dev/app")).toBe(false);
});

test("AC3: the dashboard is local only; for a remote space it refuses before anything runs and the copyable command names the machine, with no link", async () => {
  const s = setup({ rows: { vps: [{ id: "p_r", root: "/home/dev/app" }] } }, { machine: "vps", cwd: "/home/dev/app" });
  await pick(s, "p_r");
  const before = s.execs.length;
  const r = await s.entry.openDashboard();
  expect(r).toMatchObject({ ok: false, refusal: "remote" });
  expect(s.execs.length).toBe(before); // nothing ran for the refusal
  expect(JSON.stringify(r)).not.toMatch(/https?:\/\/|127\.0\.0\.1|localhost/);
  expect(s.entry.copyCommand()).toEqual({ ok: true, command: "ahub --project '/home/dev/app' console", machine: "vps", machineLabel: "vps" });
});

test("AC3: the local dashboard runs the existing `ahub ui` from the project folder, drops its output, and refuses to keep or show a link or ticket", async () => {
  const ok = setup({ ui: { stdout: "", exitCode: 0 } }); await pick(ok);
  expect(await ok.entry.openDashboard()).toEqual({ ok: true, opened: "dashboard", machineLabel: "this computer" });
  expect(ok.execs.at(-1)).toMatchObject({ command: "ahub", args: ["--project", "p_a", "ui"], cwd: "/work/a" });
  const ticket = "http://127.0.0.1:4601/?ticket=SECRET-ONE-TIME-abc123";
  const link = setup({ ui: { stdout: `${ticket}\n`, exitCode: 0 } }); await pick(link);
  const r = await link.entry.openDashboard();
  expect(r).toMatchObject({ ok: false, refusal: "link_printed" });
  for (const text of [JSON.stringify(r), JSON.stringify(link.entry.view()), JSON.stringify(link.runs)]) { expect(text).not.toContain("SECRET-ONE-TIME"); expect(text).not.toContain("ticket="); expect(text).not.toContain("127.0.0.1"); }
  const bad = setup({ ui: { stdout: "boom", exitCode: 1 } }); await pick(bad);
  expect(await bad.entry.openDashboard()).toMatchObject({ ok: false, refusal: "cli_failed" });
  expect(bad.runs).toEqual([]);
});

test("AC8: a machine that is unknown, loading or unavailable refuses, and nothing is read or run", async () => {
  for (const [machines, refusal] of [
    [[{ name: null, layout: "ready" as const }], "unknown_machine"],
    [[{ name: null, layout: "ready" as const }, { name: "vps", layout: "loading" as const }], "machine_unavailable"],
    [[{ name: null, layout: "ready" as const }, { name: "vps", layout: "unavailable" as const }], "machine_unavailable"],
  ] as const) {
    const s = setup({ rows: { vps: [{ id: "p_r", root: "/home/dev/app" }] } }, { machine: "vps", cwd: "/home/dev/app", machines: [...machines] });
    expect(await s.entry.refresh()).toMatchObject({ status: "refused", refusal });
    expect(s.execs).toEqual([]); expect(s.runs).toEqual([]);
  }
  const none = setup({}, { machines: [] });
  expect(await none.entry.refresh()).toMatchObject({ status: "refused", refusal: "machine_unavailable" });
  expect(none.execs).toEqual([]);
});

test("AC8: machine loss after selection refuses at the effect, before any tab is opened", async () => {
  const s = setup({ rows: { vps: [{ id: "p_r", root: "/home/dev/app" }] } }, { machine: "vps", cwd: "/home/dev/app" });
  await pick(s, "p_r");
  s.fake.setMachines([{ name: null, layout: "ready" }, { name: "vps", layout: "unavailable" }]);
  const before = s.execs.length;
  expect(await s.entry.openConsole()).toMatchObject({ ok: false, refusal: "machine_unavailable" });
  expect(s.execs.length).toBe(before); expect(s.runs).toEqual([]);
});

test("AC1/AC8: a duplicate, replaced, moved or re-pointed project is explicit and nothing opens", async () => {
  const dup = setup({ rows: { "": [{ id: "p_1", root: "/work/a" }, { id: "p_2", root: "/work/a" }] } });
  expect(await dup.entry.refresh()).toMatchObject({ status: "refused", refusal: "duplicate" });
  const dupId = setup({ rows: { "": [{ id: "p_1", root: "/work/a" }, { id: "p_1", root: "/work/b" }] } });
  expect(await dupId.entry.refresh()).toMatchObject({ refusal: "duplicate" });
  // replaced: the same root now belongs to another registration
  const rows: Record<string, Row[]> = { "": [{ id: "p_a", root: "/work/a" }] };
  const re = setup({ rows }); await pick(re);
  rows[""] = [{ id: "p_new", root: "/work/a" }];
  expect(await re.entry.openConsole()).toMatchObject({ ok: false, refusal: "changed" });
  // moved or removed: the root is gone from the list
  rows[""] = [{ id: "p_a", root: "/work/elsewhere" }];
  expect(await re.entry.openConsole()).toMatchObject({ ok: false, refusal: "changed" });
  // re-pointed: the list still says p_a at /work/a, but running from that folder resolves to another project
  rows[""] = [{ id: "p_a", root: "/work/a" }];
  const point = setup({ rows, status: () => ({ stdout: JSON.stringify({ projectId: "p_other" }) }) }); await pick(point);
  expect(await point.entry.openConsole()).toMatchObject({ ok: false, refusal: "changed" });
  for (const x of [dup, dupId, re, point]) expect(x.runs).toEqual([]);
});

test("review thread (custom state directory): every project command names the registration by id, so a project with a custom state directory is not read as offline", async () => {
  const rows = { "": [{ id: "p_c", root: "/work/c", stateDir: "/elsewhere/custom-state" }] };
  const s = setup({ rows }, { cwd: "/work/c/src" });
  // the fake models ahub: a folder-only status call assumes the default state directory and so finds no hub for this registration
  const folderOnly = await s.host.exec("ahub", ["status", "--json"], { cwd: "/work/c" });
  expect(folderOnly.code).toBe(1); expect(folderOnly.stderr).toContain("no hub running");
  const byId = await s.host.exec("ahub", ["--project", "p_c", "status", "--json"], { cwd: "/work/c" });
  expect(byId.code).toBe(0);
  const probes = s.execs.length; // the two direct probes above are the test's own, not the entry's
  await pick(s, "p_c");
  expect(await s.entry.openConsole()).toMatchObject({ ok: true, opened: "console" });
  expect(s.runs[0]!.args.argv).toEqual(["ahub", "--project", "p_c", "console"]);
  const mine = s.execs.slice(probes).filter(c => c.args.includes("status"));
  expect(mine.length).toBeGreaterThan(0);
  expect(mine.every(c => c.args[0] === "--project" && c.args[1] === "p_c" && c.args[2] === "status")).toBe(true);
  const dash = await s.entry.openDashboard();
  expect(dash).toMatchObject({ ok: true, opened: "dashboard" });
  expect(s.execs.at(-1)).toMatchObject({ command: "ahub", args: ["--project", "p_c", "ui"], cwd: "/work/c" });
  // the selector never carries a shell: an id with a leading dash, a space or a metacharacter is refused at the read, so it cannot become a flag or a second word
  for (const id of ["-x", "--project", "a b", "p;rm", "p$(x)", "", "p\nq"]) {
    const bad = setup({ rows: { "": JSON.stringify([{ id, root: "/work/c" }]) } });
    expect(await bad.entry.refresh(), JSON.stringify(id)).toMatchObject({ status: "refused", refusal: "bad_output" });
    expect(bad.runs).toEqual([]);
  }
});

test("review thread (cwd proof): a registration whose reported folder is not the selected root is `changed`, never opened", async () => {
  const s = setup({ status: () => ({ stdout: JSON.stringify({ projectId: "p_a", cwd: "/somewhere/else" }) }) }); await pick(s);
  expect(await s.entry.openConsole()).toMatchObject({ ok: false, refusal: "changed" });
  const none = setup({ status: () => ({ stdout: JSON.stringify({ projectId: "p_a" }) }) }); await pick(none);
  expect(await none.entry.openConsole()).toMatchObject({ ok: false, refusal: "bad_output" });
  expect(s.runs).toEqual([]); expect(none.runs).toEqual([]);
});

test("review thread (machine change during the reads): the space and machine are re-read right before the tab, so a console is never opened on a machine other than the one checked", async () => {
  const hold = (n: number) => {
    let release!: () => void, reached!: () => void;
    return { release: () => release(), at: new Promise<void>(r => { reached = r; }), gate: new Promise<void>(r => { release = r; }), reached: () => reached() };
  };
  const scenarios: [string, (s: ReturnType<typeof setup>) => void, string][] = [
    ["the space moves to another machine", s => s.fake.setSpaces([space("s1", "vps")]), "changed"],
    ["the checked machine becomes unavailable", s => s.fake.setMachines([{ name: null, layout: "unavailable" }, { name: "vps", layout: "ready" }]), "machine_unavailable"],
    ["the machine goes away", s => s.fake.setMachines([]), "machine_unavailable"],
    ["the space is closed", s => s.fake.setSpaces([]), "changed"],
  ];
  for (const [name, change, refusal] of scenarios) {
    const h = hold(0);
    const s = setup({ hold: { status: h.gate, reached: h.reached } }); await pick(s);
    const pending = s.entry.openConsole();
    await h.at; // the action is inside the project proof, after both earlier reads
    change(s);
    h.release();
    expect(await pending, name).toMatchObject({ ok: false, refusal });
    expect(s.runs, name).toEqual([]);
  }
  // the same for a remote selection whose space is moved onto this computer while the proof is held
  const h = hold(0);
  const remote = setup({ rows: { vps: [{ id: "p_r", root: "/home/dev/app" }] }, hold: { status: h.gate, reached: h.reached } }, { machine: "vps", cwd: "/home/dev/app" });
  await pick(remote, "p_r");
  const pending = remote.entry.openConsole();
  await h.at;
  remote.fake.setSpaces([space("s1", null)]);
  h.release();
  expect(await pending).toMatchObject({ ok: false, refusal: "changed" });
  expect(remote.runs).toEqual([]);
  // and the dashboard is guarded the same way (its machine is checked again before `ahub ui` runs)
  const hd = hold(0);
  const dash = setup({ hold: { status: hd.gate, reached: hd.reached } }); await pick(dash);
  const pd = dash.entry.openDashboard();
  await hd.at;
  dash.fake.setSpaces([space("s1", "vps")]);
  hd.release();
  expect(await pd).toMatchObject({ ok: false, refusal: "changed" });
  expect(dash.execs.some(c => c.args.includes("ui"))).toBe(false);
});

test("review thread (tab confirmation): a tab that appears in the space while ahub was answering is not mistaken for the console that was opened", async () => {
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(r => { release = r; }), at = new Promise<void>(r => { reached = r; });
  const s = setup({ hold: { status: gate, reached } }); await pick(s);
  const pending = s.entry.openConsole();
  await at;
  // someone opens a tab in the same space during the held read; the tab list the entry compares against must be the one read right before its own request
  s.fake.setSpaces([space("s1", null, 2)]);
  release();
  const r = await pending;
  expect(r).toMatchObject({ ok: true, opened: "console" });
  expect(r.tab).toBe("s1/t3"); // the third tab is the one this request opened, not the second that was already there
});

test("review thread (cwd proof): a reported folder that only starts with the selected root is `changed`, not accepted", async () => {
  for (const reported of ["/work/a/sub", "/work/ab", "/work", "/work/a/"]) {
    const s = setup({ status: () => ({ stdout: JSON.stringify({ projectId: "p_a", cwd: reported }) }) }); await pick(s);
    expect(await s.entry.openConsole(), reported).toMatchObject({ ok: false, refusal: "changed" });
    expect(s.runs, reported).toEqual([]);
  }
});

test("AC1: a space that is gone, or moved to another machine, since selection is `changed`", async () => {
  const gone = setup(); await pick(gone);
  gone.fake.setSpaces([]);
  expect(await gone.entry.openConsole()).toMatchObject({ ok: false, refusal: "changed" });
  const moved = setup(); await pick(moved);
  moved.fake.setSpaces([space("s1", "vps")]);
  expect(await moved.entry.openConsole()).toMatchObject({ ok: false, refusal: "changed" });
  expect(gone.runs).toEqual([]); expect(moved.runs).toEqual([]);
});

test("AC4/AC8: no running hub is `offline` with the setup instruction, and the entry never starts it", async () => {
  const s = setup({ status: () => ({ exitCode: 1, stderr: "ahub: no hub running for /work/a/.agenthub/state (run: ahub up)\n" }) }); await pick(s);
  const r = await s.entry.openConsole();
  expect(r).toMatchObject({ ok: false, refusal: "offline" });
  expect(r.message).toMatch(/ahub up/); expect(r.message).toMatch(/never starts/);
  expect(s.runs).toEqual([]);
  expect(s.execs.every(c => c.args[0] === "projects" || (c.args[0] === "--project" && c.args[2] === "status"))).toBe(true);
});

test("AC8: invalid, truncated, oversized or wrong-shaped output refuses with a distinct state and never opens anything", async () => {
  const cases: [string, Cfg, string][] = [
    ["not json", { rows: { "": "not json" } }, "bad_output"], ["an object", { rows: { "": "{}" } }, "bad_output"], ["cut off", { rows: { "": '[{"id":"p","root":"/x"' } }, "bad_output"],
    ["bad row", { rows: { "": '[{"id":1,"root":"/x"}]' } }, "bad_output"], ["relative root", { rows: { "": '[{"id":"p","root":"x"}]' } }, "bad_output"],
    ["control character in a root", { rows: { "": JSON.stringify([{ id: "p", root: "/x\n/y" }]) } }, "bad_output"],
    ["too many", { rows: { "": JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ id: `p${i}`, root: `/w/${i}` }))) } }, "too_many"],
    ["no ahub there", { rows: {} }, "cli_failed"],
  ];
  for (const [name, cfg, refusal] of cases) {
    const s = setup(cfg);
    expect(await s.entry.refresh(), name).toMatchObject({ status: "refused", refusal });
    expect(s.runs).toEqual([]);
  }
  // the status proof: not json, no projectId, truncated and timed out all refuse at the effect
  for (const [name, status, refusal] of [
    ["status not json", () => ({ stdout: "nope" }), "bad_output"], ["status no id", () => ({ stdout: "{}" }), "bad_output"],
    ["status truncated", () => ({ stdout: "{", truncated: true }), "read_failed"], ["status timeout", () => ({ stdout: "", timedOut: true, exitCode: null }), "read_failed"],
    ["status exit 2", () => ({ exitCode: 2, stderr: "weird" }), "cli_failed"],
  ] as [string, Cfg["status"], string][]) {
    const s = setup({ status }); await pick(s);
    expect(await s.entry.openConsole(), name).toMatchObject({ ok: false, refusal });
    expect(s.runs, name).toEqual([]);
  }
  // a refusal carries a fixed sentence, never raw CLI output
  const leak = setup({ status: () => ({ exitCode: 3, stderr: "SECRET /private/path token=abc" }) }); await pick(leak);
  const r = await leak.entry.openConsole();
  expect(JSON.stringify(r)).not.toContain("SECRET"); expect(JSON.stringify(r)).not.toContain("/private");
});

test("AC8: the biggest list the entry accepts is within the exec output cap, and the registration rows are bounded by what the real CLI emits", () => {
  // a measured real row is about 13.6 KB (it embeds a whole status); 500 of them is under the 8 MiB cap, so the row count is bounded before the byte cap is
  expect(core.MAX_PROJECTS * 13_640).toBeLessThan(8 * 1024 * 1024);
});

test("AC8: rapid project switches: a second refresh or selection supersedes a running action, and a second click while one runs opens nothing extra", async () => {
  let release!: () => void, reached!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const atStatus = new Promise<void>(resolve => { reached = resolve; });
  const s = setup({ hold: { status: hold, reached } }); await pick(s);
  const first = s.entry.openConsole();
  expect(await s.entry.openConsole()).toMatchObject({ ok: false, refusal: "busy" }); // a double click is refused while one runs
  await atStatus; // the action is now inside the project proof, past its first re-read
  await s.entry.refresh(); // the person switched: a new read supersedes the running action
  release();
  expect(await first).toMatchObject({ ok: false, refusal: "stale" });
  expect(s.runs).toEqual([]); // the superseded action stopped before it opened anything
  // after the switch, a fresh selection works and opens exactly one tab
  s.entry.select("p_a");
  expect((await s.entry.openConsole()).ok).toBe(true);
  expect(s.runs).toHaveLength(1);
});

test("the root match is at a path-segment boundary in the shipped core too, so a sibling with a shared prefix is never a candidate", async () => {
  expect(core.containsAtBoundary("/work/a", "/work/a")).toBe(true);
  expect(core.containsAtBoundary("/work/a", "/work/a/src")).toBe(true);
  expect(core.containsAtBoundary("/work/a", "/work/ab")).toBe(false);
  expect(core.containsAtBoundary("/work/a/", "/work/a/src")).toBe(true);
  expect(core.containsAtBoundary("work/a", "/work/a")).toBe(false);
  const s = setup({ rows: { "": [{ id: "p_a", root: "/work/a" }, { id: "p_ab", root: "/work/ab" }] } }, { cwd: "/work/ab/src" });
  const v = await s.entry.refresh();
  expect(v).toMatchObject({ candidate: "single", highlighted: "p_ab" });
  expect(v.rows.find((r: { id: string }) => r.id === "p_a").candidate).toBe(false);
});

test("a refusal and the view carry only fixed sentences and closed words, never CLI text, for every failing path", async () => {
  const marker = "LEAK-MARKER-/private/tok-123";
  const runs: [string, Cfg, (s: ReturnType<typeof setup>) => Promise<unknown>][] = [
    ["status exit", { status: () => ({ exitCode: 5, stderr: marker, stdout: marker }) }, s => s.entry.openConsole()],
    ["status bad json", { status: () => ({ stdout: marker }) }, s => s.entry.openConsole()],
    ["ui exit", { ui: { stdout: marker, exitCode: 1 } }, s => s.entry.openDashboard()],
    ["rows bad json", { rows: { "": marker } }, s => s.entry.refresh()],
  ];
  for (const [name, cfg, act] of runs) {
    const s = setup(cfg);
    if (name.startsWith("rows")) { const r = await act(s); expect(JSON.stringify(r), name).not.toContain("LEAK-MARKER"); continue; }
    await pick(s);
    const r = await act(s);
    expect(JSON.stringify(r), name).not.toContain("LEAK-MARKER"); expect(JSON.stringify(s.entry.view()), name).not.toContain("LEAK-MARKER");
    expect(Object.keys(r as object).sort(), name).toEqual(["message", "ok", "refusal"]);
    expect(core.REFUSALS[(r as { refusal: string }).refusal], name).toBe((r as { message: string }).message);
  }
});

test("AC8: Herdr refusing the request, or not showing a new tab, is reported and never retried", async () => {
  const refused = setup(); await pick(refused);
  const original = refused.host.run;
  refused.host.run = () => { throw new Error("Herdr says no"); };
  expect(await refused.entry.openConsole()).toMatchObject({ ok: false, refusal: "host_refused" });
  refused.host.run = original;
  const silent = setup(); await pick(silent);
  let calls = 0;
  silent.host.run = (name: string, args: Record<string, unknown>) => { calls++; silent.fake.run(name, args); return null; }; // accepted, but no tab appears
  expect(await silent.entry.openConsole()).toMatchObject({ ok: false, refusal: "unconfirmed" });
  expect(calls).toBe(1);
});

test("AC8: on Windows nothing is read, opened or copied, because the folder and quoting rules here are POSIX", async () => {
  // a Windows window refuses at the first read: no registration is listed, so nothing can be selected
  const s = setup({}, { platform: "windows" });
  expect(await s.entry.refresh()).toMatchObject({ status: "refused", refusal: "unsupported_platform" });
  expect(s.execs).toEqual([]); expect(s.runs).toEqual([]);
  // and if the platform answer changes after a selection, every effect still refuses on its own (defense in depth)
  let platform = "macos";
  const flip = setup({}); flip.host.platform = () => platform;
  const entry = core.createHerdrEntry({ host: flip.host });
  await entry.refresh(); entry.select("p_a"); platform = "windows";
  const before = flip.execs.length;
  expect(await entry.openConsole()).toMatchObject({ ok: false, refusal: "unsupported_platform" });
  expect(await entry.openDashboard()).toMatchObject({ ok: false, refusal: "unsupported_platform" });
  expect(await entry.refreshCard()).toMatchObject({ ok: false, refusal: "unsupported_platform" });
  expect(entry.copyCommand()).toMatchObject({ ok: false, refusal: "unsupported_platform" });
  expect(flip.execs.length).toBe(before); expect(flip.runs).toEqual([]);
  expect(core.containsAtBoundary("C:\\work", "C:\\work\\a")).toBe(false);
});

test("the boundary: across a full flow only fixed `ahub` argument lists reach exec, and only `tab.new` reaches run", async () => {
  const s = setup(); await pick(s);
  await s.entry.openConsole(); await pick(s); await s.entry.openDashboard(); s.entry.copyCommand();
  const allowed = new Set([core.FIXED.projects.join(" "), core.projectArgs("p_a", core.FIXED.status).join(" "), core.projectArgs("p_a", core.FIXED.ui).join(" ")]);
  for (const c of s.execs) { expect(c.command).toBe("ahub"); expect(allowed.has(c.args.join(" ")), c.args.join(" ")).toBe(true); }
  expect([...new Set(s.runs.map(r => r.name))]).toEqual(["tab.new"]);
  expect(Object.keys(core.FIXED).sort()).toEqual(["console", "projects", "status", "ui"]);
  for (const key of Object.keys(core.REFUSALS)) expect(core.REFUSALS[key]).toMatch(/\S/);
});

test("AC7: with the host disabled the entry refuses and touches nothing, and Herdr's terminals and agents are unchanged", async () => {
  const s = setup(); await pick(s);
  const before = s.fake.snapshot();
  s.fake.setEnabled(false);
  expect(await s.entry.refresh()).toMatchObject({ status: "refused", refusal: "host_unavailable" });
  expect(await s.entry.openConsole()).toMatchObject({ ok: false });
  expect(s.fake.snapshot()).toEqual(before);
  s.fake.setEnabled(true);
  expect(s.fake.snapshot()).toEqual(before);
});

test("AC7: the shipped mod is five files in one owned folder, docks nothing, and the glue stays within the documented host API", () => {
  expect(readdirSync(MOD).sort()).toEqual(["card.js", "core.js", "focus.js", "main.js", "mod.json"]);
  expect(JSON.parse(readFileSync(join(MOD, "mod.json"), "utf8"))).toEqual({ place: "none", overlay: { width: 640, height: 460 } });
  const code = (text: string) => text.replace(/^\s*\/\/.*$/gm, ""); // the scans below read code, not the comments that explain it
  const main = code(readFileSync(join(MOD, "main.js"), "utf8")), logic = ["core.js", "card.js", "focus.js"].map(n => code(readFileSync(join(MOD, n), "utf8"))).join("\n");
  const imports = [...main.matchAll(/import \{([^}]*)\} from "herdr"/g)].flatMap(m => m[1]!.split(",").map(x => x.trim()));
  expect(imports.sort()).toEqual(["closeOverlay", "exec", "focused", "hc", "machines", "props", "run", "spaces", "terminals", "theme", "window"].sort());
  for (const text of [main, logic]) for (const bad of [/\bfetch\(/, /XMLHttpRequest/, /setInterval|setTimeout/, /localStorage/, /writeTextFile|readTextFile/, /shared\(|setShared\(/, /(^|[^.\w])notify\(/, /watchFolder/, /openOverlay/, /process\.|child_process|Bun\./, /structuredClone/, /\bpane\.close|terminal\.kill|terminal\.park|tab\.close|space\.close/])
    expect(text, String(bad)).not.toMatch(bad);
  expect(logic).not.toMatch(/from ["']herdr["']|from ["']gpui-kit["']/);
  // hc is allowed in exactly one form: `hc(["get", <address>, "--json"])`. Any other call, or a call through a variable, fails here.
  const hcCalls = [...logic.matchAll(/host\.hc\(([^)]*\))/g)].map(m => m[1]);
  expect(hcCalls).toEqual(['["get", row.address, "--json"])']);
  expect([...main.matchAll(/\bhc\(/g)]).toEqual([]);
  // main.js is glue: it holds no project, machine or argument decision
  expect(main).not.toMatch(/FIXED|"ahub"|--project|\.exec\(/);
  for (const text of [main, logic, readFileSync(join(MOD, "mod.json"), "utf8")]) expect(text).not.toMatch(/orca/i);
});

const herdrApp = Bun.which("herdr-app");
test.skipIf(!herdrApp)("herdr-app check accepts the mod copied into a scratch app home (the host's own load and first render; not a native open receipt)", () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-herdr-home-")); dirs.push(home);
  mkdirSync(join(home, "mods"));
  cpSync(MOD, join(home, "mods", "ahub"), { recursive: true });
  const r = Bun.spawnSync([herdrApp!, "check", join(home, "mods", "ahub")], { env: { ...process.env, HERDR_APP_HOME: home }, stdout: "pipe", stderr: "pipe" });
  expect(`${r.stdout}${r.stderr}`).toContain("check passed");
  expect(r.exitCode).toBe(0);
  // the check wrote nothing outside the scratch home it was given
  expect(readdirSync(home).sort()).toEqual(["mods"]);
});
