import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecs, runSpecsStamp, type SpecsStampTerminal } from "../src/cli/specs.ts";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { stampFrontmatter } from "../src/hub/specs.ts";
import { parseSpecsConfig } from "../src/hub/specs-config.ts";
import { HELP } from "../src/cli/help.ts";

// #1064 T3 (AC7): `ahub specs stamp` run by an agent identity, or without a terminal, is refused. Run by a person, it changes only the stamp line.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const made = mkdtempSync(join(tmpdir(), "ahub-specs-stamp-")); roots.push(made); // registered before anything that can throw
  const root = realPath(made);
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", root, ...args], { encoding: "utf8", timeout: 3000 });
    if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src/core.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "src/other.ts"), "export const other = 1;\n");
  git("add", "."); git("commit", "-qm", "baseline");
  return { root, git };
}
const terminal = (answer = true, isTTY = true) => { const asked: string[] = []; return { asked, term: { isTTY, ask: async (question: string) => { asked.push(question); return answer; } } satisfies SpecsStampTerminal }; };
async function stamp(root: string, args: string[], config = parseSpecsConfig(undefined), term = terminal()) {
  const out: string[] = [], err: string[] = [];
  const code = await runSpecsStamp(args, root, config, term.term, { out: line => out.push(line), error: line => err.push(line) });
  return { code, out, err, asked: term.asked };
}
const specText = (stamp: string | null, eol = "\n") => ["---", "id: core", "type: module", "title: Core", "status: active", "paths: [src/core.ts]", ...(stamp ? [`verified-against: ${stamp}`] : []), "---", "Body line one.", "", "Body line two, with [[links]] and trailing spaces.  ", ""].join(eol);

test("a person stamps a spec: the preview shows old -> new, they confirm, and only the verified-against line changes (#1064 AC7)", async () => {
  const { root, git } = fixture(), old = git("rev-parse", "HEAD");
  writeFileSync(join(root, "docs/core.md"), specText(old));
  git("add", "."); git("commit", "-qm", "spec");
  writeFileSync(join(root, "src/core.ts"), "export const value = 2;\n"); git("add", "."); git("commit", "-qm", "source change");
  const head = git("rev-parse", "HEAD");
  const before = readFileSync(join(root, "docs/core.md"), "utf8");
  const result = await stamp(root, ["core"]);
  expect(result.code, result.err.join("\n")).toBe(0);
  expect(result.out.join("\n")).toContain(`docs/core.md: ${old.slice(0, 12)} -> ${head.slice(0, 12)}`);
  expect(result.asked).toHaveLength(1);
  const after = readFileSync(join(root, "docs/core.md"), "utf8");
  expect(after).toBe(before.replace(`verified-against: ${old}`, `verified-against: ${head}`)); // exactly one line differs
  // the engine now reads it as fresh at HEAD
  expect(runSpecs(["check", "--require-fresh"], root, parseSpecsConfig(undefined), { out: () => {}, error: () => {} })).toBe(0);
});

test("--yes skips the question but never the terminal, and a refused or declined stamp writes nothing (#1064 AC7)", async () => {
  const { root, git } = fixture(), old = git("rev-parse", "HEAD");
  writeFileSync(join(root, "docs/core.md"), specText(old)); git("add", "."); git("commit", "-qm", "spec");
  writeFileSync(join(root, "src/core.ts"), "export const value = 2;\n"); git("add", "."); git("commit", "-qm", "change");
  const before = readFileSync(join(root, "docs/core.md"));
  // no terminal: refused with the cause and the next step, even with --yes
  for (const args of [["core"], ["core", "--yes"]]) {
    const refused = await stamp(root, args, parseSpecsConfig(undefined), terminal(true, false));
    expect(refused.code).toBe(1);
    expect(refused.err.join("\n")).toContain("needs a terminal, even with --yes");
    expect(refused.err.join("\n")).toContain("run ahub specs stamp in your own terminal");
    expect(refused.err.join("\n")).toContain("nothing was written");
    expect(refused.asked).toEqual([]);
  }
  expect(readFileSync(join(root, "docs/core.md"))).toEqual(before);
  // the person says no
  const declined = await stamp(root, ["core"], parseSpecsConfig(undefined), terminal(false));
  expect(declined.code).toBe(0); expect(declined.out.join("\n")).toContain("not stamped; nothing was written");
  expect(readFileSync(join(root, "docs/core.md"))).toEqual(before);
  // --yes at a terminal writes without asking
  const yes = await stamp(root, ["core", "--yes"]);
  expect(yes.code).toBe(0); expect(yes.asked).toEqual([]);
  expect(readFileSync(join(root, "docs/core.md"), "utf8")).not.toBe(before.toString());
  // a second run finds the stamp already current and writes nothing
  const again = await stamp(root, ["core", "--yes"]);
  expect(again.code).toBe(0); expect(again.out.join("\n")).toContain("already holds this stamp");
});

