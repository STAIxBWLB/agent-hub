import { expect, test } from "bun:test";
import { FakeHerdrModHost, HERDR_FIXTURE_COMMANDS, type HerdrFixtureCliPort, type HerdrFixtureExecCall, type HerdrFixtureTerminal } from "./helpers/herdr-mod-host.ts";
// @ts-ignore TS7016: untyped plain JavaScript by design
import * as core from "../integrations/herdr/mod/core.js";
// @ts-ignore TS7016: untyped plain JavaScript by design
import * as focus from "../integrations/herdr/mod/focus.js";

// #1199 H2 (task #795, AC5 and AC6): focus and peek an existing console only after its binding is verified from facts, and never terminate, replace or silently create a terminal. The
// foreground shapes below are the ones real herdr-core 0.1.18 reported in an isolated session: `["bun", "<path>/ahub", "--project", X, "console"]`. The fixture proves the decisions,
// not that a real window focuses the terminal: that is the person-run receipt.
const SEL = { id: "p_a", root: "/work/a" };
const fg = (argv: string[], cwd = "/work/a") => ({ argv, cwd, name: argv[0], pid: 1 });
const info = (foreground: unknown, state = "live") => ({ code: 0, stdout: JSON.stringify({ state, foreground, screen: "SECRET SCREEN TEXT", title: "SECRET TITLE", labels: { k: "SECRET LABEL" } }) });

interface Opts { machine?: string | null; terminals?: HerdrFixtureTerminal[]; get?: Record<string, ReturnType<typeof info> | "reject" | { code: number; stdout: string }>; platform?: string; focusedTerminal?: string | null }
function setup(o: Opts = {}) {
  const machine = o.machine === undefined ? null : o.machine;
  const execs: HerdrFixtureExecCall[] = [];
  const cli: HerdrFixtureCliPort = async call => {
    execs.push({ ...call, args: [...call.args] });
    const j = call.args.join(" ");
    if (j === "projects --json") return { stdout: JSON.stringify([{ id: "p_a", root: "/work/a", state: "running" }]), stderr: "", exitCode: 0, timedOut: false, truncated: false };
    throw new Error(`unexpected ${j}`);
  };
  const terminals = o.terminals ?? [{ address: "t1", state: "live", status: "idle" }, { address: "t2", state: "live", status: "working" }];
  const get = o.get ?? { t1: info(fg(["bun", "/x/bin/ahub", "--project", "/work/a", "console"])), t2: info(fg(["zsh"])) };
  const fake = new FakeHerdrModHost({ offeredFunctions: ["exec", "run", "hc", "spaces", "panes", "focused", "machines", "terminals", "commands"], offeredCommands: Object.keys(HERDR_FIXTURE_COMMANDS),
    spaces: [{ id: "s1", index: 1, name: "s1", folder: "/work", machine, tabs: [{ id: "s1/t1", index: 1, name: "1" }] }],
    focused: { space: "s1", tab: "s1/t1", pane: "p1", terminal: o.focusedTerminal === undefined ? "t2" : o.focusedTerminal, shown: null, agent: null, cwd: "/work/a" },
    terminals, hcGet: addr => (get[addr] === undefined ? { code: 3, stdout: "" } : (get[addr] === "reject" ? "reject" : (get[addr] as { code: number; stdout: string }))), cli,
    machines: [{ name: null, layout: "ready" }, { name: "vps", layout: "ready" }], syntheticState: { terminals: ["t1", "t2"], agents: [] } });
  const runs: { name: string; args: Record<string, unknown> }[] = [];
  const host = { exec: (c: string, a?: string[], x?: unknown) => fake.exec(c, a, x), spaces: () => fake.spaces(), machines: () => fake.machines(), focused: () => fake.focused(), terminals: () => fake.terminals(),
    hc: (a: string[]) => fake.hc(a),
    // the host applies pane.focus by moving focus to a terminal it knows; a peek has no read-back
    run: (n: string, a: Record<string, unknown>) => { runs.push({ name: n, args: JSON.parse(JSON.stringify(a)) }); fake.run(n, a); return null; },
    platform: () => o.platform ?? "macos" };
  const entry = core.createHerdrEntry({ host });
  return { fake, entry, execs, runs, host };
}
const ready = async (s: ReturnType<typeof setup>) => { await s.entry.refresh(); s.entry.select("p_a"); };

