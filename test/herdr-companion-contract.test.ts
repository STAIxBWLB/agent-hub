import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FakeHerdrModHost, HERDR_EXEC_MAX_OUTPUT_BYTES, HERDR_EXEC_TIMEOUT_MS, HERDR_FIXTURE_COMMANDS, HerdrFixtureError, type HerdrFixtureFunction, type HerdrFixtureSpace } from "./helpers/herdr-mod-host.ts";
import { FakeHerdrCompanionCli, HerdrFixtureCliError, type HerdrFixtureCliResponse } from "./fakes/herdr-companion-cli.ts";
import { containsAtBoundary, herdrRootCandidates, readRegisteredProjects } from "./helpers/herdr-root-candidates.ts";

// #1199 H0 (task #793): the frozen Herdr mod host contract, its fixtures and the selector rules. Nothing here starts Herdr, loads a mod, reads a profile or touches the network.
// A fake cannot establish installed capabilities, terminal address equivalence, native UI improvement or remote reachability: those stay person-run receipts in H1 to H3.
const PLUGIN = join(import.meta.dir, "../integrations/herdr");
const contract = JSON.parse(readFileSync(join(PLUGIN, "host-contract-v1.json"), "utf8"));
const ALL: HerdrFixtureFunction[] = ["exec", "run", "spaces", "panes", "focused", "machines", "terminals", "commands"];
const space = (id: string, machine: string | null, folder = "/work/proj"): HerdrFixtureSpace => ({ id, index: 1, name: id, folder, machine, tabs: [{ id: `${id}/t1`, index: 1, name: "1" }] });
const focus = (cwd: string | null, extra: Record<string, unknown> = {}) => ({ space: "s1", tab: "s1/t1", pane: "p1", terminal: "t7", shown: null, agent: null, cwd, ...extra });
function host(scripted: HerdrFixtureCliResponse[] = [], opts: Partial<ConstructorParameters<typeof FakeHerdrModHost>[0]> = {}) {
  const cli = new FakeHerdrCompanionCli({ scripted });
  const fake = new FakeHerdrModHost({ offeredFunctions: ALL, offeredCommands: Object.keys(HERDR_FIXTURE_COMMANDS), spaces: [space("s1", null)], focused: focus("/work/proj"), terminals: [{ address: "t7" }, { address: "t9" }],
    machines: [{ name: null, layout: "ready" }, { name: "vps", layout: "ready" }], cli: cli.run, syntheticState: { terminals: ["t7", "t9"], agents: ["a1"] }, ...opts });
  return { cli, fake };
}
const code = async (fn: () => unknown) => { try { await fn(); } catch (error) { return (error as { code?: string }).code ?? String(error); } return "no error"; };

