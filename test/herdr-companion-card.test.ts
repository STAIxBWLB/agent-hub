import { expect, test } from "bun:test";
import { FakeHerdrModHost, HERDR_FIXTURE_COMMANDS, type HerdrFixtureCliPort, type HerdrFixtureExecCall } from "./helpers/herdr-mod-host.ts";
// @ts-ignore TS7016: untyped plain JavaScript by design
import * as core from "../integrations/herdr/mod/core.js";
// @ts-ignore TS7016: untyped plain JavaScript by design
import * as card from "../integrations/herdr/mod/card.js";

// #1199 H2 (task #795, AC4 and AC6): the read-only status card. Every state is distinct, the reading is a closed allowlist, nothing polls, and nothing a task says reaches the card. Fixture
// only: nothing here proves how the card looks in a Herdr window, which is the person-run receipt.
const OK = { projectId: "p_a", cwd: "/work/a", version: "0.33.0", tasks: { approved: 690, in_progress: 1, proposed: 5 }, peers: { claude: { state: "idle", queued: 0 }, codex: { state: "busy", queued: 2, pullOnly: false } } };
const PRIVATE_TEXT = "PII-TITLE-Jane-Doe-patient-4471";

interface Run { code?: number; stdout?: string; stderr?: string; reject?: boolean; ms?: number }
function setup(script: Run | ((n: number) => Run), opts: { machine?: string | null; now?: () => number } = {}) {
  const machine = opts.machine === undefined ? null : opts.machine;
  const execs: HerdrFixtureExecCall[] = [];
  let statusCalls = 0;
  let clock = 1_000_000;
  const cli: HerdrFixtureCliPort = async call => {
    execs.push({ ...call, args: [...call.args] });
    // ahub's selector rule (src/cli/main.ts): `--project <id>` selects the registration; with none the project comes from the cwd. Commands here are expected to carry the selector.
    const selector = call.args[0] === "--project" ? call.args[1] : null;
    const j = (selector === null ? call.args : call.args.slice(2)).join(" ");
    if (j === "status --json" && selector !== "p_a") return { stdout: "", stderr: "ahub: no hub running for /x/.agenthub/state (run: ahub up)\n", exitCode: 1, timedOut: false, truncated: false };
    if (j === "projects --json") return { stdout: JSON.stringify([{ id: "p_a", root: "/work/a", state: "running" }]), stderr: "", exitCode: 0, timedOut: false, truncated: false };
    if (j === "status --json") {
      const r = typeof script === "function" ? script(++statusCalls) : (statusCalls++, script);
      clock += r.ms ?? 5;
      if (r.reject) return { stdout: "", stderr: "", exitCode: null, timedOut: false, truncated: false };
      return { stdout: r.stdout ?? JSON.stringify(OK), stderr: r.stderr ?? "", exitCode: r.code ?? 0, timedOut: false, truncated: false };
    }
    throw new Error(`unexpected ${j}`);
  };
  const fake = new FakeHerdrModHost({ offeredFunctions: ["exec", "run", "hc", "spaces", "panes", "focused", "machines", "terminals", "commands"], offeredCommands: Object.keys(HERDR_FIXTURE_COMMANDS),
    spaces: [{ id: "s1", index: 1, name: "s1", folder: "/work", machine, tabs: [{ id: "s1/t1", index: 1, name: "1" }] }],
    focused: { space: "s1", tab: "s1/t1", pane: "p1", terminal: "t1", shown: null, agent: null, cwd: "/work/a" }, cli,
    machines: [{ name: null, layout: "ready" }, { name: "vps", layout: "ready" }] });
  const host = { exec: (c: string, a?: string[], o?: unknown) => fake.exec(c, a, o), spaces: () => fake.spaces(), machines: () => fake.machines(), focused: () => fake.focused(), terminals: () => fake.terminals(),
    hc: (a: string[]) => fake.hc(a), run: (n: string, a: Record<string, unknown>) => fake.run(n, a), platform: () => "macos", now: opts.now ?? (() => clock) };
  const entry = core.createHerdrEntry({ host });
  return { fake, entry, execs, host, tick: (ms: number) => { clock += ms; }, statusCalls: () => statusCalls };
}
const ready = async (s: ReturnType<typeof setup>) => { await s.entry.refresh(); s.entry.select("p_a"); };