test("a spec with no stamp gets the line added before the closing delimiter, and CRLF files keep their endings (#1064 AC7)", async () => {
  const { root, git } = fixture(), head = git("rev-parse", "HEAD");
  writeFileSync(join(root, "docs/core.md"), specText(null, "\r\n")); git("add", "."); git("commit", "-qm", "spec crlf");
  const now = git("rev-parse", "HEAD");
  const before = readFileSync(join(root, "docs/core.md"), "utf8");
  expect((await stamp(root, ["docs/core.md", "--yes"])).code).toBe(0);
  const after = readFileSync(join(root, "docs/core.md"), "utf8");
  expect(after).toBe(before.replace("---\r\nBody line one.", `verified-against: ${now}\r\n---\r\nBody line one.`));
  expect(after.split("\n").every((line, i, all) => i === all.length - 1 || line.endsWith("\r"))).toBe(true); // every line still ends CRLF
  expect(head).not.toBe(now);
});

test("a file mode, a byte order mark and a body that is not UTF-8 survive a stamp (#1064 AC7)", async () => {
  const { root, git } = fixture();
  const body = Buffer.concat([Buffer.from("\uFEFF---\nid: core\ntype: module\ntitle: Core\nstatus: active\npaths: [src/core.ts]\n---\nBody "), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from(" end\n")]);
  writeFileSync(join(root, "docs/core.md"), body); chmodSync(join(root, "docs/core.md"), 0o600);
  git("add", "."); git("commit", "-qm", "odd spec");
  const head = git("rev-parse", "HEAD");
  expect((await stamp(root, ["core", "--yes"])).code).toBe(0);
  const after = readFileSync(join(root, "docs/core.md"));
  const expected = Buffer.concat([Buffer.from(`\uFEFF---\nid: core\ntype: module\ntitle: Core\nstatus: active\npaths: [src/core.ts]\nverified-against: ${head}\n---\nBody `), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from(" end\n")]);
  expect(after.equals(expected)).toBe(true);
  expect(statSync(join(root, "docs/core.md")).mode & 0o777).toBe(0o600);
});

