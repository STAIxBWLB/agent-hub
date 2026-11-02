import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { init, planInit, specsBlock } from "../src/cli/init.ts";
import { initSettingRows } from "../src/cli/init.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";

// #1064 T3 (AC6): `ahub init --no-specs` writes specs.enabled false and removes the specs block, with text outside the markers byte-identical; `--specs` restores both; `--dry-run` shows the change without writing.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const made = mkdtempSync(join(tmpdir(), "ahub-init-specs-")); roots.push(made); // registered before anything that can throw
  const root = realPath(made), user = join(root, "user"), home = join(root, "hub"); mkdirSync(user);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("CODEX_") || key === "CLAUDECODE" || key === "CLAUDE_CODE_SESSION_ID" || key.startsWith("ORCA_") || key === "CI") delete env[key];
  Object.assign(env, { HOME: user, AGENTHUB_HOME: home, CLAUDE_CONFIG_DIR: join(user, "claude"), AMEM_HOME: join(root, "memory"), GIT_CONFIG_GLOBAL: "/dev/null" });
  const repo = (name: string) => { const cwd = join(root, name); mkdirSync(cwd); expect(hubGitSync(["init", "-q"], { cwd, env, encoding: "utf8", timeout: 3000 }).status).toBe(0); return cwd; };
  const run = (cwd: string, args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd, env, stdin: "ignore" });
  return { root, repo, run };
}
const out = (result: { stdout: Buffer; stderr: Buffer }) => `${result.stdout.toString()}${result.stderr.toString()}`;
const agents = (cwd: string) => readFileSync(join(cwd, "AGENTS.md"), "utf8");
const SPECS_BEGIN = "<!-- AGENT_HUB_SPECS:BEGIN";
const SPECS_END = "<!-- AGENT_HUB_SPECS:END -->";

test("a new project gets the specs block by default, and nothing about specs is on when it is turned off (#1064 AC6)", () => {
  const p = fixture(), cwd = p.repo("new");
  expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  expect(agents(cwd)).toContain(SPECS_BEGIN); expect(agents(cwd)).toContain("## Design specs"); expect(agents(cwd)).toContain(SPECS_END);
  expect(agents(cwd).split(SPECS_BEGIN).length).toBe(2); // exactly one block
  expect(agents(cwd)).toContain("<!-- AGENT_HUB:BEGIN"); // the hub block is still there
  const off = fixture(), other = off.repo("off");
  const done = off.run(other, ["init", "--no-specs"]);
  expect(done.exitCode, out(done)).toBe(0);
  expect(agents(other)).not.toContain(SPECS_BEGIN); expect(agents(other)).not.toContain("Design specs");
  // the template's own specs block keeps its other keys; only enabled changed
  expect(JSON.parse(readFileSync(join(other, ".agenthub/config.json"), "utf8")).specs).toEqual({ enabled: false, review: "report", roots: [], stamps_file: "" });
  expect(loadConfig(other).specs.enabled).toBe(false);
});

test("--no-specs removes the block and writes specs.enabled false, text outside the markers is byte-identical, and --specs restores both (#1064 AC6)", () => {
  const p = fixture(), cwd = p.repo("toggle");
  const mine = "# Mine\n\nKeep this paragraph exactly.\n\n    indented code stays\n\nTrailing note without a newline";
  writeFileSync(join(cwd, "AGENTS.md"), mine);
  expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  const withBlock = agents(cwd);
  expect(withBlock).toStartWith(mine); // the user's text is first, untouched
  const outside = (text: string) => text.replace(/<!-- AGENT_HUB_SPECS:BEGIN[\s\S]*?<!-- AGENT_HUB_SPECS:END -->\n?/, "");
  const off = p.run(cwd, ["init", "--no-specs"]);
  expect(off.exitCode, out(off)).toBe(0);
  const without = agents(cwd);
  expect(without).not.toContain(SPECS_BEGIN);
  expect(without).toBe(outside(withBlock).replace(/\n+$/, "\n")); // only the block and its blank lines went
  expect(without).toStartWith(mine);
  expect(without).toContain("<!-- AGENT_HUB:BEGIN"); expect(without).toContain("<!-- AGENT_HUB:END -->");
  expect(JSON.parse(readFileSync(join(cwd, ".agenthub/config.json"), "utf8")).specs.enabled).toBe(false);
  // --specs restores both, and the text in between is the same bytes as the first run
  const on = p.run(cwd, ["init", "--specs"]);
  expect(on.exitCode, out(on)).toBe(0);
  expect(agents(cwd)).toBe(withBlock);
  expect(JSON.parse(readFileSync(join(cwd, ".agenthub/config.json"), "utf8")).specs.enabled).toBe(true);
  // a second --specs is a no-op
  expect(p.run(cwd, ["init", "--specs"]).exitCode).toBe(0);
  expect(agents(cwd)).toBe(withBlock);
});