test("AC4: a good reading is a closed allowlist: ids, counts and closed words, with no text from ahub", async () => {
  const s = setup({ stdout: JSON.stringify({ ...OK, notices: [PRIVATE_TEXT], tasksDetail: [{ title: PRIVATE_TEXT }], peers: { claude: { state: "idle", queued: 0, doing: PRIVATE_TEXT, permissionNote: PRIVATE_TEXT }, codex: { state: "busy", queued: 2, pullOnly: true, toolsOnly: PRIVATE_TEXT } } }) });
  await ready(s);
  expect(await s.entry.refreshCard()).toEqual({ ok: true, state: "running" });
  const c = s.entry.card();
  expect(c).toMatchObject({ ok: true, state: "running", version: "0.33.0", projectId: "p_a", missing: [] });
  expect(c.tasks).toEqual({ approved: 690, in_progress: 1, proposed: 5 });
  expect(c.peers).toEqual([{ id: "claude", state: "idle", queued: 0, pullOnly: false }, { id: "codex", state: "busy", queued: 2, pullOnly: true }]);
  // free text, private stubs and every unknown field never enter the card or the view
  for (const text of [JSON.stringify(c), JSON.stringify(s.entry.view())]) { expect(text).not.toContain("PII-TITLE"); expect(text).not.toContain("Jane"); expect(text).not.toContain("notices"); expect(text).not.toContain("permissionNote"); }
  // it ran the one fixed status read, from the project folder, within the host's caps
  const status = s.execs.filter(e => e.args.includes("status"));
  expect(status.map(e => [e.command, e.args.join(" "), e.cwd, e.on])).toEqual([["ahub", "--project p_a status --json", "/work/a", undefined]]);
  expect(status[0]!.timeoutMs).toBe(30_000); expect(status[0]!.maxOutputBytes).toBe(8 * 1024 * 1024);
});

test("AC4: every failure is its own state with a fixed sentence: missing CLI, timeout, nonzero exit, offline, too large, bad output, old hub, partial", async () => {
  const cases: [string, Run, string][] = [
    ["cannot start (host rejected quickly)", { reject: true, ms: 40 }, "cannot_start"],
    ["timeout (host rejected at the limit)", { reject: true, ms: 30_000 }, "timeout"],
    ["shell not found", { code: 127, stdout: "", stderr: "ahub: command not found" }, "cannot_start"],
    ["nonzero exit", { code: 2, stdout: "", stderr: "boom SECRET" }, "failed"],
    ["offline", { code: 1, stdout: "", stderr: "ahub: no hub running for /work/a/.agenthub/state (run: ahub up)\n" }, "offline"],
    ["not an offline prefix", { code: 1, stdout: "", stderr: "something: no hub running for it" }, "failed"],
    ["too large", { stdout: "x".repeat(600 * 1024) }, "too_large"],
    ["not json", { stdout: "nope" }, "bad_output"],
    ["json but not an object", { stdout: "[]" }, "bad_output"],
    ["no project id", { stdout: JSON.stringify({ version: "0.33.0", cwd: "/work/a" }) }, "bad_output"],
    ["no reported folder", { stdout: JSON.stringify({ projectId: "p_a", version: "0.33.0", tasks: { approved: 1 }, peers: {} }) }, "bad_output"],
    ["a reported folder that is not the selected root", { stdout: JSON.stringify({ ...OK, cwd: "/work/a/sub" }) }, "changed"],
    ["an old hub with none of the fields", { stdout: JSON.stringify({ projectId: "p_a", cwd: "/work/a" }) }, "unavailable_version"],
    ["partial: no peers", { stdout: JSON.stringify({ projectId: "p_a", cwd: "/work/a", version: "0.33.0", tasks: { approved: 1 } }) }, "partial"],
    ["partial: bad counts", { stdout: JSON.stringify({ ...OK, tasks: { approved: -1 } }) }, "partial"],
    ["partial: a peer with a bad id", { stdout: JSON.stringify({ ...OK, peers: { "BAD ID": { state: "idle" } } }) }, "partial"],
  ];
  const seen = new Set<string>();
  for (const [name, run, state] of cases) {
    const s = setup(run); await ready(s);
    await s.entry.refreshCard();
    const c = s.entry.card();
    expect(c.state, name).toBe(state); seen.add(state);
    const text = JSON.stringify(c) + JSON.stringify(s.entry.view());
    expect(text, name).not.toContain("SECRET");
    if (state !== "running" && state !== "partial" && state !== "unavailable_version") expect(c.ok, name).toBe(false);
    expect(s.entry.cardSentence(state) || "(reading)", name).toMatch(/\S/);
  }
  // the states are all different from each other
  expect([...seen].sort()).toEqual(["bad_output", "cannot_start", "changed", "failed", "offline", "partial", "timeout", "too_large", "unavailable_version"]);
  expect(card.CARD_STATES.length).toBe(new Set(card.CARD_STATES).size);
});

