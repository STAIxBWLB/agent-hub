import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENT_COMPAT_ISSUE_LIMIT, AGENT_COMPAT_ISSUE_TITLE, selectAgentCompatIssue } from "../scripts/agent-compat-issue.ts";

const ROOT = join(import.meta.dir, ".."), SCRIPT = join(ROOT, "scripts/agent-compat-issue.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const bug = { number: 912, title: "Jcode bug", labels: ["bug", "agent-compat"], body: `# ${AGENT_COMPAT_ISSUE_TITLE}\nPublished agent CLI versions ahead of their verified set` };
const tracker = { number: 888, title: AGENT_COMPAT_ISSUE_TITLE, labels: [], body: "original tracking report" };

test("#964 exact title finds the tracker without its label and ignores labelled bug bodies in every order", () => {
  expect(selectAgentCompatIssue([bug, tracker])).toBe(888);
  expect(selectAgentCompatIssue([tracker, bug])).toBe(888);
  expect(selectAgentCompatIssue([bug])).toBeUndefined();
  expect(selectAgentCompatIssue([])).toBeUndefined();
  for (const title of [AGENT_COMPAT_ISSUE_TITLE.toUpperCase(), `${AGENT_COMPAT_ISSUE_TITLE} `, `Re: ${AGENT_COMPAT_ISSUE_TITLE}`]) {
    expect(selectAgentCompatIssue([{ number: 889, title }])).toBeUndefined();
  }
});

test("#964 ambiguous exact titles name every identity and never pick by issue order", () => {
  const other = { number: 999, title: AGENT_COMPAT_ISSUE_TITLE };
  for (const rows of [[bug, tracker, other], [other, tracker, bug]]) {
    expect(() => selectAgentCompatIssue(rows)).toThrow("#888, #999");
  }
});

test("#964 malformed identities and potentially truncated inventories are unknown, not confirmed absence", () => {
  for (const value of [null, {}, "[]", [null], [[]], [{}], [{ number: 0, title: "other" }], [{ number: -1, title: "other" }],
    [{ number: 1.5, title: "other" }], [{ number: "888", title: AGENT_COMPAT_ISSUE_TITLE }], [{ number: 888, title: null }],
    [{ number: 888, title: "" }], [{ number: Number.MAX_SAFE_INTEGER + 1, title: "other" }], [tracker, { number: 912 }], [tracker, tracker]]) {
    expect(() => selectAgentCompatIssue(value)).toThrow();
  }
  const full = Array.from({ length: AGENT_COMPAT_ISSUE_LIMIT }, (_, i) => ({ number: i + 1, title: "unrelated" }));
  expect(() => selectAgentCompatIssue(full)).toThrow("1000-issue limit");
  expect(selectAgentCompatIssue(full.slice(0, -1))).toBeUndefined();
});

async function cli(input: string) {
  const proc = Bun.spawn([process.execPath, SCRIPT], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  proc.stdin.end();
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

test("#964 selector CLI prints only a unique positive id, prints nothing for absence, and fails closed otherwise", async () => {
  expect(await cli(JSON.stringify([bug, tracker]))).toEqual({ code: 0, stdout: "888\n", stderr: "" });
  expect(await cli(JSON.stringify([bug]))).toEqual({ code: 0, stdout: "", stderr: "" });
  for (const input of ["not JSON", "{}", JSON.stringify([tracker, { number: 999, title: AGENT_COMPAT_ISSUE_TITLE }])]) {
    const result = await cli(input);
    expect(result.code).not.toBe(0); expect(result.stdout).toBe(""); expect(result.stderr).toContain("agent-compat:");
    if (input.includes("999")) { expect(result.stderr).toContain("#888"); expect(result.stderr).toContain("#999"); }
  }
}, 20_000);

function workflowStep(): string {
  const workflow = readFileSync(join(ROOT, ".github/workflows/agent-compat.yml"), "utf8");
  const step = workflow.split("- name: Keep the agent-compat issue current")[1];
  if (!step) throw new Error("missing issue maintenance workflow step");
  const lines = step.split("run: |\n")[1]?.split("\n");
  if (!lines) throw new Error("missing issue maintenance commands");
  const commands: string[] = [];
  for (const line of lines) {
    if (line.trim() && !line.startsWith("          ")) break;
    commands.push(line.slice(10));
  }
  return commands.join("\n");
}

async function runWorkflow(ahead: boolean, inventory: unknown, listStatus = 0, raw?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-compat-identity-")); dirs.push(cwd);
  const bin = join(cwd, "bin"), calls = join(cwd, "calls.jsonl"), input = join(cwd, "issues.json");
  mkdirSync(bin); mkdirSync(join(cwd, "scripts"));
  symlinkSync(process.execPath, join(bin, "bun")); symlinkSync(SCRIPT, join(cwd, "scripts/agent-compat-issue.ts"));
  writeFileSync(input, raw ?? JSON.stringify(inventory));
  writeFileSync(join(cwd, "report.md"), "fixture drift report");
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\nimport { appendFileSync, readFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(process.env.COMPAT_CALLS, JSON.stringify(args) + "\\n");\nif (args[0] === "issue" && args[1] === "list") { process.stdout.write(readFileSync(process.env.COMPAT_INPUT, "utf8")); process.exit(Number(process.env.COMPAT_LIST_STATUS)); }\n`, { mode: 0o755 });
  const proc = Bun.spawn(["bash", "-c", workflowStep()], { cwd, env: { ...process.env, HOME: cwd, GH_TOKEN: "fixture-only", PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    AHEAD: String(ahead), COMPAT_CALLS: calls, COMPAT_INPUT: input, COMPAT_LIST_STATUS: String(listStatus) }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const commands = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
  return { code, stdout, stderr, commands };
}

test("#964 actual workflow creates, updates and closes only its exact-title identity, preserving no-match no-op", async () => {
  const updated = await runWorkflow(true, [bug, tracker]);
  expect(updated.code).toBe(0);
  expect(updated.commands[0]).toEqual(["issue", "list", "--state", "open", "--limit", "1000", "--json", "number,title"]);
  expect(updated.commands).toContainEqual(["issue", "edit", "888", "--body-file", "report.md"]);
  expect(updated.commands.some(args => args.includes("912"))).toBe(false);
  const closed = await runWorkflow(false, [tracker, bug]);
  expect(closed.code).toBe(0);
  expect(closed.commands).toContainEqual(["issue", "close", "888", "--comment", "fixture drift report"]);
  const created = await runWorkflow(true, [bug]);
  expect(created.code).toBe(0);
  expect(created.commands).toContainEqual(["issue", "create", "--title", AGENT_COMPAT_ISSUE_TITLE, "--label", "agent-compat", "--body-file", "report.md"]);
  const none = await runWorkflow(false, [bug]);
  expect(none.code).toBe(0); expect(none.commands).toHaveLength(1);
}, 20_000);

test("#964 actual workflow does not mutate labels or issues after ambiguous, unreadable or malformed inventory", async () => {
  const full = Array.from({ length: AGENT_COMPAT_ISSUE_LIMIT }, (_, i) => ({ number: i + 1, title: "unrelated" }));
  for (const ahead of [true, false]) {
    const ambiguous = await runWorkflow(ahead, [tracker, { number: 999, title: AGENT_COMPAT_ISSUE_TITLE }]);
    expect(ambiguous.code).not.toBe(0); expect(ambiguous.commands).toHaveLength(1);
    expect(ambiguous.stderr).toContain("#888"); expect(ambiguous.stderr).toContain("#999");
    for (const result of [await runWorkflow(ahead, [tracker], 1), await runWorkflow(ahead, [], 0, "invalid JSON"), await runWorkflow(ahead, full)]) {
      expect(result.code).not.toBe(0); expect(result.commands).toHaveLength(1);
    }
  }
}, 20_000);