test("a stamps-file entry changes only its verifiedAgainst value, keeping every other byte of the file (#1064 AC7)", async () => {
  const { root, git } = fixture(), old = git("rev-parse", "HEAD");
  writeFileSync(join(root, "README.md"), "Project.\n");
  const manifest = `{\n  "schemaVersion": 1,\n  "documents": {\n    "README.md": {\n      "verifiedAgainst": "${old}",\n      "paths": ["src/core.ts"]\n    },\n    "docs/other.md": { "verifiedAgainst": "${old}", "paths": ["src/other.ts"] }\n  }\n}\n`;
  writeFileSync(join(root, "stamps.json"), manifest); writeFileSync(join(root, "docs/other.md"), "Other.\n");
  git("add", "."); git("commit", "-qm", "stamps");
  writeFileSync(join(root, "src/core.ts"), "export const value = 3;\n"); git("add", "."); git("commit", "-qm", "change");
  const head = git("rev-parse", "HEAD"), config = parseSpecsConfig({ stamps_file: "stamps.json" });
  const result = await stamp(root, ["README.md", "--yes"], config);
  expect(result.code, result.err.join("\n")).toBe(0);
  expect(readFileSync(join(root, "stamps.json"), "utf8")).toBe(manifest.replace(`"verifiedAgainst": "${old}",\n      "paths": ["src/core.ts"]`, `"verifiedAgainst": "${head}",\n      "paths": ["src/core.ts"]`));
  // the other document's stamp is untouched, and the engine reads README as fresh
  expect(JSON.parse(readFileSync(join(root, "stamps.json"), "utf8")).documents["docs/other.md"].verifiedAgainst).toBe(old);
  const report: string[] = [];
  runSpecs(["check", "--json"], root, config, { out: line => report.push(line), error: () => {} });
  expect(JSON.parse(report.join("")).freshness.find((row: { path: string }) => row.path === "README.md").state).toBe("fresh");
});

test("stamping is refused while the covered paths have uncommitted changes, and every refusal is reported at once (#1064 AC7)", async () => {
  const { root, git } = fixture(), old = git("rev-parse", "HEAD");
  writeFileSync(join(root, "docs/core.md"), specText(old));
  writeFileSync(join(root, "docs/other.md"), specText(old).replace("id: core", "id: other").replace("src/core.ts", "src/other.ts"));
  git("add", "."); git("commit", "-qm", "two specs");
  const before = [readFileSync(join(root, "docs/core.md")), readFileSync(join(root, "docs/other.md"))];
  writeFileSync(join(root, "src/core.ts"), "export const value = 9;\n"); // uncommitted
  const refused = await stamp(root, ["core", "other", "missing", "--yes"]);
  expect(refused.code).toBe(1);
  const text = refused.err.join("\n");
  expect(text).toContain("docs/core.md: its covered paths have uncommitted changes; commit or stash them, then stamp");
  expect(text).toContain('no spec or stamped document is named "missing"');
  expect(text).toContain("nothing was written");
  // `other` was fine, but a refusal anywhere means nothing is written for any target
  expect([readFileSync(join(root, "docs/core.md")), readFileSync(join(root, "docs/other.md"))]).toEqual(before);
});

test("stamp targets: a spec with no paths, a duplicate id and a bad usage are refused with the next step (#1064 AC7)", async () => {
  const { root, git } = fixture();
  writeFileSync(join(root, "docs/nopaths.md"), "---\nid: nopaths\ntype: module\ntitle: N\n---\nBody\n");
  writeFileSync(join(root, "docs/a.md"), specText(null)); writeFileSync(join(root, "docs/b.md"), specText(null));
  git("add", "."); git("commit", "-qm", "specs");
  const none = await stamp(root, ["nopaths", "--yes"]);
  expect(none.code).toBe(1); expect(none.err.join("\n")).toContain("has no paths, so there is nothing a stamp could certify");
  const dup = await stamp(root, ["core", "--yes"]);
  expect(dup.code).toBe(1); expect(dup.err.join("\n")).toContain("names more than one document");
  for (const args of [[], ["--yes"], ["core", "--force"]]) {
    const usage = await stamp(root, args, parseSpecsConfig(undefined), terminal());
    expect(usage.code).toBe(1); expect(usage.err.join("\n")).toContain("usage: ahub specs stamp <id-or-document>... [--yes]");
  }
});

