import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, planInit } from "../src/cli/init.ts";
import { loadPacks, packOverrides, parsePack } from "../src/hub/packs.ts";
import { loadRoleCatalog } from "../src/hub/roles.ts";
import { resolveProfile } from "../src/hub/profiles.ts";
import { criterionId } from "../src/hub/workflow.ts";

// #513a: a domain pack is data (a profile, the roles it expects, a rubric with #507 criterion ids, and display-only checks). Project packs are read from
// .agenthub/roles/<name>.pack.json, `ahub init --profile <pack>` previews what it adds by id, and nothing here selects or runs a command.
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_DELIVERY_ONLY", "NO_COLOR"];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const project = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-pack-")); dirs.push(dir); mkdirSync(join(dir, ".agenthub/roles"), { recursive: true }); return dir; };
const pack = (over: Record<string, unknown> = {}) => ({
  name: "editorial", profile: "writing", summary: "Editing pass with a terminology check.", roles: ["fact-checker"],
  rubric: [{ id: "AC1", text: "Every claim names its source.", required: true }, { id: "style-1", text: "Terms match the glossary.", required: false }],
  checks: [{ id: "glossary", note: "Run the glossary script over the draft and read its list of mismatches." }], ...over,
});
const write = (dir: string, name: string, value: unknown) => writeFileSync(join(dir, ".agenthub/roles", `${name}.pack.json`), typeof value === "string" ? value : JSON.stringify(value, null, 2));
const text = (value: unknown) => JSON.stringify(value);

test("a pack parses into its profile, roles, rubric and checks, and the rubric ids are #507 criterion ids", () => {
  const parsed = parsePack(text(pack()), "editorial", "project");
  expect(parsed).toMatchObject({ name: "editorial", profile: "writing", roles: ["fact-checker"], layer: "project" });
  expect(parsed.rubric.map(item => item.id)).toEqual(["AC1", "style-1"]);
  expect(parsed.rubric.every(item => criterionId(item.id))).toBe(true);
  expect(parsed.checks).toEqual([{ id: "glossary", note: "Run the glossary script over the draft and read its list of mismatches." }]);
});

test("a pack is refused for each way it could carry more than data: unknown fields, a runnable check, a profile's name, a bad criterion id, oversize and control characters", () => {
  const bad: [string, unknown, string?][] = [
    ["extra top-level field", pack({ command: "rm -rf /" })],
    ["a check with a command field", pack({ checks: [{ id: "x", note: "n", command: "bun test" }] })],
    ["a check with a command in place of a note", pack({ checks: [{ id: "x", command: "bun test" }] })],
    ["a pack named like a profile", pack({ name: "writing" }), "writing"],
    ["a name that differs from the file", pack({ name: "other" })],
    ["an unknown profile", pack({ profile: "dev2" })],
    ["a criterion id with a space", pack({ rubric: [{ id: "bad id", text: "t", required: true }] })],
    ["a criterion id starting with a digit", pack({ rubric: [{ id: "1AC", text: "t", required: true }] })],
    ["duplicate criterion ids", pack({ rubric: [{ id: "AC1", text: "a", required: true }, { id: "AC1", text: "b", required: true }] })],
    ["an empty rubric", pack({ rubric: [] })],
    ["more than 12 criteria", pack({ rubric: Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, text: "t", required: true })) })],
    ["rubric text over 300 characters", pack({ rubric: [{ id: "AC1", text: "x".repeat(301), required: true }] })],
    ["a non-boolean required flag", pack({ rubric: [{ id: "AC1", text: "t", required: "yes" }] })],
    ["more than 8 checks", pack({ checks: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, note: "n" })) })],
    ["duplicate check ids", pack({ checks: [{ id: "a", note: "n" }, { id: "a", note: "m" }] })],
    ["a control character in text", pack({ summary: "bad\u0007bell" })],
    ["a non-ASCII punctuation character in text", pack({ summary: "smart \u201cquotes\u201d" })],
    ["a role id that is not an id", pack({ roles: ["Fact Checker"] })],
    ["more than 8 roles", pack({ roles: Array.from({ length: 9 }, (_, i) => `role-${i}`) })],
    ["duplicate roles", pack({ roles: ["fact-checker", "fact-checker"] })],
  ];
  for (const [label, value, stem] of bad) expect(() => parsePack(text(value), stem ?? "editorial", "project"), label).toThrow();
  expect(() => parsePack("{not json", "editorial", "project")).toThrow("not valid JSON");
  expect(() => parsePack(text(pack()) + " ".repeat(8200), "editorial", "project")).toThrow("invalid pack size");
  expect(() => parsePack(text(pack()), "Bad Name", "project")).toThrow();
  const { checks: _c, ...withoutChecks } = pack();
  expect(() => parsePack(text(withoutChecks), "editorial", "project")).toThrow("needs name");
});

