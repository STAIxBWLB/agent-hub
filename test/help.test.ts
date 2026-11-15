import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, assertNativeCapabilityScope } from "../src/adapters/registry.ts";
import { EXAMPLES, FLAG_DESCRIPTIONS, FLAG_LINE, HELP, INTERNAL_COMMANDS, flagDescription, helpCommands, helpFlags, helpOverviewRows, listsSubcommand, renderHelp } from "../src/cli/help.ts";
import { ROLE_SGR } from "../src/cli/output-standard.ts";
import { initialConsoleState, paint, PALETTE, renderConsole, wrap } from "../src/cli/console-state.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

const SGR = /\x1b\[[0-9;]*m/g;
/** The long text the overview used to be: every usage form with its whole description, as `ahub help <command>` still prints it. */
const renderHelpFull = (columns: number) => [...new Set(HELP.flatMap(helpCommands))].flatMap(command => renderHelp(columns, false, command).split("\n"));
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "NO_COLOR"];
const root = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-help-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
/** The CLI as a person runs it: no agent markers, a hub home of its own; stdout is a pipe unless `tty` (then 120 columns). */
async function cli(args: string[], env: Record<string, string> = {}, tty = false) {
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify({ TERM: "xterm-256color", ...env, AGENTHUB_HOME: join(root, "home") })});
${tty ? `Object.defineProperty(process.stdout, "isTTY", { value: true }); Object.defineProperty(process.stdout, "columns", { value: 120 });` : ""}
process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(CLI)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