test("AC5: with one verified console, Focus runs exactly one pane.focus on that address and believes it only after focused() shows it", async () => {
  const s = setup(); await ready(s);
  const r = await s.entry.focusConsole();
  expect(r).toEqual({ ok: true, focused: "t1", confirmed: true, observed: "idle" });
  expect(s.runs).toEqual([{ name: "pane.focus", args: { terminal: "t1" } }]);
  expect(s.fake.focused()!.terminal).toBe("t1");
  // the only hc commands were `get <addr> --json`, twice per candidate (the verify and the recheck), and never anything that writes
  expect(s.fake.hcCalls.every(c => c.length === 3 && c[0] === "get" && c[2] === "--json")).toBe(true);
  expect(s.fake.hcCalls.map(c => c[1])).toEqual(["t1", "t2", "t1", "t2"]);
});

test("AC5: Peek verifies the same way, runs terminal.peek, and reports a request, never a confirmation", async () => {
  const s = setup(); await ready(s);
  expect(await s.entry.peekConsole()).toEqual({ ok: true, requested: "peek", terminal: "t1", confirmed: false, observed: "idle" });
  expect(s.runs).toEqual([{ name: "terminal.peek", args: { terminal: "t1" } }]);
});

test("AC5: a focus the host does not show is `unconfirmed_focus`, never claimed, and is not retried", async () => {
  const s = setup(); await ready(s);
  s.host.run = (n: string, a: Record<string, unknown>) => { s.runs.push({ name: n, args: a }); return null; }; // accepted, but focus did not move
  expect(await s.entry.focusConsole()).toMatchObject({ ok: false, refusal: "unconfirmed_focus" });
  expect(s.runs).toHaveLength(1);
});

test("AC5: no related console is `no_console`, and NOTHING is created: no new tab, no terminal.open, no pane.split, no hc run", async () => {
  const s = setup({ get: { t1: info(fg(["zsh"])), t2: info(fg(["vim"])) } }); await ready(s);
  expect(await s.entry.focusConsole()).toMatchObject({ ok: false, refusal: "no_console" });
  expect(await s.entry.peekConsole()).toMatchObject({ ok: false, refusal: "no_console" });
  expect(s.runs).toEqual([]);
  expect(s.fake.snapshot()).toEqual({ terminals: ["t1", "t2"], agents: [] });
});

test("AC5: a console for ANOTHER project is not a match, by id or by root, and a nested folder is not the root", async () => {
  const wrong: Record<string, ReturnType<typeof info>> = {
    other_root: info(fg(["bun", "/x/ahub", "--project", "/work/b", "console"])),
    sibling_prefix: info(fg(["bun", "/x/ahub", "--project", "/work/ab", "console"])),
    nested_cwd_no_flag: info(fg(["bun", "/x/ahub", "console"], "/work/a/sub")),
    other_cwd_no_flag: info(fg(["bun", "/x/ahub", "console"], "/work/b")),
    relative_project: info(fg(["bun", "/x/ahub", "--project", "a", "console"])),
    other_id: info(fg(["bun", "/x/ahub", "--project", "p_zzz", "console"])),
  };
  for (const [name, one] of Object.entries(wrong)) {
    const s = setup({ terminals: [{ address: "t1", state: "live" }], get: { t1: one } }); await ready(s);
    expect(await s.entry.focusConsole(), name).toMatchObject({ ok: false, refusal: "no_console" });
    expect(s.runs, name).toEqual([]);
  }
  // and the right ones: by root, by id, and by cwd with no flag, with the runtimes ahub is started through
  for (const [name, argv, cwd] of [
    ["root", ["bun", "/x/ahub", "--project", "/work/a", "console"], "/anywhere"], ["id", ["bun", "/x/ahub", "--project", "p_a", "console"], "/anywhere"],
    ["cwd", ["bun", "/x/ahub", "console"], "/work/a"], ["node", ["node", "/x/ahub", "console", "--panels"], "/work/a"], ["direct", ["/usr/local/bin/ahub", "--project", "/work/a", "console", "--no-pet"], "/z"],
    ["color", ["ahub", "--project", "/work/a", "console", "--color=never"], "/z"],
  ] as [string, string[], string][]) {
    const s = setup({ terminals: [{ address: "t1", state: "live" }], get: { t1: info(fg(argv, cwd)) } }); await ready(s);
    expect(await s.entry.focusConsole(), name).toMatchObject({ ok: true, focused: "t1" });
  }
});