test("AC4: a partial reading names what it lacks and never shows a zero for it", async () => {
  const s = setup({ stdout: JSON.stringify({ projectId: "p_a", cwd: "/work/a", version: "0.33.0", peers: { claude: { state: "idle" } } }) }); await ready(s);
  await s.entry.refreshCard();
  const c = s.entry.card();
  expect(c).toMatchObject({ ok: true, state: "partial", tasks: null, missing: ["tasks"] });
  expect(c.peers).toEqual([{ id: "claude", state: "idle", queued: null, pullOnly: false }]);
});

test("AC4: a reading is stale after the bound, judged on the entry's own clock, without asking ahub again", async () => {
  const s = setup({}); await ready(s);
  await s.entry.refreshCard();
  expect(s.entry.card()).toMatchObject({ state: "running" });
  const calls = s.statusCalls();
  s.tick(card.STALE_AFTER_MS - 1_000);
  expect(s.entry.card()).toMatchObject({ state: "running" });
  s.tick(2_000);
  expect(s.entry.card()).toMatchObject({ state: "stale" });
  expect(s.statusCalls()).toBe(calls); // the card only says it is old
  // a reading with no usable time is `unknown`, not running
  expect(card.ageCard({ ok: true, state: "running", fetchedAt: null }, 5)).toMatchObject({ state: "unknown", ageMs: null });
  expect(card.ageCard({ ok: true, state: "partial", fetchedAt: 0 }, 10 * card.STALE_AFTER_MS)).toMatchObject({ state: "partial" }); // partial stays partial
});

test("AC4: no poller: nothing reads the card on open, on selection or on a clock, only on an explicit refresh", async () => {
  const s = setup({}); await s.entry.refresh();
  expect(s.statusCalls()).toBe(0);
  s.entry.select("p_a");
  expect(s.statusCalls()).toBe(0);
  s.tick(10 * 60_000);
  expect(s.entry.card()).toBeNull();
  expect(s.statusCalls()).toBe(0);
  await s.entry.refreshCard();
  expect(s.statusCalls()).toBe(1);
});

test("AC4/AC8: a project-context change drops the card: a new selection or a refresh clears it, and a late reading is never shown under another project", async () => {
  let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  const s = setup({}); await ready(s);
  await s.entry.refreshCard();
  expect(s.entry.card()).not.toBeNull();
  s.entry.select("p_a");
  expect(s.entry.card()).toBeNull(); // selection cleared the old reading
  // a reading that completes after the context changed is dropped
  const slow = setup((n) => ({ stdout: JSON.stringify(OK) }));
  await ready(slow);
  const origExec = slow.host.exec;
  let reachedStatus!: () => void; const reached = new Promise<void>(r => { reachedStatus = r; });
  slow.host.exec = async (c: string, a?: string[], o?: unknown) => { if (a?.includes("status")) { reachedStatus(); await hold; } return origExec(c, a, o); };
  const inflight = slow.entry.refreshCard();
  await reached;
  expect(await slow.entry.refreshCard()).toMatchObject({ ok: false, refusal: "busy" }); // a second click while reading is refused
  await slow.entry.refresh(); // the person changed context
  release();
  expect(await inflight).toMatchObject({ ok: false, refusal: "stale" });
  expect(slow.entry.card()).toBeNull();
});

