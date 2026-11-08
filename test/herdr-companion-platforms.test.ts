import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeHerdrModHost, HERDR_FIXTURE_COMMANDS, type HerdrFixtureCliPort, type HerdrFixtureExecCall } from "./helpers/herdr-mod-host.ts";
// @ts-ignore TS7016: untyped plain JavaScript by design
import * as core from "../integrations/herdr/mod/core.js";

// #1199 H3 (task #796, AC9): each combination has its own recorded verdict, a combination without a receipt stays unsupported, and the remote workflow is exercised against the fixture only.
// The receipts need a person's machines and are person-run; this file proves the rules around them and never claims them.
const DIR = join(import.meta.dir, "../integrations/herdr");
const matrix = JSON.parse(readFileSync(join(DIR, "support-matrix.json"), "utf8"));
const contract = JSON.parse(readFileSync(join(DIR, "host-contract-v1.json"), "utf8"));

function setup(opts: { machine?: string | null; platform?: string } = {}) {
  const machine = opts.machine === undefined ? "vps" : opts.machine;
  const execs: HerdrFixtureExecCall[] = [];
  const cli: HerdrFixtureCliPort = async call => {
    execs.push({ ...call, args: [...call.args] });
    // ahub's selector rule (src/cli/main.ts): `--project <id>` selects the registration; with none the project comes from the cwd and the default state directory.
    const selector = call.args[0] === "--project" ? call.args[1] : null;
    const j = (selector === null ? call.args : call.args.slice(2)).join(" ");
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0, timedOut: false, truncated: false });
    if ((j === "status --json" || j === "ui") && selector !== "p_r") return { stdout: "", stderr: "ahub: no hub running for /x/.agenthub/state (run: ahub up)\n", exitCode: 1, timedOut: false, truncated: false };
    if (j === "projects --json") return ok(JSON.stringify([{ id: "p_r", root: "/home/dev/it's an app", state: "running" }]));
    if (j === "status --json") return ok(JSON.stringify({ projectId: "p_r", cwd: "/home/dev/it's an app", version: "0.33.0", tasks: { approved: 3 }, peers: { claude: { state: "idle", queued: 0 } } }));
    if (j === "ui") return ok("");
    throw new Error(`unexpected ${j}`);
  };
  const fake = new FakeHerdrModHost({ offeredFunctions: ["exec", "run", "hc", "spaces", "panes", "focused", "machines", "terminals", "commands"], offeredCommands: Object.keys(HERDR_FIXTURE_COMMANDS),
    spaces: [{ id: "s1", index: 1, name: "s1", folder: "/", machine, tabs: [{ id: "s1/t1", index: 1, name: "1" }] }],
    focused: { space: "s1", tab: "s1/t1", pane: "p1", terminal: "t1", shown: null, agent: null, cwd: "/home/dev/it's an app/src" }, cli,
    terminals: [{ address: "vps/t1", state: "live" }], machines: [{ name: null, layout: "ready" }, { name: "vps", layout: "ready" }], syntheticState: { terminals: ["vps/t1"], agents: [] } });
  const runs: { name: string; args: Record<string, unknown> }[] = [];
  const host = { exec: (c: string, a?: string[], o?: unknown) => fake.exec(c, a, o), spaces: () => fake.spaces(), machines: () => fake.machines(), focused: () => fake.focused(), terminals: () => fake.terminals(),
    hc: (a: string[]) => fake.hc(a), platform: () => opts.platform ?? "macos",
    run: (n: string, a: Record<string, unknown>) => { fake.run(n, a); runs.push({ name: n, args: JSON.parse(JSON.stringify(a)) });
      if (n === "tab.new") fake.setSpaces(fake.spaces().map(s => s.id === a.space ? { ...s, tabs: [...s.tabs, { id: `${s.id}/t${s.tabs.length + 1}`, index: s.tabs.length + 1, name: "new" }] } : s)); return null; } };
  const entry = core.createHerdrEntry({ host });
  return { fake, entry, execs, runs, host };
}
const ready = async (s: ReturnType<typeof setup>) => { await s.entry.refresh(); return s.entry.select("p_r"); };