test("project packs load from .agenthub/roles, the role catalog ignores them, and a pack that names an unknown role is refused with the reason", () => {
  const dir = project();
  write(dir, "editorial", pack());
  write(dir, "ghost-pack", pack({ name: "ghost-pack", roles: ["no-such-role"] }));
  write(dir, "broken", "{nope");
  const loaded = loadPacks(dir);
  expect([...loaded.packs.keys()]).toEqual(["editorial"]);
  expect(loaded.errors.map(error => error.id).sort()).toEqual(["broken", "ghost-pack"]);
  expect(loaded.errors.find(error => error.id === "ghost-pack")!.reason).toContain("no-such-role");
  expect(JSON.stringify(loaded.errors)).not.toContain("rm -rf");
  expect(loadRoleCatalog(dir).errors).toEqual([]);
  expect(loadPacks(undefined).packs.size).toBe(0);
});

test("a project role file can satisfy a pack's role, and a pack file that is a link or a hardlink is refused", () => {
  const dir = project();
  const role = readFileSync(join(import.meta.dir, "../templates/roles/research/fact-checker.md"), "utf8").replace(/^id: fact-checker$/m, "id: house-editor").replace(/^name: .*$/m, "name: House editor");
  writeFileSync(join(dir, ".agenthub/roles/house-editor.md"), role);
  write(dir, "own", pack({ name: "own", roles: ["house-editor"] }));
  expect(loadPacks(dir).packs.has("own")).toBe(true);
  writeFileSync(join(dir, "real.json"), text(pack({ name: "linked" })));
  symlinkSync(join(dir, "real.json"), join(dir, ".agenthub/roles/linked.pack.json"));
  writeFileSync(join(dir, "hard.json"), text(pack({ name: "hard" })));
  linkSync(join(dir, "hard.json"), join(dir, ".agenthub/roles/hard.pack.json"));
  const loaded = loadPacks(dir);
  expect(loaded.packs.has("linked")).toBe(false);
  expect(loaded.packs.has("hard")).toBe(false);
  expect(loaded.errors.map(error => error.id).sort()).toEqual(["hard", "linked"]);
});

test("a pack directory that is a symlink is refused and no pack is read from it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-pack-link-")); dirs.push(dir);
  mkdirSync(join(dir, ".agenthub")); mkdirSync(join(dir, "elsewhere"));
  writeFileSync(join(dir, "elsewhere/editorial.pack.json"), text(pack()));
  symlinkSync(join(dir, "elsewhere"), join(dir, ".agenthub/roles"));
  const loaded = loadPacks(dir);
  expect(loaded.packs.size).toBe(0);
  expect(loaded.errors).toEqual([{ id: "project", reason: "project pack directory unavailable or unsafe" }]);
});

test("more than 16 project packs are refused whole, not truncated", () => {
  const dir = project();
  for (let i = 0; i < 17; i++) write(dir, `p${i}`, pack({ name: `p${i}` }));
  const loaded = loadPacks(dir);
  expect(loaded.packs.size).toBe(0);
  expect(loaded.errors).toEqual([{ id: "project", reason: "project pack directory unavailable or unsafe" }]);
});