test("--dry-run shows the block and key change with old and new values and writes nothing (#1064 AC6)", () => {
  const p = fixture(), cwd = p.repo("dry");
  expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  const before = { agents: agents(cwd), config: readFileSync(join(cwd, ".agenthub/config.json"), "utf8") };
  const dry = p.run(cwd, ["init", "--no-specs", "--dry-run", "--json"]);
  expect(dry.exitCode, out(dry)).toBe(0);
  const shown = JSON.parse(dry.stdout.toString()) as { changes: { path: string; action: string }[]; settings: { key: string; file: string; from?: unknown; to: unknown }[] };
  expect(shown.settings).toEqual([{ key: "specs.enabled", file: "config.json", from: true, to: false }]); // old -> new, as the template wrote it
  expect(shown.changes.some(row => row.path.endsWith("AGENTS.md") && row.action === "modify")).toBe(true);
  expect(shown.changes.some(row => row.path.endsWith("config.json") && row.action === "modify")).toBe(true);
  expect(agents(cwd)).toBe(before.agents); expect(readFileSync(join(cwd, ".agenthub/config.json"), "utf8")).toBe(before.config);
  // once the key is written, the preview names old -> new
  expect(p.run(cwd, ["init", "--no-specs"]).exitCode).toBe(0);
  const back = JSON.parse(p.run(cwd, ["init", "--specs", "--dry-run", "--json"]).stdout.toString());
  expect(back.settings).toEqual([{ key: "specs.enabled", file: "config.json", from: false, to: true }]);
  const human = p.run(cwd, ["init", "--specs", "--dry-run"]);
  expect(out(human)).toContain("specs.enabled");
});

test("--spec-review sets specs.review through the table, validated, and a bad value is refused with the allowed values (#1064 AC6)", () => {
  const p = fixture(), cwd = p.repo("review");
  for (const mode of ["off", "require", "report"]) {
    const done = p.run(cwd, ["init", "--spec-review", mode]);
    expect(done.exitCode, out(done)).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, ".agenthub/config.json"), "utf8")).specs.review).toBe(mode);
    expect(loadConfig(cwd).specs.review).toBe(mode as "off" | "report" | "require");
  }
  const before = readFileSync(join(cwd, ".agenthub/config.json"), "utf8");
  const bad = p.run(cwd, ["init", "--spec-review", "strict"]);
  expect(bad.exitCode).not.toBe(0);
  expect(out(bad)).toContain("--spec-review");
  expect(out(bad)).toContain("off, report, require");
  expect(out(bad)).toContain("nothing was written");
  expect(readFileSync(join(cwd, ".agenthub/config.json"), "utf8")).toBe(before);
});

test("an existing project's specs choice survives a plain init, and the block follows it (#1064 AC6)", () => {
  const p = fixture(), cwd = p.repo("keep");
  expect(p.run(cwd, ["init", "--no-specs"]).exitCode).toBe(0);
  const config = readFileSync(join(cwd, ".agenthub/config.json"), "utf8"), md = agents(cwd);
  expect(p.run(cwd, ["init"]).exitCode).toBe(0); // no flag: the project's own key decides, so the block does not come back
  expect(readFileSync(join(cwd, ".agenthub/config.json"), "utf8")).toBe(config);
  expect(agents(cwd)).toBe(md);
  expect(agents(cwd)).not.toContain(SPECS_BEGIN);
  expect(planInit(cwd)).toEqual([]);
});

test("specsBlock: idempotent, removes only its own markers, and refuses a half block without changing anything (#1064 AC6)", () => {
  const text = "# Top\n\nBody.\n";
  const on = specsBlock(text, true);
  expect(on).toStartWith(text.trimEnd());
  expect(specsBlock(on, true)).toBe(on);                // replace in place, same bytes
  expect(specsBlock(on, false)).toBe(text);              // gone, with its blank lines
  expect(specsBlock(text, false)).toBe(text);            // nothing to remove
  expect(specsBlock("", false)).toBe("");
  // a block in the middle keeps the text after it
  const middle = `${text}\n${on.slice(text.length).trim()}\n\n## After\nMore.\n`;
  expect(specsBlock(middle, false)).toBe("# Top\n\nBody.\n\n## After\nMore.\n");
  expect(specsBlock(middle, true)).toBe(middle);
  // half blocks: refused with the cause and the next step
  for (const half of [`${text}${SPECS_BEGIN} (x) -->\nno end\n`, `${text}stray ${SPECS_END}\n`]) {
    expect(() => specsBlock(half, true)).toThrow("AGENT_HUB_SPECS markers in AGENTS.md are incomplete");
    expect(() => specsBlock(half, false)).toThrow("nothing was written");
  }
});