test("stampFrontmatter is lossless: no-op for the same stamp, refuses a missing or unclosed header and a duplicate field (#1064 AC7)", () => {
  const sha = "a".repeat(40), other = "b".repeat(40);
  const text = `---\nid: x\nverified-against:   ${other}  \n---\nBody\n`;
  const done = stampFrontmatter(text, sha);
  expect(done).toEqual({ ok: true, text: `---\nid: x\nverified-against:   ${sha}\n---\nBody\n`, from: other });
  expect(stampFrontmatter(done.ok ? done.text : "", sha)).toMatchObject({ ok: true, from: sha, text: done.ok ? done.text : "" });
  expect(stampFrontmatter(`---\nid: x\nverified-against: "${other}"\n---\n`, sha)).toMatchObject({ ok: true, from: other });
  expect(stampFrontmatter("no frontmatter\n", sha)).toMatchObject({ ok: false, error: expect.stringContaining("has no frontmatter") });
  expect(stampFrontmatter("---\nid: x\nBody never closed\n", sha)).toMatchObject({ ok: false, error: expect.stringContaining("no closing ---") });
  expect(stampFrontmatter(`---\nverified-against: ${other}\nverified-against: ${other}\n---\n`, sha)).toMatchObject({ ok: false, error: expect.stringContaining("more than once") });
  expect(stampFrontmatter(`---\n${"x: y\n".repeat(3000)}---\n`, sha)).toMatchObject({ ok: false, error: expect.stringContaining("larger than 8 KiB") });
  // a stamp-looking line in the body is not the frontmatter's
  const inBody = stampFrontmatter(`---\nid: x\n---\nverified-against: ${other}\n`, sha);
  expect(inBody).toMatchObject({ ok: true, from: null, text: `---\nid: x\nverified-against: ${sha}\n---\nverified-against: ${other}\n` });
});

test("an agent identity can never stamp: console class for peers, refused for live-test delegation, named in the audit without operands, and listed in help (#1064 AC7)", () => {
  for (const args of [["stamp", "core"], ["stamp", "core", "--yes"], ["stamp", "../outside.md", "--yes"], ["stamp"]]) expect(classifyPeerCommand("specs", args)).toBe("console");
  for (const args of [["list"], ["check"], ["covers", "src/core.ts"]]) expect(classifyPeerCommand("specs", args)).toBe("allowed"); // the reads stay open
  expect(liveTestRefusal("specs", ["stamp", "core", "--yes"])).toBe(true);
  expect(liveTestRefusal("specs", ["check"])).toBe(false);
  expect(cliCommandLabel("specs", ["stamp", "private/path.md"])).toBe("specs stamp");
  const row = HELP.find(entry => entry.usage.startsWith("ahub specs"))!;
  expect(row.usage).toContain("stamp <id-or-document...> [--yes]");
  expect(row.description).toContain("person only");
  expect(row.description).toContain("uncommitted changes");
});

test("the real CLI refuses a stamp from an agent shell and from a pipe, and writes nothing (#1064 AC7)", () => {
  const { root, git } = fixture(), old = git("rev-parse", "HEAD");
  writeFileSync(join(root, "docs/core.md"), specText(old)); git("add", "."); git("commit", "-qm", "spec");
  mkdirSync(join(root, ".agenthub"), { recursive: true });
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false } }));
  const before = readFileSync(join(root, "docs/core.md"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key === "CLAUDECODE" || key === "CLAUDE_CODE_SESSION_ID" || key.startsWith("CODEX_") || key.startsWith("ORCA_") || key === "CI") delete env[key];
  Object.assign(env, { HOME: join(root, "home"), AGENTHUB_HOME: join(root, "hub"), GIT_CONFIG_GLOBAL: "/dev/null" });
  const run = (extra: NodeJS.ProcessEnv) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "specs", "stamp", "core", "--yes"], { cwd: root, env: { ...env, ...extra }, stdin: "ignore" });
  // an agent shell (a marker names a peer) is refused as an agent, before the command runs
  const agent = run({ AGENTHUB_PEER_ID: "codex" });
  expect(agent.exitCode).not.toBe(0);
  expect(`${agent.stdout}${agent.stderr}`).toContain("codex");
  // a person without a terminal (stdin and stdout are pipes) is refused by the command itself, with the next step
  const piped = run({});
  expect(piped.exitCode).toBe(1);
  expect(piped.stderr.toString()).toContain("needs a terminal, even with --yes");
  expect(readFileSync(join(root, "docs/core.md"))).toEqual(before);
});
