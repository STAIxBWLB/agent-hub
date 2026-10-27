import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP, helpCommands, renderHelp } from "../src/cli/help.ts";
import { classifyPeerCommand, cliCommandLabel } from "../src/cli/identity.ts";
import { renderSourceAdd, renderSourceList } from "../src/cli/source-output.ts";
import { SourceRegistry } from "../src/hub/sources.ts";

// agent-hub #508 (hub task #329): `ahub source add|list` through the real CLI, as a person and as an agent shell.
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "NO_COLOR"];
const root = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-source-cli-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const flat = (text: string) => plain(text).replace(/\s+/g, " ").trim();

/** One project directory: a git repo with a pii.paths entry and a hub home of its own. The PII pattern is the shipped routing.toml default (resident registration numbers). */
function project() {
  const dir = realpathSync(mkdtempSync(join(root, "p-")));
  Bun.spawnSync(["git", "init", "-q", dir]);
  mkdirSync(join(dir, ".agenthub")); mkdirSync(join(dir, "secret")); mkdirSync(join(dir, "open"));
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ pii: { paths: ["secret"] } }));
  return { dir, home: join(dir, "home"), state: () => join(dir, "home") };
}
type Project = ReturnType<typeof project>;
/** The CLI as a person runs it (no agent markers, stdout a pipe), or with `env` markers set to make it an agent shell. */
async function cli(p: Project, args: string[], env: Record<string, string> = {}) {
  const wrapper = join(p.dir, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify({ TERM: "xterm-256color", ...env, AGENTHUB_HOME: p.home })});
process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(CLI)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: p.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
/** The state dir the CLI used: the one folder under the hub home that holds a sources directory. */
function sourcesDir(p: Project): string | undefined {
  const find = (dir: string, depth: number): string | undefined => {
    if (depth > 6 || !existsSync(dir)) return undefined;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "sources") return join(dir, entry.name);
      const found = find(join(dir, entry.name), depth + 1); if (found) return found;
    }
    return undefined;
  };
  return find(p.home, 0) ?? find(join(p.dir, ".agenthub"), 0);
}
const write = (p: Project, name: string, text: string) => { const path = join(p.dir, name); writeFileSync(path, text); return path; };

test("add registers a file under sources/<id>/ and says so; adding the same bytes again names the same id", async () => {
  const p = project(), file = write(p, "open/note.txt", "hello source\n");
  const first = await cli(p, ["source", "add", file]);
  expect(first.code, first.stderr).toBe(0);
  expect(plain(first.stdout)).toContain("Registered src:e5d53b3ad5222924");
  expect(plain(first.stdout)).toContain("private   no");
  const dir = sourcesDir(p)!;
  expect(dir).toBeDefined();
  expect(readdirSync(join(dir, "src-e5d53b3ad5222924")).sort()).toEqual(["meta.json", "raw", "text"]);
  expect(readFileSync(join(dir, "src-e5d53b3ad5222924", "raw"), "utf8")).toBe("hello source\n");
  const again = await cli(p, ["source", "add", file]);
  expect(plain(again.stdout)).toContain("Already registered src:e5d53b3ad5222924");
  expect(readdirSync(dir)).toHaveLength(1);
});

test("add --json prints the data the human output is made from, and list --json prints the records", async () => {
  const p = project(), file = write(p, "open/a.txt", "json check");
  const added = JSON.parse((await cli(p, ["source", "add", file, "--json"])).stdout);
  expect(added).toMatchObject({ created: true, upgraded: false, kind: "file", origin: file, private: false, text: true, reasons: [] });
  expect(added.id).toMatch(/^src:[0-9a-f]{16}$/);
  expect(added.sha256.startsWith(added.id.slice(4))).toBe(true);
  const rows = JSON.parse((await cli(p, ["source", "list", "--json"])).stdout);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: added.id, kind: "file", origin: file, sha256: added.sha256, bytes: 10, private: false });
  expect(rows[0].origins).toHaveLength(1);
  // default is not JSON
  const human = (await cli(p, ["source", "list"])).stdout;
  expect(() => JSON.parse(human)).toThrow();
  expect(plain(human)).toContain("Sources (1)");
});

test("a path under pii.paths is stored private, and a text match on the configured PII pattern is private too", async () => {
  const p = project();
  const inPath = await cli(p, ["source", "add", write(p, "secret/a.txt", "some private notes"), "--json"]);
  expect(JSON.parse(inPath.stdout)).toMatchObject({ private: true, reasons: ["path under pii.paths"] });
  const inText = await cli(p, ["source", "add", write(p, "open/b.txt", "student 900101-1234567 grade"), "--json"]);
  expect(JSON.parse(inText.stdout)).toMatchObject({ private: true, reasons: ["text matches signals.pii_patterns"] });
  const clean = await cli(p, ["source", "add", write(p, "open/c.txt", "ordinary text"), "--json"]);
  expect(JSON.parse(clean.stdout)).toMatchObject({ private: false, reasons: [] });
  // the matched text never reaches the output
  expect(inText.stdout + inText.stderr).not.toContain("900101");
});

