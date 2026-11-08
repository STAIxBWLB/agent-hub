/**
 * H0 contract fixture only (#1199, task #793). A synthetic stand-in for the `herdr` mod module: no native host, no Herdr process, no profile, no network.
 * It offers only the functions and commands a test lists, and it fails closed where the real host's behaviour is not documented. Where the fixture is
 * stricter than anything the host promises, `herdr-mod-host-v1.json` lists it under `fixtureStrictness`, so a green test is never read as a host fact.
 * It imports nothing from any other integration's fixtures: a companion for one product never depends on another.
 */
export interface HerdrFixtureTab { id: string; index: number; name: string }
export interface HerdrFixtureSpace {
  id: string;
  index: number;
  name: string;
  /** Where its new terminals start, on its machine. Empty means that machine's home. */
  folder: string;
  /** null is this computer; otherwise a name from `hc machine ls`. */
  machine: string | null;
  tabs: HerdrFixtureTab[];
}
export interface HerdrFixturePane { pane: string; terminal: string | null; tab: string; title: string; cwd: string | null; focused: boolean }
export interface HerdrFixtureFocus { space: string; tab: string; pane: string | null; terminal: string | null; shown: string | null; agent: string | null; cwd: string | null }
export interface HerdrFixtureMachine { name: string | null; layout: "loading" | "ready" | "unavailable" }
export type HerdrFixtureFunction = "exec" | "run" | "hc" | "spaces" | "panes" | "focused" | "machines" | "terminals" | "commands" | "openOverlay" | "closeOverlay" | "notify" | "props";
/** A row of `terminals()`: `hc ls --json` plus Herdr's own `status` word. Only `address` is required here; a test adds `state` and `status`. */
export interface HerdrFixtureTerminal { address: string; state?: string; status?: string | null; [key: string]: unknown }
export type HerdrFixtureHcGet = (address: string) => { code: number; stdout: string; stderr?: string } | "reject";
export interface HerdrFixtureExecCall { command: string; args: readonly string[]; cwd: string | undefined; on: string | null | undefined; timeoutMs: number; maxOutputBytes: number }
export interface HerdrFixtureCliResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean }
export type HerdrFixtureCliPort = (call: HerdrFixtureExecCall) => Promise<HerdrFixtureCliResult>;
export interface HerdrFixtureRun { name: string; args: Record<string, unknown> }
export type HerdrFixtureErrorCode = "unknown_function" | "unknown_command" | "unknown_argument" | "missing_argument" | "invalid_params" | "exec_cannot_start"
  | "exec_machine_unreachable" | "exec_timeout" | "exec_output_too_large" | "no_pane_target" | "disabled" | "hc_unsupported" | "hc_cannot_start";
export class HerdrFixtureError extends Error {
  constructor(readonly code: HerdrFixtureErrorCode) { super(code); this.name = "HerdrFixtureError"; }
}
/** The host's own limits, from the `exec` doc comment in the installed herdr.d.ts. */
export const HERDR_EXEC_TIMEOUT_MS = 30_000;
export const HERDR_EXEC_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Command argument names, taken from `herdr-app commands` on the installed app; `*` marks required. Only the commands the companion may use. */
export const HERDR_FIXTURE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "space.select": ["index", "id"],
  "tab.new": ["name", "space", "folder", "argv", "task", "mod", "props"],
  "tab.select": ["index", "id"],
  "terminal.open": ["argv", "folder", "place", "name"],
  "terminal.peek": ["terminal*"],
  "pane.focus": ["pane", "terminal"],
  "pane.split": ["direction*", "pane", "argv", "mod", "props"],
  "agent.focus": ["terminal*"],
  "mod.open": ["name*"],
  "overlay.close": ["id"],
};
const FUNCTIONS: readonly HerdrFixtureFunction[] = ["exec", "run", "hc", "spaces", "panes", "focused", "machines", "terminals", "commands", "openOverlay", "closeOverlay", "notify", "props"];
const fail = (code: HerdrFixtureErrorCode): never => { throw new HerdrFixtureError(code); };
const ID_ARGS = new Set(["id", "pane", "space", "terminal"]);