describe("ahub help (#212)", () => {
  test("#437 help lists task cancellation, an agent's own task only (#933), and its complete syntax", () => {
    const usage = "ahub task cancel <id> --reason <text> [--superseded-by <ref>] [--revision N] [--json] [--color=auto|always|never]";
    const entry = HELP.find(entry => entry.usage === usage);
    expect(entry?.section).toBe("Tasks and review");
    expect(entry?.description).toContain("an agent on its own task as hub_task_cancel allows");
    expect(renderHelp(80, false, "task").replace(/\s+/g, " ")).toContain(usage);
  });

  test("every command in the dispatch table has a help entry", () => {
    // ponytail: the keys are read from main.ts's source (the commands literal, keys at two spaces); export the
    // command names instead once main.ts is importable without running the CLI.
    const src = readFileSync(CLI, "utf8");
    const at = src.indexOf("const commands: Record<");
    const keys = [...src.slice(at, src.indexOf("\n};\n", at)).matchAll(/^  (?:"([^"]+)"|([\w-]+)): /gm)].map(m => m[1] ?? m[2]!);
    expect(keys.length).toBeGreaterThan(40);
    const documented = new Set(HELP.flatMap(helpCommands));
    expect(keys.filter(key => !documented.has(key))).toEqual([]);
    expect(helpCommands({ section: "", usage: "ahub pause|resume <peer>", description: "" })).toEqual(["pause", "resume"]);
    expect(helpCommands({ section: "", usage: "ahub version | --version", description: "" })).toEqual(["version", "--version"]);
  });

  for (const columns of [80, 120]) test(`at ${columns} columns: the overview lists every command once per group as a name and a one-line summary, in two aligned columns (#1484 AC4)`, () => {
    const lines = renderHelp(columns, false).split("\n");
    for (const line of lines) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(80); // the standard: within 80 columns, whatever the terminal width
    expect(lines.filter(line => line.startsWith("▸ ")).map(line => line.slice(2))).toEqual(["Projects", "Daemon and runtime", "Agents", "Messages and approvals", "Tasks and review", "Budget", "History and reports", "Hooks", "Dashboard", "More"]);
    // One summary column: every row is two spaces, a name, two or more spaces and a summary that starts at the same cell.
    const more = lines.indexOf("▸ More"); // the closing note is prose, not a command row
    const rows = lines.slice(0, more).filter(line => /^ {2}\S/.test(line));
    const starts = rows.map(line => /^ {2}\S+ {2,}(?=\S)/.exec(line)?.[0].length);
    expect(starts.every(start => start !== undefined)).toBe(true);
    expect(new Set(starts).size).toBe(1);
    // A summary is one line of at most 56 cells: no row of the overview wraps, so the overview is one row per command.
    for (const row of rows) expect(Bun.stringWidth(row.slice(starts[0]!)), row).toBeLessThanOrEqual(56);
    expect(rows.length).toBe(helpOverviewRows().length);
    // The overview is short: about one line per command instead of one block per usage form.
    expect(lines.length).toBeLessThan(140);
    expect(lines.length).toBeLessThan(renderHelpFull(columns).length / 4);
  });

  test("every command, subcommand and flag still appears: each command is in the overview, and `ahub help <command>` carries every usage form and flag of the full text", () => {
    const overview = renderHelp(100, false);
    const commands = new Set(HELP.flatMap(helpCommands));
    // a command is its own row, or one half of a row that names alternatives (`version|--version`, `pause|resume`)
    const names = overview.split("\n").filter(line => /^ {2}\S/.test(line)).flatMap(line => line.trim().split(/\s+/)[0]!.split("|"));
    for (const command of commands) expect(names, command).toContain(command);
    // `ahub help <command>` is the full text: every entry that names the command, usage and description, unchanged.
    for (const command of commands) {
      const detail = renderHelp(100, false, command).replace(/\s+/g, " ");
      for (const entry of HELP.filter(entry => helpCommands(entry).includes(command))) {
        expect(detail, `${command}: ${entry.usage}`).toContain(entry.usage.replace(/\s+/g, " "));
        for (const word of entry.description.split(/\s+/).filter(Boolean)) expect(detail, `${command}: ${word}`).toContain(word);
      }
    }
    // #1504: every flag a command's usages name is in the text `ahub help <command>` renders for that command. This reads the rendered text; the old check compared HELP with itself and could not fail.
    let checked = 0;
    for (const command of commands) {
      const rendered = renderHelp(100, false, command);
      for (const entry of HELP.filter(entry => helpCommands(entry).includes(command))) {
        for (const flag of entry.usage.match(/--[a-z][a-z0-9-]*/g) ?? []) { expect(rendered, `${command} ${flag}`).toContain(flag); checked++; }
      }
    }
    expect(checked).toBeGreaterThan(300);
    // and the check can fail: a rendering that drops a flag is caught
    expect(renderHelp(100, false, "kill")).not.toContain("--json");
  });

  test("#1504 AC1: every section title of the overview, the first included, follows one blank line", () => {
    const lines = renderHelp(80, false).split("\n");
    const titles = lines.flatMap((line, index) => line.startsWith("▸ ") ? [index] : []);
    expect(titles.length).toBeGreaterThan(5);
    for (const index of titles) expect(lines[index - 1], lines[index]).toBe("");
    expect(lines[titles[0]! - 2]).toStartWith("Usage: ahub");
    for (let index = 1; index < lines.length; index++) if (lines[index] === "") expect(lines[index - 1], `no double blank at ${index}`).not.toBe("");
  });

  test("#1504 AC2: every native agent row says what the command does, from its adapter definition", () => {
    const agents = helpOverviewRows().filter(row => row.section === "Agents");
    const natives = ["claude", "codex", "kimi", "jcode", "agy", "qwen", "pi", "local"];
    for (const name of natives) {
      const row = agents.find(row => row.name === name);
      expect(row, name).toBeDefined();
      expect(row!.summary.split(/\s+/).length, `${name}: ${row!.summary}`).toBeGreaterThanOrEqual(3);
      expect(Bun.stringWidth(row!.summary)).toBeLessThanOrEqual(56);
    }
    // the words come from the definition, not from a peer-keyed table in help.ts
    for (const definition of ADAPTERS.filter(definition => definition.cli.usage?.length)) expect(agents.find(row => row.name === definition.kind)?.summary, definition.kind).toBe(definition.cli.usage![0]![2]);
    expect(readFileSync(join(import.meta.dir, "../src/cli/help.ts"), "utf8")).not.toMatch(/\b(?:jcode|pi|qwen|agy|local|kimi):\s*"/);
  });

  test("the overview names where the long text lives and has no hidden command", () => {
    const overview = renderHelp(80, false);
    expect(overview).toContain("Details: ahub help <command>");
    expect(overview).toContain("ahub help <command> shows every usage form and flag of one command");
    // a command whose usage is documented only in the long text still has a row
    for (const command of ["pause|resume", "version|--version", "check-path"]) expect(overview, command).toContain(`  ${command}`);
    expect(overview).not.toMatch(/--json|--color=/); // flags belong to `ahub help <command>`
  });

  /** The commands a person types that take an argument, a flag or a subcommand: `ahub version | --version` is two spellings, not arguments. */
  const takesArguments = (command: string) => HELP.some(entry => helpCommands(entry).includes(command) && /[<\[|]|\.\.\./.test(entry.usage.replace(/^ahub \S+/, "")) && !/^ahub (?:version \| --version|--version)$/.test(entry.usage));
  const sectionsOf = (text: string) => text.split("\n").filter(line => line.startsWith("▸ ")).map(line => line.slice(2).replace(/ \(\d+\)$/, ""));

  test("#1504 AC3: `ahub help <command>` shows usage, a short description, flags one per line, examples, then the long text, within the width", () => {
    for (const command of new Set(HELP.flatMap(helpCommands))) for (const columns of [80, 100]) {
      const text = renderHelp(columns, false, command);
      const sections = sectionsOf(text);
      // in order, each present only when it has content
      expect(sections[0], command).toBe("Usage");
      expect(sections.at(-1), command).toBe("Details");
      const order = ["Usage", "Description", "Flags", "Examples", "Details"];
      expect(sections.map(name => order.indexOf(name)), `${command}: ${sections}`).toEqual([...sections.map(name => order.indexOf(name))].sort((a, b) => a - b));
      expect(sections.every(name => order.includes(name)), `${command}: ${sections}`).toBe(true);
      for (const line of text.split("\n")) expect(Bun.stringWidth(line), `${command}: ${line}`).toBeLessThanOrEqual(columns);
      if (takesArguments(command) && !INTERNAL_COMMANDS.includes(command)) expect(sections, `${command} has no example`).toContain("Examples");
      if (helpFlags(command).length) expect(sections, `${command} lists no flags`).toContain("Flags");
      // flags are one per line: a flag appears once in the Flags section
      const block = text.split("\n").slice(text.split("\n").findIndex(line => line.startsWith("▸ Flags")) + 1);
      if (sections.includes("Flags")) {
        const rows = block.slice(0, block.findIndex(line => line.startsWith("▸ ")) - 1).filter(line => /^ {2}-/.test(line));
        expect(rows.length, command).toBe(helpFlags(command).length);
      }
    }
    expect(renderHelp(80, false, "nosuchcommand")).toBe("");
  });

  test("#1504: a flag after a `|` in a form is attributed to the form the entry's first piece named (task handoff --list | --sync | --project ...)", () => {
    const flags = new Map(helpFlags("task").map(item => [item.flag, item.forms]));
    for (const flag of ["--list", "--sync", "--project", "--issue", "--task", "--duplicate-ok", "--key"]) expect(flags.get(flag), flag).toContain("handoff");
    // a flag that two forms take names both, and a flag of another form is not pulled in
    expect(flags.get("--path")).toEqual(["propose", "handoff"]);
    expect(flags.get("--urgent")).toEqual(["propose"]);
    const rendered = renderHelp(80, false, "task").replace(/\s+/g, " ");
    // #1504 AC3: the Flags line says what the flag is for; the forms stay on the Usage lines and in helpFlags
    expect(rendered).toMatch(/--sync sync handoff states from the targets/);
    expect(rendered).toMatch(/--key <uuid> idempotency key \(a UUID\) for the handoff/);
  });

  test("#1504: a native agent's summary rides cli.usage, so a non-builtin definition cannot supply one", () => {
    for (const definition of ADAPTERS.filter(definition => definition.cli.usage?.length)) expect(definition.cli.usage![0]![2], definition.kind).toBeTruthy();
    // The generic fixture of test/adapter-capability-scope.test.ts: qwen's metadata without any fixed-builtin capability, so `cli.usage` is the only restricted field present.
    const { projection: _projection, settle: _settle, modelOverride: _modelOverride, cli, ...base } = ADAPTERS.find(definition => definition.kind === "qwen")!;
    const { entry: _entry, preview: _preview, usage: _usage, ...genericCli } = cli;
    const { createTui: _createTui, upStart: _upStart, ...start } = base.start;
    const external = { ...base, cli: genericCli, kind: "fixture", family: "fixture", start: { ...start }, session: { idField: base.session.idField, currentId: base.session.currentId } };
    expect(() => assertNativeCapabilityScope(external)).not.toThrow();
    expect(() => assertNativeCapabilityScope({ ...external, cli: { ...genericCli, usage: [["ahub fixture", "x", "a summary"]] } })).toThrow("cli.usage is restricted to fixed builtin adapter definitions");
  });

  test("#1504 AC3: the flag count in the heading and the --json and --color meanings come from one place", () => {
    const status = renderHelp(80, false, "status");
    expect(status).toMatch(/▸ Flags \(\d+\)/);
    expect(status).toContain("--json");
    expect(status.replace(/\s+/g, " ")).toContain("one JSON document on stdout, never colored");
    expect(status.replace(/\s+/g, " ")).toContain("auto, always or never; auto follows NO_COLOR, FORCE_COLOR and the terminal");
  });

  test("#1504 AC3: every flag line of every command carries a description, one line of at most FLAG_LINE cells, and none is the old `in <forms>` fallback", () => {
    let lines = 0;
    for (const command of new Set(HELP.flatMap(helpCommands))) {
      for (const item of helpFlags(command)) {
        lines++;
        const text = flagDescription(command, item.flag);
        expect(text, `${command} ${item.flag} has no description`).toBeTruthy();
        expect(text!.trim(), `${command} ${item.flag}`).toBe(text!);
        if (item.flag !== "--json" && item.flag !== "--color") expect(Bun.stringWidth(text!), `${command} ${item.flag}: ${text}`).toBeLessThanOrEqual(FLAG_LINE);
      }
      // the rendered line: the flag's own text follows its label, not a list of forms
      for (const columns of [80, 100]) {
        const text = renderHelp(columns, false, command).split("\n");
        const start = text.findIndex(line => line.startsWith("▸ Flags"));
        if (start < 0) continue;
        const block = text.slice(start + 1, text.findIndex((line, index) => index > start && line.startsWith("▸ ")));
        for (const item of helpFlags(command)) {
          const label = item.shape ? `${item.flag}${item.joiner}${item.shape}` : item.flag;
          const row = block.findIndex(line => line.startsWith(`  ${label}`));
          expect(row, `${command} ${label}`).toBeGreaterThanOrEqual(0);
          const own = (block[row]!.slice(2 + label.length) + " " + (block.slice(row + 1).find(line => /^ {3,}\S/.test(line)) ?? "")).replace(/\s+/g, " ");
          expect(own, `${command} ${label}`).toContain(flagDescription(command, item.flag)!.split(" ")[0]!);
        }
      }
    }
    expect(lines).toBeGreaterThan(300);
  });

  test("#1504 AC3: a flag's description is looked up by command first, so `--all` says what it does for each command", () => {
    expect(flagDescription("status", "--all")).toBe("every registered project");
    expect(flagDescription("learn", "--all")).toBe("include decided candidates");
    expect(flagDescription("queue", "--all")).toBe("include rows already settled");
    expect(flagDescription("nosuchcommand", "--all")).toBe(FLAG_DESCRIPTIONS["--all"]);
    expect(flagDescription("status", "--nosuchflag")).toBeUndefined();
    // the line a person reads under `ahub help learn`
    expect(renderHelp(80, false, "learn").replace(/\s+/g, " ")).toContain("--all include decided candidates");
    // a table entry names a flag some command takes: a stale entry would describe nothing
    const used = new Set(HELP.flatMap(entry => helpCommands(entry).flatMap(command => helpFlags(command).map(item => [command, item.flag] as const))).flatMap(([command, flag]) => [flag, `${command} ${flag}`]));
    for (const key of Object.keys(FLAG_DESCRIPTIONS)) expect(used.has(key), `${key} describes no flag of any command`).toBe(true);
  });

  test("#1504 AC4: everything `ahub help <command>` printed before still appears, form by form, flag by flag and word by word", () => {
    let forms = 0, words = 0;
    for (const command of new Set(HELP.flatMap(helpCommands))) {
      const text = renderHelp(100, false, command).replace(/\s+/g, " ");
      for (const entry of HELP.filter(entry => helpCommands(entry).includes(command))) {
        forms++;
        expect(text, `${command}: ${entry.usage}`).toContain(entry.usage.replace(/\s+/g, " "));
        for (const flag of entry.usage.match(/--[a-z][a-z0-9-]*/g) ?? []) expect(text, `${command} ${flag}`).toContain(flag);
        for (const word of entry.description.split(/\s+/).filter(Boolean)) { words++; expect(text, `${command}: ${word}`).toContain(word); }
      }
    }
    expect(forms).toBeGreaterThan(150);
    expect(words).toBeGreaterThan(4000); // measured 4802 on 2026-11-14; a floor that proves the loop is not empty
  });

  test("#1504 AC5: every example is a command that exists, a subcommand and flags its own usage lists", () => {
    const dispatch = (() => {
      const src = readFileSync(CLI, "utf8");
      const at = src.indexOf("const commands: Record<");
      return new Set([...src.slice(at, src.indexOf("\n};\n", at)).matchAll(/^  (?:"([^"]+)"|([\w-]+)): /gm)].map(m => m[1] ?? m[2]!));
    })();
    const commandWords = new Set(HELP.flatMap(helpCommands));
    let checked = 0, subChecked = 0;
    for (const [command, examples] of Object.entries(EXAMPLES)) {
      expect(commandWords.has(command), `${command} has no help entry`).toBe(true);
      for (const example of examples) {
        checked++;
        const words = example.match(/"[^"]*"|\S+/g)!;
        expect(words[0], example).toBe("ahub");
        // the command word is in the dispatch table
        const first = words[1] === "--project" || words[1] === "--live-test" ? words[1] : words[1]!;
        expect(dispatch.has(first) || ["--project", "--live-test"].includes(first), `${example}: ${first} is not a command`).toBe(true);
        expect(first === command || helpCommands({ section: "", usage: `ahub ${command}`, description: "" }).includes(first), `${example} is filed under ${command}`).toBe(true);
        // every flag is in a usage of that command
        const usages = HELP.filter(entry => helpCommands(entry).includes(command)).map(entry => entry.usage).join(" ");
        for (const word of words.slice(2).filter(word => /^-{1,2}[a-z]/.test(word))) expect(usages, `${example}: ${word} is not in the usage`).toContain(word);
        // Derived from the usage, not from a list: when every form of the command starts with a bare word (`task show`, `sdlc status`, `completion zsh`), the example's first word must be one the usage lists
        // (`listsSubcommand`, the check `ahub <command> <sub> --help` relies on). A command whose forms start with an argument or an option (`say`, `board`, `usage`) has no required subcommand.
        const sub = words[2];
        const forms = HELP.filter(entry => helpCommands(entry).includes(command)).map(entry => entry.usage.replace(/^ahub \S+\s*/, "").trim());
        const strict = !command.startsWith("--") && forms.length > 0 && forms.every(form => /^[a-z][a-z-]*(?:\|[a-z][a-z-]*)*(?:\s|$)/.test(form));
        if (strict && sub) { subChecked++; expect(listsSubcommand(command, sub), `${example}: ${sub} is not a subcommand of ${command}`).toBe(true); }
      }
    }
    expect(checked).toBeGreaterThan(70);
    expect(subChecked).toBeGreaterThan(15);
    expect(listsSubcommand("task", "nosuchsub")).toBe(false); // the check can fail
    // the check can fail: an example naming a command or flag that does not exist is caught
    expect(dispatch.has("nosuchcommand")).toBe(false);
  });

  test("#1504 AC5: a native agent's example comes from its definition's own usage", () => {
    for (const definition of ADAPTERS.filter(definition => definition.cli.usage?.length)) {
      const text = renderHelp(100, false, definition.kind);
      const usage = definition.cli.usage![0]![0];
      expect(text, definition.kind).toContain(usage.includes("--print-command") ? `ahub ${definition.kind} --print-command` : `ahub ${definition.kind}\n`);
    }
    expect(Object.keys(EXAMPLES).filter(key => ADAPTERS.some(definition => definition.kind === key))).toEqual([]);
  });

  test("with ASCII markers the overview has no non-ASCII glyph", () => {
    const text = renderHelp(80, false, undefined, undefined, true);
    expect(text).toContain("> Projects");
    expect(text).not.toMatch(/[▸✓✗⚠→]/);
  });

  test("help, --help and -h print it all; help <command> filters; an unknown command gets a one-line hint", async () => {
    const full = await cli(["help"]);
    expect(full).toEqual({ code: 0, stdout: `${renderHelp(80, false)}\n`, stderr: "" });
    for (const args of [["--help"], ["-h"], [], ["help", "--help"], ["help", "-h"], ["-h", "--help"]]) expect(await cli(args)).toEqual(full);
    expect(await cli(["help", "pause"])).toEqual({ code: 0, stdout: `${renderHelp(80, false, "pause")}\n`, stderr: "" });
    // An unknown command is a usage error: exit 2 (CLI output standard v1).
    expect(await cli(["bogus"])).toEqual({ code: 2, stdout: "", stderr: 'ahub: unknown command "bogus"; run ahub help\n' });
    expect(await cli(["help", "bogus"])).toEqual({ code: 2, stdout: "", stderr: 'ahub: unknown command "bogus"; run ahub help\n' });
  }, 20_000);

  test("ahub <command> -h prints that command's help instead of running it: kill stays alive, say sends nothing", async () => {
    for (const [command, flag] of [["stop", "--help"], ["kill", "--help"], ["say", "-h"], ["remember", "-h"], ["up", "--help"]]) {
      expect(await cli([command!, flag!])).toEqual({ code: 0, stdout: `${renderHelp(80, false, command)}\n`, stderr: "" });
    }
    // Inside other arguments it is text: say goes on to send it (here it fails for want of a hub, not with help).
    const said = await cli(["say", "@codex", "try", "ls", "-h", "first"]);
    expect(said.code).not.toBe(0);
    expect(said.stdout).toBe("");
  }, 20_000);

  test("color only on a terminal whose TERM is not dumb and NO_COLOR is empty", async () => {
    const plain = `${renderHelp(120, false)}\n`;
    const tty = await cli(["help"], {}, true);
    expect(tty.stdout).toContain(ROLE_SGR.section);
    expect(tty.stdout.replace(SGR, "")).toBe(plain);
    expect((await cli(["help"], { NO_COLOR: "" }, true)).stdout).toBe(tty.stdout);
    for (const env of [{ TERM: "dumb" }, { NO_COLOR: "1" }] as Record<string, string>[]) expect((await cli(["help"], env, true)).stdout).toBe(plain);
    expect((await cli(["help"])).stdout).not.toContain("\x1b");
  }, 20_000);
});

/** The console stream's lines for one pushed message, as painted for a terminal of this width. */
async function streamed(columns: number, msg: any): Promise<string[]> {
  const output: string[] = []; let signal = () => {};
  const terminal: ConsoleTerminal = { columns, rows: 24, isTTY: true, write: text => { output.push(text); }, raw: () => {},
    onData: () => () => {}, onResize: () => () => {}, onSignal: listener => { signal = listener; return () => {}; }, onError: () => () => {} };
  const client = { onPush: (_msg: any) => {}, onClose: (_code: number, _reason: string) => {}, send: () => {}, close: () => {},
    request: async () => ({ ok: true, status: { peers: {} }, budget: {}, text: "[]", deliveries: [] }) };
  const running = runConsole({ client, cwd: "/tmp", stateDir: "/tmp", terminal, color: false });
  client.onPush(msg);
  signal(); await running;
  const lines: string[] = [];
  for (let i = output.indexOf("\x1b[20;1H") + 1; output[i + 1] === "\r\n"; i += 2) lines.push(output[i]!);
  return lines;
}

describe("wrap breaks at word boundaries (#212, #213)", () => {
  test("whitespace breaks are dropped; continuations hang deeper than their source line", () => {
    expect(wrap("enter the human console", 10, 0)).toEqual(["enter the", "human", "console"]);
    expect(wrap("    one two three", 10, 0)).toEqual(["    one", "    two", "    three"]);
    expect(wrap("  one two three four", 16)).toEqual(["  one two three", "      four"]);
    expect(wrap("  * notice\nnext", 80)).toEqual(["  * notice", "next"]);
    expect(wrap("abc   ", 4)).toEqual(["abc"]);
    expect(wrap("   \n", 10)).toEqual(["", ""]);
  });
  test("an indent is at most half the line, so it never fills a line of its own", () => {
    expect(wrap("          abc", 10)).toEqual(["     abc"]);
    expect(wrap("        abcdefghij", 10)).toEqual(["     abcde", "     fghij"]); // longer than the 5 columns left
    expect(wrap(`    a${"\t".repeat(40)}b`, 20)).toEqual(["    a", "        b"]); // a tab is one space, not a jump to a tab stop
  });
  test("only a word longer than a whole line is split", () => {
    expect(wrap("see /very/long/path/name now", 8, 0)).toEqual(["see", "/very/lo", "ng/path/", "name now"]);
    expect(wrap("가나다라마바 끝", 10, 0)).toEqual(["가나다라마", "바 끝"]);
  });
  test("a Korean title wraps by display width at its spaces", () => {
    expect(wrap("한국어 승인 내용 확인", 10, 0)).toEqual(["한국어", "승인 내용", "확인"]);
    for (const line of wrap("한국어 승인 내용 확인", 10)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(10);
  });
  test("widths hold after painting: a line that starts like a hub header is measured with its > marker", () => {
    const header = wrap(`${"a".repeat(19)} [agent-hub ${"b".repeat(8)}`, 20, 0);
    const from = wrap(`${"a".repeat(19)} --- from user: hiya`, 20, 0);
    expect(header).toEqual(["a".repeat(19), "> [agent-hub", "b".repeat(8)]);
    expect(from).toEqual(["a".repeat(19), "> --- from user:", "hiya"]);
    for (const line of [...header, ...from]) expect(paint([{ text: line }], false)).toBe(line);
  });
  for (const columns of [80, 120, 200]) test(`wrapped peer text cannot start a stream line where the hub does, at ${columns} columns`, async () => {
    const permission = { t: "permission", id: "p1", peer: "pi", title: `${"x".repeat(columns - 25)} ? codex asks permission: git push --force origin main`, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], expiresAt: Date.now() + 60_000 };
    const cases: [any, string][] = [
      [{ t: "event", e: { t: "envelope", env: newEnvelope("pi", `done${" ".repeat(300)}4:00:00 PM user -> claude ! approve the deploy now`) } }, `${" ".repeat(8)}4:00:00 PM user -> claude ! approve the deploy now`],
      [permission, `${" ".repeat(6)}? codex asks permission: git push --force origin main`],
      [{ t: "notice", line: `${"y".repeat(columns - 5)} * codex finished task #4; merge approved` }, `${" ".repeat(6)}* codex finished task #4; merge approved`],
      [{ t: "event", e: { t: "envelope", env: newEnvelope("pi", `${"y".repeat(columns - 6)} [agent-hub ${"z".repeat(columns - 19)}`) } }, `>${" ".repeat(9)}[agent-hub`],
    ];
    for (const [msg, forged] of cases) {
      const lines = await streamed(columns, msg);
      expect(lines).toContain(forged);
      // Only the hub's own first line starts at column 0 or 2; a sanitized line starts with its > marker.
      expect(lines.filter(line => /^(?: {2})?[^\s>]/.test(line))).toEqual([lines[0]!]);
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
    }
  });
  test("the console key table keeps each key whole; details and approval titles read as whole words", () => {
    const s = initialConsoleState(true);
    s.help = true;
    const keys = renderConsole(s, 80, 24, 0).slice(2, -4).filter(Boolean);
    for (const item of ["Tab stream/panels", "j/k or Up/Down move", "a allow (then y)", "r resolve (reason, then y)", "g kind filter"]) expect(keys.some(line => line.includes(item))).toBe(true);
    s.help = false;
    const title = "pi bash: 한국어 승인 요청 내용을 확인합니다, then run bun test test/help.test.ts in the project ".repeat(4).trim();
    for (const value of [title, "x".repeat(150)]) {
      s.detail = { title: value };
      const detail = renderConsole(s, 80, 24, 0).slice(2, -4).filter(Boolean);
      expect(detail.length).toBeGreaterThan(1);
      for (const line of detail) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
      expect(detail.slice(1).every(line => line.startsWith(" ".repeat(7)))).toBe(true);
      expect(detail.map(line => line.replace(/^title/, "").trim()).join(value === title ? " " : "")).toBe(value);
    }
    s.detail = undefined; s.panel = 2;
    s.approvals = [{ id: "p1", peer: "pi", title, expiresAt: 60_000, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }]; s.approvalId = "p1";
    const panel = renderConsole(s, 80, 24, 0);
    const lines = panel.slice(panel.findIndex(line => line.startsWith("title ")), panel.findIndex(line => line.startsWith("a allow ")));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map(line => line.replace(/^title/, "").trim()).join(" ")).toBe(title);
  });
});

test("every builtin agent launcher appears in the Agents help section (#564)", async () => {
  const { BUILTIN_CLI_ENTRIES: builtinCliEntries } = await import("../src/adapters/registry.ts");
  const agents = HELP.filter(entry => entry.section === "Agents").map(entry => entry.usage);
  for (const { command } of builtinCliEntries) expect(agents.some(usage => usage === `ahub ${command}` || usage.startsWith(`ahub ${command} `))).toBe(true);
});