test("AC9: the support matrix gives every combination its own verdict, and none is claimed without a receipt that no longer says NOT RUN", () => {
  const ids = matrix.combinations.map((c: { id: string }) => c.id);
  expect(ids).toEqual(["macos-local", "remote-space", "windows", "linux", "browser-or-mobile"]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const c of matrix.combinations) {
    expect(matrix.verdicts, c.id).toContain(c.verdict);
    expect(typeof c.reason === "string" && c.reason.length > 20, c.id).toBe(true);
    if (c.verdict === "supported") {
      expect(c.receipt, `${c.id} is supported without a receipt`).toBeTruthy();
      const file = join(DIR, c.receipt);
      expect(existsSync(file), `${c.id}: receipt ${c.receipt} does not exist`).toBe(true);
      expect(readFileSync(file, "utf8"), `${c.id}: receipt still says NOT RUN`).not.toMatch(/Status:\s*\**\s*NOT RUN/);
    }
  }
  // Today nothing is supported: each leg is a person-run step that has not been run. If this changes, a person must have filled a receipt in.
  expect(matrix.combinations.filter((c: { verdict: string }) => c.verdict === "supported")).toEqual([]);
  expect(matrix.combinations.find((c: { id: string }) => c.id === "macos-local").verdict).toBe("fixture_only");
  for (const id of ["remote-space", "windows", "linux", "browser-or-mobile"]) expect(matrix.combinations.find((c: { id: string }) => c.id === id).verdict).toBe("unsupported");
});

test("AC9: every receipt a combination names exists, is a NOT RUN template that says person-run, and is never pre-filled with a pass", () => {
  for (const c of matrix.combinations.filter((x: { receipt: string | null }) => x.receipt)) {
    const text = readFileSync(join(DIR, c.receipt), "utf8");
    expect(text, c.id).toMatch(/NOT RUN/);
    expect(text, c.id).toMatch(/person/i);
    expect(text, c.id).not.toMatch(/Overall:\s*(PASS|PASSED)\s*(\n|$)/);
    expect(text, c.id).not.toMatch(/\bPASSED\b/);
  }
  for (const name of ["remote", "windows", "browser-mobile"]) expect(existsSync(join(DIR, "receipts", `${name}.md`)), name).toBe(true);
  expect(readFileSync(join(DIR, "receipts/browser-mobile.md"), "utf8")).toMatch(/not inferred/i);
  expect(readFileSync(join(DIR, "receipts/remote.md"), "utf8")).toMatch(/hc machine ls/);
});

test("AC9: the remote console workflow, against the fixture: read on the machine, prove there, open in that machine's space, nothing here", async () => {
  const before = existsSync("/home/dev/it's an app");
  const s = setup();
  expect(await s.entry.refresh()).toMatchObject({ status: "ready", machine: "vps", candidate: "single" });
  s.entry.select("p_r");
  expect(await s.entry.openConsole()).toMatchObject({ ok: true, opened: "console", machineLabel: "vps" });
  expect(s.execs.length).toBeGreaterThan(0);
  expect(s.execs.every(e => e.on === "vps")).toBe(true);
  expect(s.runs).toEqual([{ name: "tab.new", args: { space: "s1", folder: "/home/dev/it's an app", argv: ["ahub", "--project", "p_r", "console"], name: "ahub: it's an app" } }]);
  expect(JSON.stringify(s.runs)).not.toMatch(/vps/);
  expect(existsSync("/home/dev/it's an app")).toBe(before);
  // the copyable command names the machine and is one quoted word
  expect(s.entry.copyCommand()).toEqual({ ok: true, command: "ahub --project '/home/dev/it'\\''s an app' console", machine: "vps", machineLabel: "vps" });
  // the status card reads on that machine, from that folder
  expect(await s.entry.refreshCard()).toEqual({ ok: true, state: "running" });
  const status = s.execs.filter(e => e.args.includes("status"));
  expect(status.length).toBeGreaterThan(0);
  expect(status.every(e => e.on === "vps" && e.cwd === "/home/dev/it's an app" && e.args[0] === "--project" && e.args[1] === "p_r")).toBe(true);
});