test("a pack's overrides are the rubric as the review checklist (ids first, optional marked) and the checks as display examples, and the profile accepts them", () => {
  const parsed = parsePack(text(pack()), "editorial", "project"), overrides = packOverrides(parsed);
  expect(overrides.review_checklist).toEqual(["AC1: Every claim names its source.", "style-1 (optional): Terms match the glossary.", "{check}"]);
  expect(overrides.example_checks).toEqual(["glossary: Run the glossary script over the draft and read its list of mismatches."]);
  const profile = resolveProfile("writing", overrides);
  expect(profile.review_checklist).toEqual(overrides.review_checklist as string[]);
  expect(profile.example_checks).toHaveLength(1);
  expect(Object.keys(overrides).sort()).toEqual(["example_checks", "review_checklist"]);
  expect(packOverrides(parsePack(text(pack({ checks: [] })), "editorial", "project")).example_checks).toBeUndefined();
});

test("init --profile <pack> previews by ids, writes nothing, and the apply matches the preview", () => {
  const dir = project(); write(dir, "editorial", pack());
  const before = existsSync(join(dir, ".agenthub/config.json"));
  const preview = planInit(dir, "editorial");
  const config = preview.find(row => row.path === join(dir, ".agenthub/config.json"))!;
  expect(config.action).toBe("create");
  expect(config.reason).toContain("pack editorial (profile writing)");
  expect(config.reason).toContain("rubric AC1, style-1");
  expect(config.reason).toContain("checks glossary");
  expect(config.reason).toContain("expects roles fact-checker");
  expect(JSON.stringify(preview)).not.toContain("Every claim names its source");
  expect(JSON.stringify(preview)).not.toContain("glossary script");
  expect(existsSync(join(dir, ".agenthub/config.json"))).toBe(before);
  const written = init(dir, "editorial");
  expect(written.sort()).toEqual(preview.map(row => row.path).sort());
  const saved = JSON.parse(readFileSync(join(dir, ".agenthub/config.json"), "utf8"));
  expect(saved.profile).toBe("writing");
  expect(saved.profile_overrides.review_checklist[0]).toBe("AC1: Every claim names its source.");
  expect(init(dir, "editorial")).toEqual([]);
  expect(init(dir, "writing")).toEqual([]);
});

test("init --profile <pack> on a project that already has a config adds the overrides once, keeps the rest of the file, and a second apply is a no-op", () => {
  const dir = project(); write(dir, "editorial", pack());
  init(dir, "writing");
  const base = JSON.parse(readFileSync(join(dir, ".agenthub/config.json"), "utf8"));
  expect(base.profile_overrides).toBeUndefined();
  const preview = planInit(dir, "editorial");
  expect(preview.find(row => row.path === join(dir, ".agenthub/config.json"))).toMatchObject({ action: "modify" });
  init(dir, "editorial");
  const next = JSON.parse(readFileSync(join(dir, ".agenthub/config.json"), "utf8"));
  expect({ ...next, profile_overrides: undefined }).toEqual({ ...base, profile_overrides: undefined });
  expect(next.profile_overrides.example_checks).toHaveLength(1);
  expect(init(dir, "editorial")).toEqual([]);
});

test("init --profile <pack> refuses a pack whose profile differs from the project's, existing different overrides, and an unknown name with what it knows", () => {
  const dir = project(); write(dir, "editorial", pack()); write(dir, "ghost-pack", pack({ name: "ghost-pack", roles: ["no-such-role"] }));
  init(dir, "research");
  expect(() => planInit(dir, "editorial")).toThrow("init profile differs");
  const other = project(); write(other, "editorial", pack());
  init(other, "writing");
  const config = JSON.parse(readFileSync(join(other, ".agenthub/config.json"), "utf8"));
  writeFileSync(join(other, ".agenthub/config.json"), JSON.stringify({ ...config, profile_overrides: { example_checks: ["my own check"] } }));
  expect(() => planInit(other, "editorial")).toThrow("differ from pack editorial");
  expect(readFileSync(join(other, ".agenthub/config.json"), "utf8")).toContain("my own check");
  const third = project(); write(third, "ghost-pack", pack({ name: "ghost-pack", roles: ["no-such-role"] }));
  let message = "";
  try { planInit(third, "ghost-pack"); } catch (error) { message = (error as Error).message; }
  expect(message).toContain('unknown profile or pack "ghost-pack"');
  expect(message).toContain("no-such-role");
  expect(message).toContain("profiles: dev, research, writing, general");
  expect(() => planInit(third, "nonsense")).toThrow('unknown profile or pack "nonsense"');
});