test("AC5: things that only look like a console are not matched: other subcommands, other flags, a different program, text in the wrong place", () => {
  const no = (argv: string[], cwd = "/work/a") => expect(focus.matchConsole(fg(argv, cwd), SEL), argv.join(" ")).toBe(false);
  no(["bun", "/x/ahub", "status", "--json"]); no(["bun", "/x/ahub", "ui"]); no(["bun", "/x/ahub", "console", "--evil"]); no(["bun", "/x/ahub", "console", "extra"]);
  no(["bun", "/x/not-ahub", "console"]); no(["vim", "console"]); no(["bun", "/x/ahub", "--project"]); no(["bun", "/x/ahub", "--project", "/work/a"]); no(["bun", "/x/ahub", "console\n"]);
  no(["bun", "/x/ahub", "console", "--color=sometimes"]); no([]); no(["bun"]); no(["bun", "/x/ahub", "--project", "/work/a", "--project", "/work/a", "console"]);
  expect(focus.matchConsole(null, SEL)).toBe(false); expect(focus.matchConsole({ argv: ["ahub", "console"] }, SEL)).toBe(false); expect(focus.matchConsole({ argv: "ahub console", cwd: "/work/a" }, SEL)).toBe(false);
  expect(focus.matchConsole(fg(["bun", "/x/ahub", "--project", "/work/a", "console"]), SEL)).toBe(true);
  // a finished terminal has no foreground, and a terminal whose reading is not live is never a candidate
  expect(focus.matchConsole(undefined, SEL)).toBe(false);
});

test("AC5: a finished, vanished, unreadable or unparseable terminal is skipped, and never focused, revived or replaced", async () => {
  for (const [name, get] of [
    ["finished", { t1: info(undefined, "finished") }], ["not found", {}], ["reject", { t1: "reject" as const }],
    ["not json", { t1: { code: 0, stdout: "nope" } }], ["nonzero", { t1: { code: 9, stdout: "" } }],
  ] as [string, Opts["get"]][]) {
    const s = setup({ terminals: [{ address: "t1", state: "live" }], get });
    await ready(s);
    const r = await s.entry.focusConsole();
    expect(r.ok, name).toBe(false);
    expect(["no_console", "hc_unavailable"], name).toContain(r.refusal);
    expect(s.runs, name).toEqual([]);
  }
  // a row that is finished in the list is never even asked about
  const done = setup({ terminals: [{ address: "t1", state: "finished" }], get: { t1: info(fg(["bun", "/x/ahub", "--project", "/work/a", "console"])) } }); await ready(done);
  expect(await done.entry.focusConsole()).toMatchObject({ refusal: "no_console" });
  expect(done.fake.hcCalls).toEqual([]);
});

test("AC5: two matching consoles are `ambiguous_console`: none is chosen", async () => {
  const mine = info(fg(["bun", "/x/ahub", "--project", "/work/a", "console"]));
  const s = setup({ terminals: [{ address: "t1", state: "live" }, { address: "t2", state: "live" }], get: { t1: mine, t2: mine } }); await ready(s);
  expect(await s.entry.focusConsole()).toMatchObject({ ok: false, refusal: "ambiguous_console" });
  expect(await s.entry.peekConsole()).toMatchObject({ ok: false, refusal: "ambiguous_console" });
  expect(s.runs).toEqual([]);
});