test("privacy is monotonic through the CLI in both registration orders: same bytes, same id, private either way", async () => {
  // public path first, then a private path
  const a = project(), bytes = "identical bytes in two places";
  const open = await cli(a, ["source", "add", write(a, "open/x.txt", bytes), "--json"]);
  expect(JSON.parse(open.stdout).private).toBe(false);
  const secret = await cli(a, ["source", "add", write(a, "secret/x.txt", bytes), "--json"]);
  const upgraded = JSON.parse(secret.stdout);
  expect(upgraded).toMatchObject({ id: JSON.parse(open.stdout).id, created: false, upgraded: true, private: true });
  expect(plain((await cli(a, ["source", "add", join(a.dir, "secret/x.txt")])).stdout)).toContain("Already registered");
  const rowsA = JSON.parse((await cli(a, ["source", "list", "--json"])).stdout);
  expect(rowsA).toHaveLength(1);
  expect(rowsA[0].private).toBe(true);
  expect(rowsA[0].origins.map((o: { origin: string }) => o.origin).sort()).toEqual([join(a.dir, "open/x.txt"), join(a.dir, "secret/x.txt")].sort());
  // private path first, then a public one: never downgraded
  const b = project();
  const first = await cli(b, ["source", "add", write(b, "secret/y.txt", bytes), "--json"]);
  expect(JSON.parse(first.stdout).private).toBe(true);
  const second = JSON.parse((await cli(b, ["source", "add", write(b, "open/y.txt", bytes), "--json"])).stdout);
  expect(second).toMatchObject({ id: JSON.parse(first.stdout).id, created: false, upgraded: false, private: true });
  const rowsB = JSON.parse((await cli(b, ["source", "list", "--json"])).stdout);
  expect(rowsB).toHaveLength(1);
  expect(rowsB[0].private).toBe(true);
  expect(rowsB[0].origins).toHaveLength(2);
});

test("a file over the cap is refused with the cap in the reason and nothing is stored", async () => {
  const p = project(), big = join(p.dir, "open/big.bin");
  writeFileSync(big, Buffer.alloc(16 * 1024 * 1024 + 1));
  const result = await cli(p, ["source", "add", big]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(`over the ${16 * 1024 * 1024} byte cap (MAX_PROJECTION_INPUT)`);
  expect(sourcesDir(p)).toBeUndefined();
});

test("bad input is refused with the usage or the reason: no operand, an unknown subcommand, http, a missing file, a directory, extra operands", async () => {
  const p = project();
  const usage = "usage: ahub source add <path|url>";
  for (const args of [["source"], ["source", "add"], ["source", "frob"], ["source", "list", "extra"], ["source", "add", "a", "b"]]) {
    const r = await cli(p, args);
    expect(r.code, args.join(" ")).not.toBe(0);
    expect(r.stderr, args.join(" ")).toContain(usage);
  }
  expect((await cli(p, ["source", "add", "http://example.com/a"])).stderr).toContain("only https URLs can be registered");
  expect((await cli(p, ["source", "add", "ftp://example.com/a"])).stderr).toContain("only https URLs can be registered");
  expect((await cli(p, ["source", "add", join(p.dir, "open/missing.txt")])).stderr).toContain("cannot register");
  expect((await cli(p, ["source", "add", join(p.dir, "open")])).stderr).toContain("cannot register");
  expect(sourcesDir(p)).toBeUndefined();
});

test("an agent shell is refused before anything runs, under every marker, and no registry is created", async () => {
  for (const env of [{ CODEX_THREAD_ID: "t" }, { CLAUDECODE: "1" }, { AGENTHUB_PEER_ID: "codex" }] as Record<string, string>[]) {
    const p = project(), file = write(p, "open/n.txt", "agent text");
    for (const args of [["source", "add", file], ["source", "list"], ["source", "list", "--json"]]) {
      const r = await cli(p, args, env);
      expect(r.code, `${JSON.stringify(env)} ${args.join(" ")}`).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`cannot run ahub source ${args[1]}`);
      expect(r.stderr).not.toContain("agent text");
      expect(r.stderr).not.toContain(file); // the operand is never echoed
    }
    expect(sourcesDir(p)).toBeUndefined();
  }
});

test("classification: every form of source is console (never allowed or conductor), and the audit label names the form without its operands", () => {
  for (const args of [["add", "/p/a.txt"], ["add", "https://example.com/x"], ["list"], ["list", "--json"], [], ["frob"], ["add", "--json", "/p/a.txt"]]) {
    expect(classifyPeerCommand("source", args), args.join(" ")).toBe("console");
  }
  expect(cliCommandLabel("source", ["add", "/secret/patients.pdf"])).toBe("source add");
  expect(cliCommandLabel("source", ["list", "--json"])).toBe("source list");
  expect(cliCommandLabel("source", ["--json", "add", "/x"])).toBe("source add");
  expect(cliCommandLabel("source", ["frob", "/secret"])).toBe("source");
  expect(cliCommandLabel("source", [])).toBe("source");
});