test("shipped profiles still work by name and an unknown profile is still refused", () => {
  const dir = project();
  expect(planInit(dir, "research").some(row => row.path === join(dir, ".agenthub/config.json"))).toBe(true);
  expect(planInit(dir).some(row => row.path === join(dir, ".agenthub/config.json"))).toBe(true);
  expect(() => planInit(dir, "../../etc/passwd")).toThrow("unknown profile or pack");
});

test("the real CLI previews and applies a pack, and refuses an unknown name with its list", async () => {
  const dir = project(); write(dir, "editorial", pack());
  const run = async (...args: string[]) => {
    // `ahub init` is a person command: the child carries none of this shell's agent markers (the same list the other CLI tests clear).
    const env: Record<string, string | undefined> = { ...process.env, AGENTHUB_HOME: join(dir, "home") };
    for (const name of MARKERS) delete env[name];
    const child = Bun.spawn([process.execPath, CLI, "init", ...args], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  const dry = await run("--profile", "editorial", "--dry-run", "--json");
  expect(dry.code, dry.stderr).toBe(0);
  const rows = JSON.parse(dry.stdout) as { path: string; reason: string }[];
  expect(rows.find(row => row.path.endsWith(".agenthub/config.json"))!.reason).toContain("pack editorial");
  expect(existsSync(join(dir, ".agenthub/config.json"))).toBe(false);
  const bad = await run("--profile", "nope", "--dry-run");
  expect(bad.code).not.toBe(0);
  expect(bad.stdout + bad.stderr).toContain("unknown profile or pack");
}, 30_000);

test("only <name>.pack.json files are packs: other json files in the roles directory are not read, and a CR in a pack is refused", () => {
  const dir = project();
  write(dir, "editorial", pack());
  writeFileSync(join(dir, ".agenthub/roles/notes.json"), text(pack({ name: "notes" })));
  writeFileSync(join(dir, ".agenthub/roles/stray.pack"), text(pack({ name: "stray" })));
  writeFileSync(join(dir, ".agenthub/roles/crlf.pack.json"), text(pack({ name: "crlf" })).replace("{", "{\r\n"));
  const loaded = loadPacks(dir);
  expect([...loaded.packs.keys()]).toEqual(["editorial"]);
  expect(loaded.errors).toEqual([{ id: "crlf", reason: "invalid pack size, encoding or file name" }]);
  expect(() => parsePack(text(pack()).replace("{", "{\r\n"), "editorial", "project")).toThrow("invalid pack size, encoding or file name");
});

test("a config that already carries this pack's overrides is not rewritten: the apply is a no-op and the preview names no row for it", () => {
  const dir = project(); write(dir, "editorial", pack());
  init(dir, "editorial");
  const bytes = readFileSync(join(dir, ".agenthub/config.json"), "utf8");
  expect(planInit(dir, "editorial").some(row => row.path === join(dir, ".agenthub/config.json"))).toBe(false);
  expect(init(dir, "editorial")).toEqual([]);
  expect(readFileSync(join(dir, ".agenthub/config.json"), "utf8")).toBe(bytes);
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ ...JSON.parse(bytes), batch_ms: 1 }, null, 2) + "\n");
  expect(JSON.parse(readFileSync(join(dir, ".agenthub/config.json"), "utf8")).batch_ms).toBe(1);
  expect(planInit(dir, "editorial").some(row => row.path === join(dir, ".agenthub/config.json"))).toBe(false);
});