test("the hub block's own markers and the specs block do not interfere, and a refused half block writes nothing through init (#1064 AC6)", () => {
  const p = fixture(), cwd = p.repo("half");
  writeFileSync(join(cwd, "AGENTS.md"), `# Mine\n${SPECS_BEGIN} (half) -->\nnever closed\n`);
  const before = agents(cwd);
  const refused = p.run(cwd, ["init"]);
  expect(refused.exitCode).not.toBe(0);
  expect(out(refused)).toContain("AGENT_HUB_SPECS markers in AGENTS.md are incomplete");
  expect(agents(cwd)).toBe(before);
  expect(existsSync(join(cwd, ".agenthub/config.json"))).toBe(false); // nothing else was written either
  expect(() => initSettingRows(cwd)).toThrow("incomplete");
  expect(() => init(cwd)).toThrow("incomplete");
});

test("removing the specs block keeps the whitespace of the text around it: an indented code block after it, trailing spaces and the end of the file (#1064 AC6 review)", () => {
  const on = specsBlock("", true);
  // text after the block that starts with an indented code block: its indentation is meaning, so it stays indented
  const after = "\n\n    literal instruction\n\nBack to prose.  \n\n";
  const text = `# Top\n\nBody.\n\n${on.trimEnd()}${after}`;
  expect(specsBlock(text, false)).toBe("# Top\n\nBody.\n\n    literal instruction\n\nBack to prose.  \n\n");
  // trailing blank lines and spaces at the very end of the remaining document survive
  expect(specsBlock(`# Top\n\n${on.trimEnd()}\n\nEnd.   \n\n\n`, false)).toBe("# Top\n\nEnd.   \n\n\n");
  // nothing before the block: the blank lines after it go, the first real line is untouched, and an indented first line stays indented
  expect(specsBlock(`${on.trimEnd()}\n\n    code first\n`, false)).toBe("    code first\n");
  expect(specsBlock(`${on.trimEnd()}\n\nText.\n`, false)).toBe("Text.\n");
  // CRLF files: the block and its separator go, and no stray LF is left behind
  const crlf = `# Top\r\n\r\nBody.\r\n\r\n${on.trimEnd().replace(/\n/g, "\r\n")}\r\n\r\nAfter.\r\n`;
  expect(specsBlock(crlf, false)).toBe("# Top\r\n\r\nBody.\r\n\r\nAfter.\r\n");
  // only the block: nothing is left
  expect(specsBlock(on, false)).toBe("");
  expect(specsBlock(`${on.trimEnd()}\n\n\n`, false)).toBe("");
  // a block with no blank line before it keeps that text's last line break
  expect(specsBlock(`Line.\n${on.trimEnd()}\nNext.\n`, false)).toBe("Line.\nNext.\n");
});

test("turning specs off and on again returns the file to the same bytes when the block sat at the end, and removal never edits text outside the markers (#1064 AC6 review)", () => {
  for (const original of ["# Mine\n\nText.\n", "# Mine\n\n    indented\n", "Only a line", "# Mine\n\nTrailing spaces  \n\n"]) {
    const withBlock = specsBlock(original, true);
    const without = specsBlock(withBlock, false);
    expect(withBlock).toStartWith(original.trimEnd());
    // everything the user wrote, minus trailing whitespace the insert itself normalises, is still there in order
    expect(without.replace(/\s+$/, "")).toBe(original.replace(/\s+$/, ""));
    expect(specsBlock(without, true)).toBe(withBlock);
  }
  // a block in the middle: both sides come back exactly
  const middle = `# A\n\nBefore.\n\n${specsBlock("", true).trimEnd()}\n\n    after code\n`;
  const removed = specsBlock(middle, false);
  expect(removed).toBe("# A\n\nBefore.\n\n    after code\n");
  expect(removed.includes("AGENT_HUB_SPECS")).toBe(false);
});