test("AC9: a remote space never gets a dashboard link or terminal focus: both refuse before anything runs", async () => {
  const s = setup(); await ready(s);
  const before = s.execs.length;
  const dash = await s.entry.openDashboard();
  expect(dash).toMatchObject({ ok: false, refusal: "remote" });
  expect(JSON.stringify(dash)).not.toMatch(/https?:\/\/|127\.0\.0\.1|localhost|ticket/);
  expect(await s.entry.focusConsole()).toMatchObject({ ok: false, refusal: "remote_focus" });
  expect(await s.entry.peekConsole()).toMatchObject({ ok: false, refusal: "remote_focus" });
  expect(s.execs.length).toBe(before);
  expect(s.fake.hcCalls).toEqual([]); expect(s.runs).toEqual([]);
  expect(s.execs.some(e => e.args.includes("ui"))).toBe(false);
});

test("AC9: machine loss and an unknown machine refuse the remote workflow without opening anything", async () => {
  const lost = setup(); await ready(lost);
  lost.fake.setMachines([{ name: null, layout: "ready" }, { name: "vps", layout: "unavailable" }]);
  expect(await lost.entry.openConsole()).toMatchObject({ ok: false, refusal: "machine_unavailable" });
  expect(await lost.entry.refreshCard()).toEqual({ ok: false, state: "machine_unavailable" });
  expect(lost.runs).toEqual([]);
  const unknown = setup();
  unknown.fake.setMachines([{ name: null, layout: "ready" }]);
  expect(await unknown.entry.refresh()).toMatchObject({ status: "refused", refusal: "unknown_machine" });
  expect(unknown.execs).toEqual([]);
  // declaring the machine "local" is not possible: a remote name is never mapped to this Mac, so nothing is read here
  expect(unknown.execs.some(e => e.on === null || e.on === undefined)).toBe(false);
});

test("AC9 (review fix carried from H1): a remote selection whose space moves onto this computer while the proof is held opens nothing, and a remote project with a custom state directory is read by id", async () => {
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(r => { release = r; }), at = new Promise<void>(r => { reached = r; });
  const s = setup(); await ready(s);
  const orig = s.host.exec;
  s.host.exec = async (c: string, a?: string[], o?: unknown) => { if (a?.includes("status")) { reached(); await gate; } return orig(c, a, o); };
  const pending = s.entry.openConsole();
  await at;
  s.fake.setSpaces([{ id: "s1", index: 1, name: "s1", folder: "/", machine: null, tabs: [{ id: "s1/t1", index: 1, name: "1" }] }]);
  release();
  expect(await pending).toMatchObject({ ok: false, refusal: "changed" });
  expect(s.runs).toEqual([]);
  // every project command on the remote machine names the registration by id and runs there
  const fresh = setup(); await ready(fresh); await fresh.entry.openConsole(); await fresh.entry.refreshCard();
  for (const e of fresh.execs.filter(x => !x.args.includes("projects"))) { expect(e.on, e.args.join(" ")).toBe("vps"); expect(e.args.slice(0, 2), e.args.join(" ")).toEqual(["--project", "p_r"]); }
});