export interface FakeHerdrModHostOptions {
  /** Supplied by each test, never inferred from the declarations. */
  offeredFunctions: readonly HerdrFixtureFunction[];
  offeredCommands?: readonly string[];
  spaces: readonly HerdrFixtureSpace[];
  panes?: readonly HerdrFixturePane[];
  focused?: HerdrFixtureFocus | null;
  machines?: readonly HerdrFixtureMachine[];
  terminals?: readonly HerdrFixtureTerminal[];
  /** What `hc get <address> --json` answers. Unset: every address is `not_found` (exit 3, as observed). */
  hcGet?: HerdrFixtureHcGet;
  cli: HerdrFixtureCliPort;
  enabled?: boolean;
  /** Functional state that must survive the mod being disabled or removed. */
  syntheticState?: { terminals: string[]; agents: string[] };
}
export class FakeHerdrModHost {
  readonly execCalls: HerdrFixtureExecCall[] = [];
  readonly runs: HerdrFixtureRun[] = [];
  readonly opened: { name: string; args: Record<string, unknown> }[] = [];
  readonly hcCalls: string[][] = [];
  private readonly offered: Set<string>;
  private readonly commands: Set<string>;
  private spaceList: HerdrFixtureSpace[];
  private paneList: HerdrFixturePane[];
  private focus: HerdrFixtureFocus | null;
  private machineList: HerdrFixtureMachine[];
  private terminalList: HerdrFixtureTerminal[];
  private enabled: boolean;
  private readonly state: { terminals: string[]; agents: string[] };
  constructor(private readonly options: FakeHerdrModHostOptions) {
    if (options.offeredFunctions.some(name => !FUNCTIONS.includes(name))) fail("unknown_function");
    const offeredCommands = options.offeredCommands ?? [];
    if (offeredCommands.some(name => !Object.hasOwn(HERDR_FIXTURE_COMMANDS, name))) fail("unknown_command");
    this.offered = new Set(options.offeredFunctions); this.commands = new Set(offeredCommands);
    this.spaceList = structuredClone([...options.spaces]); this.paneList = structuredClone([...(options.panes ?? [])]);
    this.focus = structuredClone(options.focused ?? null);
    this.machineList = structuredClone([...(options.machines ?? [{ name: null, layout: "ready" as const }])]);
    this.terminalList = structuredClone([...(options.terminals ?? [])]);
    this.hcGetFn = options.hcGet;
    this.enabled = options.enabled ?? true;
    this.state = structuredClone(options.syntheticState ?? { terminals: [], agents: [] });
  }
  setSpaces(spaces: readonly HerdrFixtureSpace[]): void { this.spaceList = structuredClone([...spaces]); }
  setPanes(panes: readonly HerdrFixturePane[]): void { this.paneList = structuredClone([...panes]); }
  setFocused(focus: HerdrFixtureFocus | null): void { this.focus = structuredClone(focus); }
  setMachines(machines: readonly HerdrFixtureMachine[]): void { this.machineList = structuredClone([...machines]); }
  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  /** Terminals and agents are Herdr's and ahub's, independent of this mod being present. */
  snapshot(): { terminals: string[]; agents: string[] } { return structuredClone(this.state); }
  has(name: string): boolean { return this.enabled && this.offered.has(name); }
  hasCommand(name: string): boolean { return this.enabled && this.commands.has(name); }
  private need(name: HerdrFixtureFunction): void { if (!this.enabled) fail("disabled"); if (!this.offered.has(name)) fail("unknown_function"); }
  spaces(): HerdrFixtureSpace[] { this.need("spaces"); return structuredClone(this.spaceList); }
  panes(): HerdrFixturePane[] { this.need("panes"); return structuredClone(this.paneList); }
  focused(): HerdrFixtureFocus | null { this.need("focused"); return structuredClone(this.focus); }
  machines(): HerdrFixtureMachine[] { this.need("machines"); return structuredClone(this.machineList); }
  terminals(): HerdrFixtureTerminal[] { this.need("terminals"); return structuredClone(this.terminalList); }
  setTerminals(terminals: readonly HerdrFixtureTerminal[]): void { this.terminalList = structuredClone([...terminals]); }
  setHcGet(hcGet: HerdrFixtureHcGet | undefined): void { this.hcGetFn = hcGet; }
  private hcGetFn: HerdrFixtureHcGet | undefined;
  /**
   * `hc(args)` runs herdr-core's CLI. Fixture strictness: ONLY `get <address> --json` is accepted. Every other hc command (send, keys, kill, run, label, ...) is refused as unsupported, so a test
   * that passes proves the companion never reached for one. An address with a `/` is a remote terminal, which the fixture refuses because remote `hc get` was not observed.
   */
  async hc(args: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
    this.need("hc");
    if (!Array.isArray(args) || !args.every(a => typeof a === "string")) return fail("invalid_params");
    this.hcCalls.push([...(args as string[])]);
    if (args.length !== 3 || args[0] !== "get" || args[2] !== "--json" || !/^t[0-9a-z]{1,10}$/.test(args[1]!)) return fail("hc_unsupported");
    const answer = this.hcGetFn ? this.hcGetFn(args[1]!) : { code: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found", message: `no terminal "${args[1]}"` } }) };
    if (answer === "reject") return fail("hc_cannot_start");
    return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr ?? "" };
  }
  /** A space's machine layout is "ready" only when this reports it; an unknown machine is not a ready one. */
  async exec(command: unknown, args?: unknown, options?: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
    this.need("exec");
    if (typeof command !== "string" || !command) return fail("invalid_params");
    if (args !== undefined && (!Array.isArray(args) || !args.every(a => typeof a === "string"))) return fail("invalid_params");
    let cwd: string | undefined, on: string | null | undefined;
    if (options !== undefined) {
      if (!options || typeof options !== "object" || Array.isArray(options)) return fail("invalid_params");
      const bag = options as Record<string, unknown>;
      if (Object.keys(bag).some(key => key !== "cwd" && key !== "on")) return fail("invalid_params");
      if (bag.cwd !== undefined && (typeof bag.cwd !== "string" || !bag.cwd)) return fail("invalid_params");
      // Fixture strictness: an empty machine name is refused here; the host does not say what it means for `exec`.
      if (bag.on !== undefined && bag.on !== null && (typeof bag.on !== "string" || !bag.on)) return fail("invalid_params");
      cwd = bag.cwd as string | undefined; on = bag.on as string | null | undefined;
    }
    if (typeof on === "string" && !this.machineList.some(m => m.name === on)) return fail("exec_machine_unreachable");
    const call: HerdrFixtureExecCall = { command, args: [...((args as string[] | undefined) ?? [])], cwd, on, timeoutMs: HERDR_EXEC_TIMEOUT_MS, maxOutputBytes: HERDR_EXEC_MAX_OUTPUT_BYTES };
    this.execCalls.push({ ...call, args: [...call.args] });
    const result = await this.options.cli(call);
    // Fail closed: the host does not document how a timeout or an oversized output reaches a mod, so the fixture rejects both.
    if (result.timedOut) return fail("exec_timeout");
    if (result.truncated) return fail("exec_output_too_large");
    if (result.exitCode === null) return fail("exec_cannot_start");
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }
  /** `run` returns null and never reports success: the caller re-reads `focused()` or `terminals()` to learn what happened. */
  run(name: unknown, args?: unknown): null {
    this.need("run");
    if (typeof name !== "string" || !Object.hasOwn(HERDR_FIXTURE_COMMANDS, name) || !this.commands.has(name)) return fail("unknown_command");
    const spec = HERDR_FIXTURE_COMMANDS[name]!;
    const given = args === undefined ? {} : args;
    if (!given || typeof given !== "object" || Array.isArray(given)) return fail("invalid_params");
    const bag: Record<string, unknown> = Object.fromEntries(Object.entries(given as Record<string, unknown>).filter(([, v]) => v !== null));
    const names = spec.map(a => a.replace("*", ""));
    for (const key of Object.keys(bag)) if (!names.includes(key)) return fail("unknown_argument");
    for (const required of spec.filter(a => a.endsWith("*"))) if (!(required.slice(0, -1) in bag)) return fail("missing_argument");
    for (const key of Object.keys(bag)) if (ID_ARGS.has(key) && typeof bag[key] !== "string") return fail("invalid_params");
    // A layout terminal block holds focus: implicit pane actions and right/down places fail, as the host's AGENTS.md says.
    const blockFocused = this.focus !== null && this.focus.pane === null;
    if (name === "pane.split" && !("pane" in bag) && blockFocused) return fail("no_pane_target");
    if (name === "terminal.open" && (bag.place === "right" || bag.place === "down") && blockFocused) return fail("no_pane_target");
    this.runs.push({ name, args: structuredClone(bag) });
    if (name === "pane.focus" && typeof bag.terminal === "string") {
      // Worst case, deliberately: a stale or unknown address is a silent no-op, so a companion that does not re-read `focused()` would claim a focus that did not happen.
      const known = this.terminalList.some(t => t.address === bag.terminal);
      if (known && this.focus) this.focus = { ...this.focus, terminal: bag.terminal };
    }
    return null;
  }
  commands_(): { name: string; args: { name: string; required: boolean }[] }[] {
    this.need("commands");
    return [...this.commands].map(name => ({ name, args: HERDR_FIXTURE_COMMANDS[name]!.map(a => ({ name: a.replace("*", ""), required: a.endsWith("*") })) }));
  }
}