test("help lists the source command and its syntax, and the command is in the dispatch table", () => {
  const entry = HELP.find(item => helpCommands(item).includes("source"));
  expect(entry).toBeDefined();
  expect(entry!.usage).toBe("ahub source add <path|url> | list [--json] [--color=auto|always|never]");
  expect(entry!.description).toContain("person only");
  for (const word of ["src:<16 hex of the SHA-256>", "sources/<id>/", "https only", "at most 5 redirects", "16 MiB", "pii.paths", "signals.pii_patterns", "never downgraded"]) expect(entry!.description, word).toContain(word);
  expect(renderHelp(100, false, "source").replace(/\s+/g, " ")).toContain("ahub source add <path|url> | list");
  const src = readFileSync(CLI, "utf8"), at = src.indexOf("const commands: Record<");
  expect(src.slice(at, src.indexOf("\n};\n", at))).toMatch(/^  source: /m);
});

test("the renderers wrap at 80 columns, name every origin of a multi-origin source and show a private record's origins to the person", () => {
  const rows = [
    { id: "src:e5d53b3ad5222924", kind: "file", origin: "/a/very/long/path/that/goes/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/note.txt", sha256: "e".repeat(64), bytes: 13, added_at: 1000, private: false, origins: [{ kind: "file", origin: "/a.txt", added_at: 1000, private: false }] },
    { id: "src:bd49336b6561f16d", kind: "url", origin: "https://example.com/doc", sha256: "b".repeat(64), bytes: 2_500_000, added_at: 2000, private: true, origins: [{ kind: "url", origin: "https://example.com/doc", added_at: 2000, private: false }, { kind: "file", origin: "/secret/doc.txt", added_at: 3000, private: true }] },
  ];
  for (const columns of [40, 80, 200]) {
    const text = renderSourceList(rows, columns, 100_000).map(line => line.map(span => span.text).join("")).join("\n");
    for (const line of text.split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(columns);
    expect(flat(text)).toContain("src:e5d53b3ad5222924");
    expect(flat(text)).toContain("src:bd49336b6561f16d");
    expect(flat(text)).toContain("2 origins");
    expect(flat(text)).toContain("/secret/doc.txt (private)");
  }
  expect(renderSourceList([], 80).map(line => line.map(span => span.text).join(""))).toEqual(["no sources registered; add one with ahub source add <path|url>"]);
  const added = renderSourceAdd({ id: "src:e5d53b3ad5222924", created: false, upgraded: true, kind: "file", origin: "/x", sha256: "e".repeat(64), bytes: 13, private: true, text: false, reasons: ["path under pii.paths"] }, 80).map(line => line.map(span => span.text).join("")).join("\n");
  expect(added).toContain("Already registered src:e5d53b3ad5222924; now private");
  expect(added).toContain("none (no converter handles these bytes)");
  expect(added).toContain("because   path under pii.paths");
});

test("what the CLI wrote is what the registry reads back", async () => {
  const p = project(), file = write(p, "open/r.txt", "roundtrip");
  const added = JSON.parse((await cli(p, ["source", "add", file, "--json"])).stdout);
  const registry = new SourceRegistry(join(sourcesDir(p)!, ".."));
  expect(registry.get(added.id)).toMatchObject({ id: added.id, origin: file, private: false });
  expect(registry.readRaw(added.id)!.toString()).toBe("roundtrip");
  expect(registry.readText(added.id)).toBe("roundtrip");
});

// Review of PR #907 (codex-review), through the CLI.
test("a plain file over 512 KiB registers with its text readable, and a damaged record is refused with the registry left as it was", async () => {
  const p = project(), big = "b".repeat(600 * 1024);
  const added = JSON.parse((await cli(p, ["source", "add", write(p, "open/big.txt", big), "--json"])).stdout);
  expect(added).toMatchObject({ created: true, text: true });
  expect(new SourceRegistry(join(sourcesDir(p)!, "..")).readText(added.id)).toBe(big);
  const folder = join(sourcesDir(p)!, `src-${added.id.slice(4)}`);
  writeFileSync(join(folder, "meta.json"), "{ damaged");
  const again = await cli(p, ["source", "add", write(p, "open/big2.txt", big)]);
  expect(again.code).not.toBe(0);
  expect(flat(again.stderr)).toContain("cannot be read");
  expect(readFileSync(join(folder, "meta.json"), "utf8")).toBe("{ damaged");
});

test("every origin up to the cap registers through the CLI and the record stays listed as private", async () => {
  const p = project(), bytes = "one source, thirty-six places";
  const first = JSON.parse((await cli(p, ["source", "add", write(p, "secret/o.txt", bytes), "--json"])).stdout);
  const registry = new SourceRegistry(join(sourcesDir(p)!, ".."));
  for (let i = 0; i < 40; i++) registry.add({ bytes: Buffer.from(bytes), kind: "url", origin: `https://example.org/${i}/` + "p".repeat(1900), private: false });
  const rows = JSON.parse((await cli(p, ["source", "list", "--json"])).stdout);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: first.id, private: true });
  expect(rows[0].origins.length).toBe(41);
  const after = JSON.parse((await cli(p, ["source", "add", write(p, "open/o2.txt", bytes), "--json"])).stdout);
  expect(after).toMatchObject({ id: first.id, created: false, private: true });
});