test("AC5: the binding is rechecked right before the effect: a console that changes between the two reads is `changed`, and nothing is focused", async () => {
  const mine = info(fg(["bun", "/x/ahub", "--project", "/work/a", "console"]));
  let reads = 0;
  const s = setup({ terminals: [{ address: "t1", state: "live" }] });
  s.fake.setHcGet(() => (++reads <= 1 ? mine : info(fg(["zsh"]))));
  await ready(s);
  expect(await s.entry.focusConsole()).toMatchObject({ ok: false, refusal: "no_console" });
  expect(s.runs).toEqual([]);
  // and a different single console on the recheck is `changed`
  const s2 = setup({ terminals: [{ address: "t1", state: "live" }, { address: "t3", state: "live" }] });
  let n = 0;
  s2.fake.setHcGet(addr => { n++; const first = n <= 2; return addr === "t1" ? (first ? mine : info(fg(["zsh"]))) : (first ? info(fg(["zsh"])) : mine); });
  await ready(s2);
  expect(await s2.entry.focusConsole()).toMatchObject({ ok: false, refusal: "changed" });
  expect(s2.runs).toEqual([]);
});

test("AC5: machine and binding are rechecked first: a remote space, a moved space, an unready machine and a re-pointed project all refuse before any terminal is read", async () => {
  const remote = setup({ machine: "vps" }); await ready(remote);
  expect(await remote.entry.focusConsole()).toMatchObject({ ok: false, refusal: "remote_focus" });
  expect(await remote.entry.peekConsole()).toMatchObject({ ok: false, refusal: "remote_focus" });
  expect(remote.fake.hcCalls).toEqual([]); expect(remote.runs).toEqual([]);
  const moved = setup(); await ready(moved);
  moved.fake.setSpaces([{ id: "s1", index: 1, name: "s1", folder: "/", machine: "vps", tabs: [] }]);
  expect(await moved.entry.focusConsole()).toMatchObject({ ok: false, refusal: "changed" });
  const gone = setup(); await ready(gone); gone.fake.setSpaces([]);
  expect(await gone.entry.focusConsole()).toMatchObject({ ok: false, refusal: "changed" });
  const down = setup(); await ready(down); down.fake.setMachines([{ name: null, layout: "unavailable" }]);
  expect(await down.entry.focusConsole()).toMatchObject({ ok: false, refusal: "machine_unavailable" });
  const repoint = setup(); await ready(repoint);
  const origExec = repoint.host.exec;
  repoint.host.exec = async (c: string, a?: string[], x?: unknown) => (a?.[0] === "projects" ? { code: 0, stdout: JSON.stringify([{ id: "p_new", root: "/work/a", state: "running" }]), stderr: "" } : origExec(c, a, x));
  expect(await repoint.entry.focusConsole()).toMatchObject({ ok: false, refusal: "changed" });
  for (const x of [moved, gone, down, repoint]) { expect(x.fake.hcCalls).toEqual([]); expect(x.runs).toEqual([]); }
});

test("AC5/AC8: stale terminal addresses and a huge terminal list: remote-prefixed rows are never read, and more than the bound is refused", async () => {
  const mine = info(fg(["bun", "/x/ahub", "--project", "/work/a", "console"]));
  const s = setup({ terminals: [{ address: "vps/t1", state: "live" }, { address: "t1", state: "live" }], get: { t1: mine } }); await ready(s);
  expect(await s.entry.focusConsole()).toMatchObject({ ok: true, focused: "t1" });
  expect(s.fake.hcCalls.every(c => !c[1]!.includes("/"))).toBe(true);
  const many = setup({ terminals: Array.from({ length: focus.MAX_TERMINALS + 1 }, (_, i) => ({ address: `t${i}`, state: "live" })) }); await ready(many);
  expect(await many.entry.focusConsole()).toMatchObject({ ok: false, refusal: "too_many_terminals" });
  expect(many.fake.hcCalls).toEqual([]);
  // a stale address the host no longer knows: focus does not move, so it is unconfirmed rather than claimed
  const stale = setup({ terminals: [{ address: "t1", state: "live" }], get: { t1: mine } }); await ready(stale);
  stale.fake.setTerminals([]); // gone from the host's own list after verification
  stale.host.run = (n: string, a: Record<string, unknown>) => { stale.runs.push({ name: n, args: a }); return null; };
  const r = await stale.entry.focusConsole();
  expect(r.ok).toBe(false);
});