test("AC4: a reading for a different project id is `changed`, never shown as this project's card", async () => {
  const s = setup({ stdout: JSON.stringify({ ...OK, projectId: "p_other" }) }); await ready(s);
  await s.entry.refreshCard();
  expect(s.entry.card()).toMatchObject({ ok: false, state: "changed" });
  expect(JSON.stringify(s.entry.card())).not.toContain("690");
});

test("AC4/AC8: a remote space reads its card ON its machine, and an unready machine runs nothing", async () => {
  const s = setup({}, { machine: "vps" });
  s.fake.setSpaces([{ id: "s1", index: 1, name: "s1", folder: "/", machine: "vps", tabs: [{ id: "s1/t1", index: 1, name: "1" }] }]);
  const cli = s.execs;
  // the registrations for vps come from the same scripted ahub; selection is by the row it returns
  await s.entry.refresh(); s.entry.select("p_a");
  await s.entry.refreshCard();
  expect(cli.filter(e => e.args.includes("status")).every(e => e.on === "vps" && e.cwd === "/work/a" && e.args[0] === "--project" && e.args[1] === "p_a")).toBe(true);
  s.fake.setMachines([{ name: null, layout: "ready" }, { name: "vps", layout: "unavailable" }]);
  const before = cli.length;
  expect(await s.entry.refreshCard()).toEqual({ ok: false, state: "machine_unavailable" });
  expect(cli.length).toBe(before);
  expect(s.entry.card()).toMatchObject({ ok: false, state: "machine_unavailable" });
});