test("AC9: on Windows every action refuses, for a local space AND a remote one, and nothing is read, opened, copied or focused", async () => {
  for (const machine of [null, "vps"]) {
    const s = setup({ platform: "windows", machine });
    expect(await s.entry.refresh(), String(machine)).toMatchObject({ status: "refused", refusal: "unsupported_platform" });
    expect(s.execs, String(machine)).toEqual([]);
    expect(await s.entry.openConsole()).toMatchObject({ ok: false });
    expect(await s.entry.openDashboard()).toMatchObject({ ok: false });
    expect(await s.entry.refreshCard()).toMatchObject({ ok: false });
    expect(s.entry.copyCommand()).toMatchObject({ ok: false });
    expect(await s.entry.focusConsole()).toMatchObject({ ok: false });
    expect(s.runs).toEqual([]); expect(s.fake.hcCalls).toEqual([]); expect(s.execs).toEqual([]);
  }
  // the guard on each effect holds on its own when the platform answer changes after a selection, including for a remote space (the case that once slipped through)
  for (const machine of [null, "vps"]) {
    let platform = "macos";
    const s = setup({ machine });
    const host2 = { exec: (c: string, a?: string[], o?: unknown) => s.fake.exec(c, a, o), spaces: () => s.fake.spaces(), machines: () => s.fake.machines(), focused: () => s.fake.focused(), terminals: () => s.fake.terminals(), hc: (a: string[]) => s.fake.hc(a), run: (n: string, a: Record<string, unknown>) => { s.runs.push({ name: n, args: a }); return null; }, platform: () => platform };
    const entry = core.createHerdrEntry({ host: host2 });
    await entry.refresh(); entry.select("p_r"); platform = "windows";
    const before = s.execs.length;
    expect(await entry.openConsole(), String(machine)).toMatchObject({ ok: false, refusal: "unsupported_platform" });
    expect(await entry.refreshCard(), String(machine)).toMatchObject({ ok: false, refusal: "unsupported_platform" });
    expect(entry.copyCommand(), String(machine)).toMatchObject({ ok: false, refusal: "unsupported_platform" });
    expect(s.execs.length).toBe(before); expect(s.runs).toEqual([]);
  }
  // macOS and Linux are the same code with the same checks: a re-pointed project is still refused
  for (const platform of ["macos", "linux"]) {
    const s = setup({ platform, machine: null }); await ready(s);
    expect((await s.entry.openConsole()).ok, platform).toBe(true);
  }
});

test("AC9: the baseline comparison agrees with the H0 contract: same journeys, same procedure counts, nothing observed", () => {
  const text = readFileSync(join(DIR, "baseline-comparison.md"), "utf8");
  for (const j of contract.baselineJourneys.journeys) expect(j.procedureCount).toBe(2);
  expect(text).toMatch(/Local console \| 2:/); expect(text).toMatch(/Local dashboard \| 2:/); expect(text).toMatch(/Remote console \| 2 /);
  expect(text.replace(/\s+/g, " ")).toMatch(/Nothing was observed in a native Herdr window/);
  // every row's observed column is "not run"
  const rows = text.split("\n").filter(l => /^\| (Local console|Local dashboard|Remote console|Existing local console) \|/.test(l));
  expect(rows).toHaveLength(4);
  for (const row of rows) expect(row.trimEnd().endsWith("| not run |") || /\| not run, no machine configured \|$/.test(row.trimEnd()), row).toBe(true);
  // the comparison does not claim a gain it did not measure
  expect(text).toMatch(/No action-count gain is claimed/);
  expect(text).not.toMatch(/\bfaster\b|\bsaves? (an? )?action|fewer actions/i);
});

test("AC9: the README, support matrix and baseline comparison say the same thing about what is claimed", () => {
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  for (const c of matrix.combinations) expect(readme, c.id).toContain(c.id);
  expect(readme).toMatch(/person-run/);
  expect(readme).toMatch(/support-matrix\.json/);
  expect(readme).toMatch(/baseline-comparison\.md/);
  const dogfood = readFileSync(join(import.meta.dir, "../docs/dogfood.md"), "utf8");
  expect(dogfood).toMatch(/#1199 H3/);
  expect(dogfood).toMatch(/person-run/);
});