test("AC5: it never types into, kills, parks, closes, restarts or creates anything: only pane.focus and terminal.peek can reach run, and only `get` reaches hc", async () => {
  const s = setup(); await ready(s);
  await s.entry.focusConsole(); await s.entry.peekConsole();
  expect([...new Set(s.runs.map(r => r.name))].sort()).toEqual(["pane.focus", "terminal.peek"]);
  for (const c of s.fake.hcCalls) expect(c[0]).toBe("get");
  // the fixture refuses any other hc command outright, so a companion that tried one would throw
  for (const bad of [["send", "t1", "x"], ["kill", "t1"], ["run", "ls"], ["keys", "t1", "enter"], ["rm", "t1"], ["get", "t1"], ["get", "t1/x", "--json"], ["get", "../t1", "--json"]]) {
    await expect(s.fake.hc(bad)).rejects.toMatchObject({ code: expect.stringMatching(/hc_unsupported|invalid_params/) });
  }
  const src = ["focus.js", "core.js", "main.js"].map(n => require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../integrations/herdr/mod", n), "utf8").replace(/^\s*\/\/.*$/gm, "")).join("\n");
  for (const bad of [/terminal\.kill|terminal\.park|terminal\.keep|tab\.close|pane\.close|space\.close|terminal\.open.*place/, /hc\(\[\s*"(send|keys|kill|run|rm|put|label|interrupt|wait)"/, /\.read\(|"read"/]) expect(src, String(bad)).not.toMatch(bad);
  // the terminal's screen, title and labels were in every reading and never reached a result or the view
  const out = JSON.stringify([await s.entry.focusConsole(), s.entry.view()]);
  for (const secret of ["SECRET SCREEN", "SECRET TITLE", "SECRET LABEL"]) expect(out).not.toContain(secret);
});

test("AC6: Herdr's working, blocked, done and idle words are shown as an observation and never sent to ahub: the only ahub calls are the registration read", async () => {
  for (const word of ["working", "blocked", "done", "idle"]) {
    const s = setup({ terminals: [{ address: "t1", state: "live", status: word }] }); await ready(s);
    expect(await s.entry.focusConsole()).toMatchObject({ ok: true, observed: word });
    expect(s.execs.every(e => e.args.join(" ") === "projects --json")).toBe(true);
  }
  const odd = setup({ terminals: [{ address: "t1", state: "live", status: "banana" }] }); await ready(odd);
  expect(await odd.entry.focusConsole()).toMatchObject({ ok: true, observed: null }); // an unknown word is not copied
  // the Herdr status never changes what is selectable or matched: a "done" terminal for another project is still not this project's
  const other = setup({ terminals: [{ address: "t1", state: "live", status: "done" }], get: { t1: info(fg(["bun", "/x/ahub", "--project", "/work/b", "console"])) } }); await ready(other);
  expect(await other.entry.focusConsole()).toMatchObject({ refusal: "no_console" });
});

test("AC5: on Windows nothing is read or focused", async () => {
  const s = setup({ platform: "windows" });
  expect(await s.entry.refresh()).toMatchObject({ status: "refused", refusal: "unsupported_platform" }); // no project can even be selected
  expect(await s.entry.focusConsole()).toMatchObject({ ok: false });
  expect(s.fake.hcCalls).toEqual([]); expect(s.runs).toEqual([]); expect(s.execs).toEqual([]);
  // and focus refuses on its own if the platform answer changes after a selection
  let platform = "macos";
  const flip = setup(); flip.host.platform = () => platform;
  const entry = core.createHerdrEntry({ host: flip.host });
  await entry.refresh(); entry.select("p_a"); platform = "windows";
  expect(await entry.focusConsole()).toMatchObject({ ok: false, refusal: "unsupported_platform" });
  expect(await entry.peekConsole()).toMatchObject({ ok: false, refusal: "unsupported_platform" });
  expect(flip.fake.hcCalls).toEqual([]); expect(flip.runs).toEqual([]);
});

test("review thread (machine change during the reads): the space and machine are re-read with nothing awaited right before the focus or peek, so nothing is focused after the space moved or the machine went away", async () => {
  const mine = info(fg(["bun", "/x/ahub", "--project", "/work/a", "console"]));
  const scenarios: [string, (s: ReturnType<typeof setup>) => void, string][] = [
    ["the space moves to another machine", s => s.fake.setSpaces([{ id: "s1", index: 1, name: "s1", folder: "/", machine: "vps", tabs: [] }]), "changed"],
    ["the machine becomes unavailable", s => s.fake.setMachines([{ name: null, layout: "unavailable" }]), "machine_unavailable"],
    ["the machine goes away", s => s.fake.setMachines([]), "machine_unavailable"],
    ["the space is closed", s => s.fake.setSpaces([]), "changed"],
  ];
  for (const kind of ["focusConsole", "peekConsole"] as const) for (const [name, change, refusal] of scenarios) {
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(r => { release = r; }), at = new Promise<void>(r => { reached = r; });
    const s = setup({ terminals: [{ address: "t1", state: "live" }], get: { t1: mine } }); await ready(s);
    const orig = s.host.hc;
    let reads = 0;
    // hold the SECOND terminal read: the first findConsole, the project read and the early space check are already behind the action
    s.host.hc = async (a: string[]) => { if (++reads === 2) { reached(); await gate; } return orig(a); };
    const pending = s.entry[kind]();
    await at;
    change(s);
    release();
    expect(await pending, `${kind}: ${name}`).toMatchObject({ ok: false, refusal });
    expect(s.runs, `${kind}: ${name}`).toEqual([]);
  }
});

test("a context change while the SECOND console read is held stops the action before it focuses or peeks", async () => {
  const mine = info(fg(["bun", "/x/ahub", "--project", "/work/a", "console"]));
  for (const kind of ["focusConsole", "peekConsole"] as const) {
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(r => { release = r; }), at = new Promise<void>(r => { reached = r; });
    const s = setup({ terminals: [{ address: "t1", state: "live" }], get: { t1: mine } }); await ready(s);
    const orig = s.host.hc;
    let reads = 0;
    s.host.hc = async (a: string[]) => { if (++reads === 2) { reached(); await gate; } return orig(a); };
    const pending = s.entry[kind]();
    await at;
    await s.entry.refresh(); // the person switched project: this moves the generation, nothing about the space itself changed
    release();
    expect(await pending, kind).toMatchObject({ ok: false, refusal: "stale" });
    expect(s.runs, kind).toEqual([]);
  }
});

test("a rapid second Focus while one runs is refused, and a context change stops a running one before it focuses anything", async () => {
  const mine = info(fg(["bun", "/x/ahub", "--project", "/work/a", "console"]));
  let release!: () => void, reached!: () => void;
  const hold = new Promise<void>(r => { release = r; }), at = new Promise<void>(r => { reached = r; });
  const s = setup({ terminals: [{ address: "t1", state: "live" }], get: { t1: mine } }); await ready(s);
  const orig = s.host.hc;
  s.host.hc = async (a: string[]) => { reached(); await hold; return orig(a); };
  const first = s.entry.focusConsole();
  await at;
  expect(await s.entry.focusConsole()).toMatchObject({ ok: false, refusal: "busy" });
  await s.entry.refresh();
  release();
  expect(await first).toMatchObject({ ok: false, refusal: "stale" });
  expect(s.runs).toEqual([]);
});
