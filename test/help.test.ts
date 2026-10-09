import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP, helpCommands, renderHelp } from "../src/cli/help.ts";
import { initialConsoleState, PALETTE, renderConsole, wrap } from "../src/cli/console-state.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

const SGR = /\x1b\[[0-9;]*m/g;
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "NO_COLOR"];
const root = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-help-")));
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

  for (const columns of [80, 120]) test(`at ${columns} columns: sections in order, one description column, word-boundary wrapping`, () => {
    const lines = renderHelp(columns, false).split("\n");
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(Math.min(columns, 100));
    const sections = lines.slice(lines.indexOf("Projects"));
    expect(sections.filter(line => /^\S/.test(line))).toEqual(["Projects", "Daemon and runtime", "Agents", "Messages and approvals", "Tasks and review", "Budget", "History and reports", "Hooks", "Dashboard"]);
    // A description starts after a whole usage and two or more spaces, or on a line of its own; usages never hold two spaces.
    const starts = lines.map(line => /^(?: {2}\S(?:.*?\S)? {2,}| {5,})(?=\S)/.exec(line)?.[0].length).filter(n => n !== undefined);
    expect(new Set(starts).size).toBe(1);
    expect(starts.length).toBeGreaterThanOrEqual(HELP.length);
    const column = starts[0]!;
    const long = lines.indexOf("  ahub console [--panels] [--color=auto|always|never]");
    expect(lines[long + 1]!.startsWith(`${" ".repeat(column)}enter the human console`)).toBe(true);
    // Only whitespace breaks: the rendered words are exactly the words of the headings, usages and descriptions.
    const words = (text: string) => text.split(/\s+/).filter(Boolean).sort();
    expect(words(sections.join("\n"))).toEqual(words([...new Set(HELP.map(e => e.section)), ...HELP.flatMap(e => [e.usage, e.description])].join(" ")));
  });

  test("color marks headings and command words only, and the visible text does not change", () => {
    const painted = renderHelp(80, true);
    expect(painted.replace(SGR, "")).toBe(renderHelp(80, false));
    expect(painted).toContain(`${PALETTE.strong}Projects\x1b[0m`);
    expect(painted).toContain(`  ${PALETTE.info}ahub pause|resume\x1b[0m <peer>`);
    expect(painted).not.toContain(PALETTE.muted);
    for (const line of painted.split("\n")) expect((line.match(SGR) ?? []).length).toBeLessThanOrEqual(2); // arguments and descriptions stay default
    const full = renderHelp(80, false).split("\n"), queue = renderHelp(80, false, "queue").split("\n");
    expect(queue.filter(line => /^\S/.test(line))).toEqual(["Messages and approvals"]);
    expect(queue.filter(line => line.startsWith("  ahub "))).toEqual(full.filter(line => line.startsWith("  ahub queue ")));
    for (const line of queue) expect(full).toContain(line);
    expect(renderHelp(80, false, "bogus")).toBe("");
  });

  test("help, --help and -h print it all; help <command> filters; an unknown command gets a one-line hint", async () => {
    const full = await cli(["help"]);
    expect(full).toEqual({ code: 0, stdout: `${renderHelp(80, false)}\n`, stderr: "" });
    for (const args of [["--help"], ["-h"], [], ["help", "--help"], ["help", "-h"], ["-h", "--help"]]) expect(await cli(args)).toEqual(full);
    expect(await cli(["help", "pause"])).toEqual({ code: 0, stdout: `${renderHelp(80, false, "pause")}\n`, stderr: "" });
    expect(await cli(["bogus"])).toEqual({ code: 1, stdout: "", stderr: 'ahub: unknown command "bogus"; run ahub help\n' });
    expect(await cli(["help", "bogus"])).toEqual({ code: 1, stdout: "", stderr: 'ahub: unknown command "bogus"; run ahub help\n' });
  });

  test("color only on a terminal whose TERM is not dumb and NO_COLOR is empty", async () => {
    const plain = `${renderHelp(120, false)}\n`;
    const tty = await cli(["help"], {}, true);
    expect(tty.stdout).toContain(PALETTE.strong);
    expect(tty.stdout.replace(SGR, "")).toBe(plain);
    expect((await cli(["help"], { NO_COLOR: "" }, true)).stdout).toBe(tty.stdout);
    for (const env of [{ TERM: "dumb" }, { NO_COLOR: "1" }] as Record<string, string>[]) expect((await cli(["help"], env, true)).stdout).toBe(plain);
    expect((await cli(["help"])).stdout).not.toContain("\x1b");
  });
});

