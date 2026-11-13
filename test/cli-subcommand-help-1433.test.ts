import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP, helpCommands, listsSubcommand, renderHelp, subcommandUsage } from "../src/cli/help.ts";
import { parseHandoffArgs } from "../src/cli/handoff-args.ts";
import { unknownOption, withoutSeparator } from "../src/cli/free-text.ts";

// #1433: `ahub task propose --help` filed a task titled "--help". A subcommand followed by -h/--help prints help; a write command refuses an option-like word before it writes.
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "NO_COLOR"];
const root = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-sub-help-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
/** The CLI as a person runs it, in a directory with no hub: any request that reached the board would fail to connect, so a refusal that comes first is told apart from a write. */
async function cli(args: string[]) {
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify({ TERM: "xterm-256color", AGENTHUB_HOME: join(root, "home") })});
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
const noBoard = () => expect(readdirSync(root).filter(name => name === ".agenthub")).toEqual([]);

describe("#1433 subcommand help", () => {
  test("listsSubcommand follows the help: documented subcommands only, free text never", () => {
    for (const [command, sub] of [["task", "propose"], ["task", "handoff"], ["task", "show"], ["task", "escalate"], ["task", "cancel"], ["goal", "new"], ["goal", "link"], ["release", "new"], ["release", "list"], ["release", "freeze"], ["sdlc", "merge"], ["queue", "resolve"]] as const)
      expect(listsSubcommand(command, sub), `${command} ${sub}`).toBe(true);
    for (const [command, sub] of [["say", "hello"], ["say", "try"], ["remember", "note"], ["task", "frobnicate"], ["task", "--help"], ["task", "<id>"], ["goal", "<title>"], ["nonsense", "new"]] as const)
      expect(listsSubcommand(command, sub), `${command} ${sub}`).toBe(false);
  });

  test("every listed subcommand of every command is found, and the usage names it", () => {
    for (const command of new Set(HELP.flatMap(entry => helpCommands(entry)))) {
      for (const entry of HELP.filter(candidate => helpCommands(candidate).includes(command))) {
        const first = entry.usage.replace(/^ahub \S+ ?/, "").split(/[\s|]/)[0]!.replace(/[\[\]]/g, "");
        if (/^[a-z][a-z0-9-]*$/.test(first) && first !== command) expect(listsSubcommand(command, first), `${command} ${first}`).toBe(true);
      }
    }
    expect(subcommandUsage("task", "propose")).toStartWith("ahub task propose ");
    expect(subcommandUsage("goal", "new")).toStartWith("ahub goal new ");
    expect(subcommandUsage("task", "nothing")).toBeUndefined();
  });

  test("ahub <command> <sub> --help and -h print the command's help, exit 0, and write nothing", async () => {
    for (const args of [["task", "propose"], ["task", "handoff"], ["task", "cancel"], ["goal", "new"], ["release", "new"], ["queue", "resolve"]]) {
      for (const flag of ["--help", "-h"]) {
        const result = await cli([...args, flag]);
        expect(result, `${args.join(" ")} ${flag}`).toEqual({ code: 0, stdout: `${renderHelp(80, false, args[0])}\n`, stderr: "" });
      }
    }
    noBoard();
  }, 120_000);

  test("ahub task propose refuses an option-like title word before it contacts the hub, and names the word and the usage", async () => {
    for (const args of [["task", "propose", "--frobnicate", "fix", "it"], ["task", "propose", "fix", "it", "--frobnicate"], ["task", "propose", "fix", "-h", "now"], ["task", "propose", "--owner", "codex", "--bogus", "x"]]) {
      const result = await cli(args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unknown option");
      expect(result.stderr).toContain("nothing was filed");
      expect(result.stderr).toContain("Usage: ahub task propose");
      expect(result.stderr).not.toMatch(/cannot connect|no hub|not running/i);
    }
    const flagged = await cli(["task", "propose", "--frobnicate", "fix", "it"]);
    expect(flagged.stderr).toContain(JSON.stringify("--frobnicate"));
  }, 60_000);

  test("a title that must start with dashes is typed after a lone --, and known flags still parse", async () => {
    // Past the refusal the CLI goes for the hub; in a directory with no hub that is a connection failure, which is the proof nothing was refused as an option.
    for (const args of [["task", "propose", "--", "--help", "is", "the", "title"], ["task", "propose", "--owner", "codex", "--detail", "d", "--urgent", "ship", "it"]]) {
      const result = await cli(args);
      expect(result.stderr, args.join(" ")).not.toContain("unknown option");
    }
  }, 60_000);

  test("ahub goal new and ahub task handoff refuse an option-like title the same way; a goal flag's value is not a stray option", async () => {
    for (const args of [["goal", "new", "--bogus", "title"], ["goal", "new", "-h", "later"], ["goal", "new", "title", "--milestone", "m1", "--frobnicate"]]) {
      const result = await cli(args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("unknown option");
      expect(result.stderr).toContain("Usage: ahub goal new");
    }
    const clean = await cli(["goal", "new", "title", "--milestone", "--looks-like-a-flag", "--shared"]);
    expect(clean.stderr).not.toContain("unknown option");
    expect(parseHandoffArgs(["--project", "p", "-h"])).toMatchObject({ usage: expect.stringContaining("unknown option \"-h\"") });
    expect(parseHandoffArgs(["--project", "p", "--frobnicate", "t"])).toMatchObject({ usage: expect.stringContaining("nothing was filed") });
    expect(parseHandoffArgs(["--project", "p", "a title"])).toMatchObject({ project: "p", title: "a title" });
  }, 60_000);

  test("ahub say and ahub remember keep their passthrough: -h inside the text is text, and a lone -h still asks for help", async () => {
    const said = await cli(["say", "try", "ls", "-h"]);
    expect(said.code).not.toBe(0);
    expect(said.stdout).toBe("");
    expect(said.stderr).not.toContain("unknown option");
    expect(await cli(["say", "-h"])).toEqual({ code: 0, stdout: `${renderHelp(80, false, "say")}\n`, stderr: "" });
    expect(await cli(["remember", "-h"])).toEqual({ code: 0, stdout: `${renderHelp(80, false, "remember")}\n`, stderr: "" });
    expect(await cli(["say", "hello", "-h"])).not.toEqual({ code: 0, stdout: `${renderHelp(80, false, "say")}\n`, stderr: "" });
  }, 60_000);

  test("free-text helpers: the first option-like word before -- is found, words after -- are text", () => {
    expect(unknownOption(["fix", "--bogus", "it"])).toBe("--bogus");
    expect(unknownOption(["fix", "-h"])).toBe("-h");
    expect(unknownOption(["--", "--help", "title"])).toBeUndefined();
    expect(unknownOption(["fix", "it"])).toBeUndefined();
    expect(withoutSeparator(["a", "--", "--b"])).toEqual(["a", "--b"]);
    expect(withoutSeparator(["a", "b"])).toEqual(["a", "b"]);
  });
});