test("the contract file records its evidence, hashes, and what was and was not observed", () => {
  expect(contract.task).toBe("H0"); expect(contract.issue).toBe(1199);
  for (const hash of Object.values(contract.evidence.sources)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(contract.evidence.notObserved.join(" ")).toMatch(/remote machine/);
  expect(contract.evidence.notObserved.join(" ")).toMatch(/inside the app/);
  expect(contract.modApi.functions.exec.limits).toEqual({ timeoutMs: HERDR_EXEC_TIMEOUT_MS, maxOutputBytes: HERDR_EXEC_MAX_OUTPUT_BYTES, source: "doc comment in herdr.d.ts" });
  expect(contract.modApi.noDocumentedModInstallOrDisableCommand).toBe(true);
  // the commands the companion may use are exactly the fixture's, and none of the destructive ones is among them
  expect(contract.modApi.commands.usedByCompanion["terminal.open"]).toEqual(HERDR_FIXTURE_COMMANDS["terminal.open"] as unknown as string[]);
  for (const name of Object.keys(contract.modApi.commands.usedByCompanion)) expect(Object.keys(HERDR_FIXTURE_COMMANDS)).toContain(name);
  for (const bad of ["terminal.kill", "terminal.park", "terminal.keep", "tab.close", "space.close", "pane.close"]) expect(contract.modApi.commands.neverUsedByCompanion).toContain(bad);
});

test("the three baseline journeys are procedure counts with the selector counted separately, and none claims an observed result", () => {
  const journeys = contract.baselineJourneys.journeys;
  expect(journeys.map((j: { id: string }) => j.id)).toEqual(["local-console", "local-dashboard", "remote-console"]);
  for (const j of journeys) { expect(j.procedureCount).toBe(2); expect(j.selection).toMatch(/^1,/); expect(j.observed).toMatch(/^not run/); }
  expect(contract.baselineJourneys.note).toMatch(/Nothing here was observed in a native Herdr window/);
});

test("AC8: exec takes a fixed argv and opaque arguments, with the host's own caps; special characters are never shell code", async () => {
  const weird = "/work/it's a \"proj\" $(rm -rf x);`y` ü 한글";
  const { fake, cli } = host([{ stdout: "{}", exitCode: 0 }], { focused: focus(weird) });
  await fake.exec("ahub", ["--project", weird, "status", "--json"], { cwd: weird, on: null });
  expect(cli.calls).toEqual([{ command: "ahub", args: ["--project", weird, "status", "--json"], cwd: weird, on: null, timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024 }]);
  // a string of arguments, a non-string argument, an unknown option and an empty command are refused before anything runs
  for (const bad of [() => fake.exec("ahub", "status" as never), () => fake.exec("ahub", [1 as never]), () => fake.exec("ahub", [], { shell: true } as never), () => fake.exec("")]) expect(await code(bad)).toBe("invalid_params");
  expect(cli.calls).toHaveLength(1);
  // a command with a space is one opaque program name that cannot start; it is never split into a command line
  const spaced = host([{ stdout: "", exitCode: null }]);
  expect(await code(() => spaced.fake.exec("ahub status; rm -rf x"))).toBe("exec_cannot_start");
  expect(spaced.cli.calls.map(c => [c.command, c.args])).toEqual([["ahub status; rm -rf x", []]]);
});

test("AC8: machine loss, an unknown machine, a timeout, an oversized output and a failed start each reject distinctly and never run locally", async () => {
  const lost = host([{ stdout: "x", exitCode: 0 }], { machines: [{ name: null, layout: "ready" }, { name: "vps", layout: "unavailable" }] });
  // a listed machine with an unavailable layout is still reachable for exec as far as the host documents, so the companion must gate on layout itself (see the selector test)
  expect(await code(() => lost.fake.exec("ahub", ["status"], { on: "gone" }))).toBe("exec_machine_unreachable");
  expect(lost.cli.calls).toHaveLength(0);
  const slow = host([{ stdout: "", exitCode: 0, durationMs: HERDR_EXEC_TIMEOUT_MS + 1 }]);
  expect(await code(() => slow.fake.exec("ahub", ["status"]))).toBe("exec_timeout");
  const big = host([{ stdout: "x".repeat(HERDR_EXEC_MAX_OUTPUT_BYTES + 10), exitCode: 0 }]);
  expect(await code(() => big.fake.exec("ahub", ["status"]))).toBe("exec_output_too_large");
  const dead = host([{ stdout: "", exitCode: null }]);
  expect(await code(() => dead.fake.exec("nope", []))).toBe("exec_cannot_start");
  const nonzero = host([{ stdout: "", stderr: "ahub: no hub running for /p/.agenthub/state (run: ahub up)\n", exitCode: 1 }]);
  expect(await nonzero.fake.exec("ahub", ["status", "--json"])).toEqual({ code: 1, stdout: "", stderr: "ahub: no hub running for /p/.agenthub/state (run: ahub up)\n" });
  // multibyte output is cut on a character boundary, never in the middle of one
  const cut = new FakeHerdrCompanionCli({ scripted: [{ stdout: "한".repeat(10), exitCode: 0 }] });
  const r = await cut.run({ command: "x", args: [], cwd: undefined, on: undefined, timeoutMs: 1000, maxOutputBytes: 7 });
  expect(r.stdout).toBe("한한"); expect(r.truncated).toBe(true);
});

test("AC8: run accepts only the documented commands and arguments, and returns null so success is learned only by re-reading", () => {
  const { fake } = host();
  expect(fake.run("tab.new", { folder: "/work/proj", argv: ["ahub", "console"] })).toBeNull();
  expect(fake.run("tab.select", { id: "s1/t1", space: null })).toBeNull();
  for (const [name, args, expected] of [
    ["tab.close", { id: "s1/t1" }, "unknown_command"], ["terminal.kill", { terminal: "t7" }, "unknown_command"], ["nope", {}, "unknown_command"],
    ["terminal.open", { machine: "vps" }, "unknown_argument"], ["tab.new", { space: "s1", cwd: "/x" }, "unknown_argument"],
    ["terminal.peek", {}, "missing_argument"], ["pane.focus", { terminal: 7 }, "invalid_params"], ["pane.focus", [] , "invalid_params"],
  ] as const) expect(((): string => { try { fake.run(name, args); return "no error"; } catch (error) { return (error as HerdrFixtureError).code; } })(), `${name} ${JSON.stringify(args)}`).toBe(expected);
  expect(fake.runs.map(r => r.name)).toEqual(["tab.new", "tab.select"]);
  expect(fake.runs[1]!.args).toEqual({ id: "s1/t1" }); // a null argument means omitted, never a value
});

test("AC8: a focused layout terminal block makes implicit pane actions and right or down places fail", () => {
  const { fake } = host([], { focused: focus("/work/proj", { pane: null, terminal: "t7" }) });
  expect(() => fake.run("pane.split", { direction: "right" })).toThrow();
  expect(() => fake.run("terminal.open", { place: "right" })).toThrow();
  expect(fake.run("pane.split", { direction: "right", pane: "p1" })).toBeNull(); // an explicit pane is allowed
  expect(fake.run("terminal.open", { place: "tab" })).toBeNull();
});

test("AC5/AC8: a stale terminal address is a silent no-op, so focus is only believed after focused() is re-read", () => {
  const { fake } = host();
  const claimed = (address: string) => { fake.run("pane.focus", { terminal: address }); return fake.focused()?.terminal === address; };
  expect(claimed("t9")).toBe(true);
  fake.setFocused(focus("/work/proj"));
  expect(claimed("t-gone")).toBe(false); // run() returned null for both: only the re-read tells them apart
  expect(fake.runs.map(r => r.args.terminal)).toEqual(["t9", "t-gone"]);
});

test("the root selector: exactly one containing registration is the default, at a segment boundary only", () => {
  const projects = [{ id: "p_a", root: "/work/a" }, { id: "p_ab", root: "/work/ab" }];
  expect(containsAtBoundary("/work/a", "/work/a")).toBe(true);
  expect(containsAtBoundary("/work/a", "/work/a/src/x")).toBe(true);
  expect(containsAtBoundary("/work/a", "/work/ab")).toBe(false);
  expect(containsAtBoundary("/work/a/", "/work/a/src")).toBe(true);
  expect(containsAtBoundary("work/a", "/work/a")).toBe(false);
  const { fake } = host([], { focused: focus("/work/ab/src") });
  expect(herdrRootCandidates(fake, projects)).toMatchObject({ kind: "single", project: { id: "p_ab" }, machine: null });
});

test("AC1: ambiguous, duplicate, missing and unregistered roots are explicit and never silently chosen", () => {
  const nested = [{ id: "p_outer", root: "/work" }, { id: "p_inner", root: "/work/proj" }];
  const { fake } = host();
  const amb = herdrRootCandidates(fake, nested);
  expect(amb).toMatchObject({ kind: "ambiguous", highlighted: { id: "p_inner" } });
  expect((amb as { candidates: unknown[] }).candidates).toHaveLength(2);
  expect(herdrRootCandidates(fake, [{ id: "p1", root: "/work/proj" }, { id: "p2", root: "/work/proj" }])).toEqual({ kind: "duplicate", machine: null, root: "/work/proj" });
  expect(herdrRootCandidates(fake, [{ id: "p3", root: "/elsewhere" }])).toMatchObject({ kind: "none", cwd: "/work/proj", choices: [{ id: "p3" }] });
  fake.setFocused(focus(null, { pane: null }));
  expect(herdrRootCandidates(fake, nested)).toMatchObject({ kind: "no_cwd" });
  fake.setFocused(null);
  expect(herdrRootCandidates(fake, nested)).toEqual({ kind: "no_context" });
  fake.setFocused(focus("/work/proj", { space: "ghost" }));
  expect(herdrRootCandidates(fake, nested)).toEqual({ kind: "no_context" });
});

test("AC1: a remote cwd is read on its own machine, an unavailable or unknown machine refuses, and nothing is resolved on this Mac", async () => {
  const remote = [{ id: "p_r", root: "/home/dev/app" }];
  const { fake, cli } = host([{ stdout: JSON.stringify(remote), exitCode: 0 }], { spaces: [space("s1", "vps", "/home/dev/app")], focused: focus("/home/dev/app/src") });
  const rows = await readRegisteredProjects(fake, "vps");
  expect(cli.calls).toEqual([{ command: "ahub", args: ["projects", "--json"], cwd: undefined, on: "vps", timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024 }]);
  expect(herdrRootCandidates(fake, rows as never)).toMatchObject({ kind: "single", machine: "vps", project: { id: "p_r" } });
  // the same cwd exists on no disk of this Mac: the selector never asked
  expect(existsSync("/home/dev/app")).toBe(false);
  fake.setMachines([{ name: null, layout: "ready" }, { name: "vps", layout: "unavailable" }]);
  expect(herdrRootCandidates(fake, remote)).toEqual({ kind: "machine_unavailable", machine: "vps" });
  fake.setMachines([{ name: null, layout: "ready" }]);
  expect(herdrRootCandidates(fake, remote)).toEqual({ kind: "unknown_machine", machine: "vps" });
  fake.setMachines([{ name: null, layout: "ready" }, { name: "vps", layout: "loading" }]);
  expect(herdrRootCandidates(fake, remote)).toEqual({ kind: "machine_unavailable", machine: "vps" });
});

test("AC4/AC8: the registrations read refuses invalid, truncated or wrong-shaped output instead of guessing", async () => {
  for (const [stdout, exitCode, expected] of [
    ["not json", 0, "not_json"], ["{}", 0, "not_a_list"], ["[{\"id\":1,\"root\":\"/x\"}]", 0, "bad_row"], ["[{\"id\":\"p\",\"root\":\"relative\"}]", 0, "bad_row"],
    ["[]", 1, "nonzero_exit"], ["[{\"id\":\"p\",\"root\":\"/x\"", 0, "not_json"],
  ] as const) {
    const { fake } = host([{ stdout, exitCode }]);
    expect(await readRegisteredProjects(fake, null), stdout).toEqual({ error: expected });
  }
  const slow = host([{ stdout: "[]", exitCode: 0, durationMs: 31_000 }]);
  expect(await readRegisteredProjects(slow.fake, null)).toEqual({ error: "exec_timeout" });
  const offline = host([], { machines: [{ name: null, layout: "ready" }] });
  expect(await readRegisteredProjects(offline.fake, "vps")).toEqual({ error: "exec_machine_unreachable" });
});

test("AC8: rapid project switches re-read the focus before each effect, and the last read wins", () => {
  const { fake } = host([], { focused: focus("/work/a") });
  const projects = [{ id: "p_a", root: "/work/a" }, { id: "p_b", root: "/work/b" }];
  const first = herdrRootCandidates(fake, projects);
  fake.setFocused(focus("/work/b"));
  const second = herdrRootCandidates(fake, projects);
  expect(first).toMatchObject({ kind: "single", project: { id: "p_a" } });
  expect(second).toMatchObject({ kind: "single", project: { id: "p_b" } });
  // an effect built from the first read is refused when the re-read no longer matches it
  const stillSame = (read: typeof first) => { const now = herdrRootCandidates(fake, projects); return read.kind === "single" && now.kind === "single" && now.project.id === read.project.id && now.machine === read.machine; };
  expect(stillSame(first)).toBe(false); expect(stillSame(second)).toBe(true);
});

test("AC7: disabling the mod host leaves terminals and agents untouched, and the companion CLI is never the owner of either", async () => {
  const { fake, cli } = host([{ stdout: "x", exitCode: 0 }]);
  const before = fake.snapshot();
  fake.setEnabled(false);
  expect(await code(() => fake.exec("ahub", ["status"]))).toBe("disabled");
  expect(await code(() => fake.spaces())).toBe("disabled");
  expect(fake.has("exec")).toBe(false); expect(fake.hasCommand("tab.new")).toBe(false);
  expect(fake.snapshot()).toEqual(before);
  expect(cli.calls).toHaveLength(0);
  fake.setEnabled(true);
  expect(fake.snapshot()).toEqual(before);
});

test("the fixture offers only what a test lists, and an unlisted function or command is unknown, not defaulted", async () => {
  const { fake } = host([], { offeredFunctions: ["spaces"], offeredCommands: ["tab.new"] });
  expect(fake.has("spaces")).toBe(true); expect(fake.has("exec")).toBe(false);
  expect(await code(() => fake.exec("ahub", []))).toBe("unknown_function");
  expect(await code(() => fake.run("tab.new", {}))).toBe("unknown_function"); // run itself is not offered
  expect(() => new FakeHerdrModHost({ offeredFunctions: ["nope" as never], spaces: [], cli: async () => { throw new Error("no"); } })).toThrow();
  expect(() => new FakeHerdrModHost({ offeredFunctions: [], offeredCommands: ["tab.close"], spaces: [], cli: async () => { throw new Error("no"); } })).toThrow();
  const cli = new FakeHerdrCompanionCli({ scripted: [] });
  expect(await code(() => cli.run({ command: "x", args: [], cwd: undefined, on: undefined, timeoutMs: 1, maxOutputBytes: 1 }))).toBe("unscripted");
  expect(await code(() => cli.run({ command: "", args: [], cwd: undefined, on: undefined, timeoutMs: 1, maxOutputBytes: 1 }))).toBe("invalid_request");
  const off = new FakeHerdrCompanionCli({ scripted: [{ stdout: "", exitCode: 0 }], enabled: false });
  expect(await code(() => off.run({ command: "x", args: [], cwd: undefined, on: undefined, timeoutMs: 1, maxOutputBytes: 1 }))).toBe("disabled");
  expect(HerdrFixtureCliError.name).toBe("HerdrFixtureCliError");
});

test("neither companion depends on the other: the Herdr files never name Orca and the Orca files never name Herdr", () => {
  const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name));
  const herdr = [...files(PLUGIN), join(import.meta.dir, "helpers/herdr-mod-host.ts"), join(import.meta.dir, "helpers/herdr-root-candidates.ts"), join(import.meta.dir, "fakes/herdr-companion-cli.ts")];
  for (const file of herdr) expect(readFileSync(file, "utf8"), file).not.toMatch(/orca/i);
  const orca = join(import.meta.dir, "../integrations/orca");
  if (existsSync(orca)) for (const file of files(orca)) expect(readFileSync(file, "utf8"), file).not.toMatch(/herdr/i);
  for (const file of [join(import.meta.dir, "helpers/herdr-mod-host.ts"), join(import.meta.dir, "fakes/herdr-companion-cli.ts")]) expect(readFileSync(file, "utf8")).not.toMatch(/from "\.\.?\/(helpers|fakes)\/orca/);
});

test("no ahub runtime file mentions Herdr: this task changes no runtime", () => {
  const walk = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && /\.(ts|js|mjs)$/.test(e.name)).map(e => join(e.parentPath, e.name));
  for (const file of walk(join(import.meta.dir, "../src"))) expect(readFileSync(file, "utf8"), file).not.toMatch(/herdr/i);
});