test("AC6: the card and Herdr's own states never reach ahub: no call but the fixed reads, and no write-shaped command in any file", async () => {
  const s = setup({}); await ready(s);
  await s.entry.refreshCard(); await s.entry.refreshCard();
  const allowed = new Set(["projects --json", "--project p_a status --json"]);
  for (const e of s.execs) { expect(e.command).toBe("ahub"); expect(allowed.has(e.args.join(" ")), e.args.join(" ")).toBe(true); }
  const files = ["card.js", "focus.js", "core.js", "main.js"].map(n => require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../integrations/herdr/mod", n), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  for (const text of files) for (const bad of [/\btask[_ -]?done\b/i, /\bhub_review\b/, /\bhub_task/, /\bahub\s+(review|task|send|ask|approve)\b/, /"review"|"approve"|"approved"/, /\bhub_send\b|\bhub_remember\b/]) expect(text, String(bad)).not.toMatch(bad);
  // the closed state words contain no task or approval vocabulary beyond the counts the hub itself names
  for (const state of card.CARD_STATES) expect(state).toMatch(/^[a-z_]+$/);
});

test("review thread (custom state directory): the card selects the registration by id, so a running project with a custom state directory is not read as offline", async () => {
  const execs: HerdrFixtureExecCall[] = [];
  const cli: HerdrFixtureCliPort = async call => {
    execs.push({ ...call, args: [...call.args] });
    const selector = call.args[0] === "--project" ? call.args[1] : null;
    const j = (selector === null ? call.args : call.args.slice(2)).join(" ");
    const ok = (stdout: string, exitCode = 0, stderr = "") => ({ stdout, stderr, exitCode, timedOut: false, truncated: false });
    if (j === "projects --json") return ok(JSON.stringify([{ id: "p_c", root: "/work/c", state: "running", stateDir: "/elsewhere/custom-state" }]));
    // ahub (src/cli/main.ts): a selector uses the state directory the registry recorded; with no selector the DEFAULT state directory is assumed
    if (j === "status --json") return selector === "p_c" ? ok(JSON.stringify({ ...OK, projectId: "p_c", cwd: "/work/c" })) : ok("", 1, "ahub: no hub running for /work/c/.agenthub/state (run: ahub up)\n");
    throw new Error(`unexpected ${j}`);
  };
  const fake = new FakeHerdrModHost({ offeredFunctions: ["exec", "run", "hc", "spaces", "panes", "focused", "machines", "terminals", "commands"], offeredCommands: Object.keys(HERDR_FIXTURE_COMMANDS),
    spaces: [{ id: "s1", index: 1, name: "s1", folder: "/work", machine: null, tabs: [{ id: "s1/t1", index: 1, name: "1" }] }],
    focused: { space: "s1", tab: "s1/t1", pane: "p1", terminal: "t1", shown: null, agent: null, cwd: "/work/c/src" }, cli, machines: [{ name: null, layout: "ready" }] });
  const entry = core.createHerdrEntry({ host: { exec: (c: string, a?: string[], o?: unknown) => fake.exec(c, a, o), spaces: () => fake.spaces(), machines: () => fake.machines(), focused: () => fake.focused(), terminals: () => fake.terminals(), hc: (a: string[]) => fake.hc(a), run: (n: string, a: Record<string, unknown>) => fake.run(n, a), platform: () => "macos", now: () => 1 } });
  await entry.refresh(); entry.select("p_c");
  expect(await entry.refreshCard()).toEqual({ ok: true, state: "running" });
  expect(entry.card()).toMatchObject({ ok: true, projectId: "p_c" });
  const status = execs.filter(e => e.args.includes("status"));
  expect(status.length).toBeGreaterThan(0);
  expect(status.every(e => e.args[0] === "--project" && e.args[1] === "p_c" && e.args[2] === "status")).toBe(true);
});

test("review thread (machine change during the card read): a card read after the machine went away is refused or dropped, never shown", async () => {
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(r => { release = r; }), at = new Promise<void>(r => { reached = r; });
  const s = setup({}); await ready(s);
  const orig = s.host.exec;
  s.host.exec = async (c: string, a?: string[], o?: unknown) => { if (a?.includes("status")) { reached(); await gate; } return orig(c, a, o); };
  const pending = s.entry.refreshCard();
  await at;
  s.fake.setSpaces([]); // the space is gone while ahub is answering
  await s.entry.refresh(); // the person's next action re-reads the context
  release();
  expect(await pending).toMatchObject({ ok: false, refusal: "stale" });
  expect(s.entry.card()).toBeNull();
});

test("review thread (cwd proof): a reported folder that only starts with, or differs by a slash from, the selected root is `changed`, never shown as the card", async () => {
  for (const reported of ["/work", "/work/a/sub", "/work/ab", "/work/a/", "/WORK/A"]) {
    const s = setup({ stdout: JSON.stringify({ ...OK, cwd: reported }) }); await ready(s);
    await s.entry.refreshCard();
    expect(s.entry.card(), reported).toMatchObject({ ok: false, state: "changed" });
    expect(JSON.stringify(s.entry.card()), reported).not.toContain("690");
  }
});

test("review thread (card text): the visible card shows the hub version and each peer's queue, and tells a queue of 0 from one that is unknown", async () => {
  const s = setup({ stdout: JSON.stringify({ projectId: "p_a", cwd: "/work/a", version: "0.33.0", tasks: { approved: 690, in_progress: 1 },
    peers: { claude: { state: "idle", queued: 0 }, codex: { state: "busy", queued: 7, pullOnly: false }, agy: { state: "idle", pullOnly: true }, kimi: { state: "paused", queued: -3 } } }) });
  await ready(s);
  await s.entry.refreshCard();
  const lines = s.entry.cardLines();
  const text = lines.join("\n");
  // the version is shown
  expect(lines[0]).toContain("hub 0.33.0");
  // a peer with nothing waiting, a backed-up peer and peers whose count is missing or invalid are four different lines
  expect(text).toContain("claude idle, queue 0");
  expect(text).toContain("codex busy, queue 7");
  expect(text).toContain("agy idle, queue ?, pull-only");
  expect(text).toContain("kimi paused, queue ?");
  expect(text).not.toMatch(/queue 0[^\n;]*agy|agy idle, queue 0/);
  expect(text).not.toContain("queue -3");
  expect(lines[0]).toContain("approved 690, in_progress 1");
  // and the card is made of ids, counts and closed words only
  expect(text).not.toMatch(/PII|SECRET|doing/);
});

test("review thread (card text): every state has its own visible text, and a missing version is said so rather than left blank", async () => {
  const noVersion = setup({ stdout: JSON.stringify({ projectId: "p_a", cwd: "/work/a", tasks: { approved: 1 }, peers: { claude: { state: "idle", queued: 2 } } }) }); await ready(noVersion);
  await noVersion.entry.refreshCard();
  const partial = noVersion.entry.cardLines();
  expect(partial[0]).toContain("Status (partial)"); expect(partial[0]).toContain("hub version unknown");
  expect(partial.join("\n")).toContain("Missing from the reading: version");
  expect(partial.join("\n")).toContain("claude idle, queue 2");
  const fresh = setup({}); await ready(fresh);
  expect(fresh.entry.cardLines()).toEqual(["Status: not read. Click Status."]);
  for (const [name, run, word] of [["offline", { code: 1, stdout: "", stderr: "ahub: no hub running for /x (run: ahub up)\n" }, "offline"], ["timeout", { reject: true, ms: 30_000 }, "timeout"], ["failed", { code: 2, stdout: "", stderr: "x" }, "failed"], ["bad", { stdout: "nope" }, "bad_output"]] as const) {
    const s = setup(run); await ready(s); await s.entry.refreshCard();
    const out = s.entry.cardLines();
    expect(out, name).toHaveLength(1);
    expect(out[0], name).toContain(`Status (${word}): `);
    expect(out[0], name).not.toMatch(/; hub |hub [0-9]|tasks:/); // a failure shows no reading: no version, no counts
  }
  // an old reading is shown as stale in the same line, with its numbers
  const old = setup({}); await ready(old); await old.entry.refreshCard();
  old.tick(card.STALE_AFTER_MS + 1000);
  expect(old.entry.cardLines()[0]).toContain("Status (stale)");
  expect(old.entry.cardLines()[0]).toContain("hub 0.33.0");
});

test("review thread (card text): the formatter is pure and the rendered glue holds no card formatting of its own", () => {
  expect(card.formatCard(null, () => "")).toEqual(["Status: not read. Click Status."]);
  expect(card.formatCard({ ok: false, state: "offline" }, (s: string) => `fixed ${s}`)).toEqual(["Status (offline): fixed offline"]);
  const good = { ok: true, state: "running", version: "1.2.3", tasks: {}, peers: [], missing: [] };
  expect(card.formatCard(good, () => "")).toEqual(["Status (running): hub 1.2.3; tasks: no task counts", "Peers: none reported"]);
  expect(card.formatCard({ ...good, peers: [{ id: "a", state: "idle", queued: null, pullOnly: false }, { id: "b", state: "busy", queued: 0, pullOnly: false }] }, () => "")[1]).toBe("Peers: a idle, queue ?; b busy, queue 0");
  const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../integrations/herdr/mod/main.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  expect(src).toContain("this.entry.cardLines()");
  // the glue never reaches into a reading, whatever it names the variable: no `.peers`, `.tasks`, `.queued`, `.version`, `.missing` or `.pullOnly` access, and no `this.entry.card(` call at all
  expect(src).not.toMatch(/\.(peers|tasks|queued|version|missing|pullOnly)\b/);
  expect(src).not.toMatch(/this\.entry\.card\(/);
});

test("the card projection bounds: too many task states or peers, an oversized count and an unknown peer state", () => {
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, 1]));
  expect(card.projectStatus({ ...OK, tasks: many }, 1, 1)).toMatchObject({ state: "partial", tasks: null });
  const peers = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`p${i}`, { state: "idle" }]));
  expect(card.projectStatus({ ...OK, peers }, 1, 1)).toMatchObject({ state: "partial", peers: null });
  expect(card.projectStatus({ ...OK, tasks: { approved: 2e9 } }, 1, 1)).toMatchObject({ tasks: null });
  const odd = card.projectStatus({ ...OK, peers: { x: { state: "somethingnew" } } }, 1, 1);
  expect(odd.peers).toEqual([{ id: "x", state: "unknown", queued: null, pullOnly: false }]);
  expect(card.projectStatus(null, 1, 1)).toEqual({ ok: false, state: "bad_output" });
  expect(card.classifyRun({ rejected: false, result: { code: 0, stdout: "x".repeat(card.CARD_MAX_BYTES + 1) } })).toEqual({ kind: "too_large" });
  expect(card.classifyRun({ rejected: false, result: { code: "0" } })).toEqual({ kind: "failed" });
});