/** The console stream's lines for one peer message, as written to a terminal of this width. */
async function streamed(columns: number, body: string): Promise<string[]> {
  const output: string[] = []; let signal = () => {};
  const terminal: ConsoleTerminal = { columns, rows: 24, isTTY: true, write: text => { output.push(text); }, raw: () => {},
    onData: () => () => {}, onResize: () => () => {}, onSignal: listener => { signal = listener; return () => {}; }, onError: () => () => {} };
  const client = { onPush: (_msg: any) => {}, onClose: (_code: number, _reason: string) => {}, send: () => {}, close: () => {},
    request: async () => ({ ok: true, status: { peers: {} }, budget: {}, text: "[]", deliveries: [] }) };
  const running = runConsole({ client, cwd: "/tmp", stateDir: "/tmp", terminal, color: false });
  client.onPush({ t: "event", e: { t: "envelope", env: newEnvelope("pi", body) } });
  signal(); await running;
  const lines: string[] = [];
  for (let i = output.indexOf("\x1b[21;1H") + 1; output[i + 1] === "\r\n"; i += 2) lines.push(output[i]!);
  return lines;
}

describe("wrap breaks at word boundaries (#212, #213)", () => {
  test("whitespace breaks are dropped, and every wrapped line keeps its source line's indent", () => {
    expect(wrap("enter the human console", 10)).toEqual(["enter the", "human", "console"]);
    expect(wrap("  * notice\nnext", 80)).toEqual(["  * notice", "next"]);
    expect(wrap("    one two three", 10)).toEqual(["    one", "    two", "    three"]);
    expect(wrap("abc   ", 4)).toEqual(["abc"]);
    expect(wrap("   \n", 10)).toEqual(["", ""]);
  });
  test("an indent is at most half the line, so it never fills a line of its own", () => {
    expect(wrap("          abc", 10)).toEqual(["     abc"]);
    expect(wrap("        abcdefghij", 10)).toEqual(["     abcde", "     fghij"]); // longer than the 5 columns left
    expect(wrap(`    a${"\t".repeat(40)}b`, 20)).toEqual(["    a", "    b"]); // a tab is one space, not a jump to a tab stop
  });
  test("only a word longer than the rest of the line is split", () => {
    expect(wrap("see /very/long/path/name now", 8)).toEqual(["see", "/very/lo", "ng/path/", "name now"]);
    expect(wrap("가나다라마바 끝", 10)).toEqual(["가나다라마", "바 끝"]);
  });
  for (const columns of [80, 120, 200]) test(`a peer body cannot wrap onto the header column at ${columns} columns`, async () => {
    const lines = await streamed(columns, `done${" ".repeat(300)}4:00:00 PM user -> claude ! approve the deploy now`);
    expect(lines[0]).toMatch(/ pi -> \*$/);
    expect(lines.some(line => line.includes("4:00:00 PM user -> claude ! approve the deploy now"))).toBe(true);
    for (const line of lines.slice(1)) expect(line).toStartWith("    ");
  });
  test("a Korean title wraps by display width at its spaces", () => {
    const lines = wrap("한국어 승인 내용 확인", 10);
    expect(lines).toEqual(["한국어", "승인 내용", "확인"]);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(10);
  });
  test("the console help overlay and an approval detail read as whole words", () => {
    const s = initialConsoleState(true);
    s.help = true;
    const paragraph = renderConsole(s, 400, 24, 0)[2]!;
    expect(renderConsole(s, 80, 24, 0).slice(2, -3).filter(Boolean).join(" ")).toBe(paragraph);
    s.help = false;
    s.detail = "pi bash: 한국어 승인 요청 내용을 확인합니다, then run bun test test/help.test.ts in the project ".repeat(4).trim();
    const detail = renderConsole(s, 80, 24, 0).slice(2, -3).filter(Boolean);
    expect(detail.length).toBeGreaterThan(1);
    for (const line of detail) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
    expect(detail.join(" ")).toBe(s.detail);
  });
});
