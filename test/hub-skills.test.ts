import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubSkillsPresent } from "../src/cli/setup.ts";

const names = ["ahub-status", "ahub-manage", "ahub-use", "ahub"];
const root = join(import.meta.dir, "../plugins/agent-hub/skills");

function personStepsValid(text: string): boolean {
  const blocks = [...text.matchAll(/```(?:sh|bash)?\n([\s\S]*?)\n```/g)];
  return blocks.every(match => !/<[^>]+>/.test(match[1]!) && match[1]!.split("\n").every(line => line.startsWith("cd ")));
}

test("plugin skills have frontmatter and constrain person steps", () => {
  for (const name of names) {
    const text = readFileSync(join(root, name, "SKILL.md"), "utf8");
    expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n`));
    expect(personStepsValid(text)).toBe(true);
    expect(text).toContain("code block");
    expect(text).toContain("success");
    if (name === "ahub") expect(text).toContain("disable-model-invocation: true");
  }
  expect(personStepsValid("```sh\ncd /tmp && ahub task show <id>\n```" )).toBe(false);
  expect(personStepsValid("```sh\nahub status\n```" )).toBe(false);
  expect(personStepsValid("```sh\ncd /tmp && ahub status\n```" )).toBe(true);
});

test("Claude plugin skill presence uses its installed tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-skills-"));
  try {
    const plugins = [{ id: "agent-hub@agent-hub", scope: "user", installPath: dir }];
    expect(hubSkillsPresent(plugins)).toBe(false);
    for (const name of names) {
      const skill = join(dir, "skills", name);
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), "fixture");
    }
    expect(hubSkillsPresent(plugins)).toBe(true);
    expect(hubSkillsPresent([{ ...plugins[0]!, scope: "project" }])).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("status guidance distinguishes CLI, daemon and the actual session server", () => {
  const text = readFileSync(join(root, "ahub-status", "SKILL.md"), "utf8");
  for (const evidence of ["ahub version", "ahub status --json", "claude plugin list --json", "server.js", "process table", "plugin manifest", "before an upgrade", "ahub doctor --json", "ahub roster --json"]) expect(text).toContain(evidence);
});

test("doctor reports installed and missing Claude plugin skills", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-skills-doctor-"));
  try {
    const bin = join(dir, "bin"), home = join(dir, "home"), plugin = join(dir, "plugin");
    mkdirSync(bin); mkdirSync(home); mkdirSync(plugin);
    mkdirSync(join(dir, ".agenthub"));
    writeFileSync(join(dir, ".agenthub/config.json"), "{}");
    const inventory = JSON.stringify([{ id: "agent-hub@agent-hub", scope: "user", version: "0.45.0", installPath: plugin }]);
    for (const name of ["bun", "claude", "codex", "kimi", "jcode", "qwen", "agy", "pi", "amem"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\ncase "$1" in --version) echo fixture;; plugin) echo '${inventory}';; esac\n`, { mode: 0o755 });
    }
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex"), AGENTHUB_HOME: join(dir, "hub"), AMEM_HOME: join(dir, "mem"), PATH: `${bin}:/usr/bin:/bin`, AGENTHUB_OMNIROUTE_URL: "http://127.0.0.1:9/v1" };
    for (const key of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "CLAUDECODE", "CODEX_THREAD_ID"]) delete env[key as keyof typeof env];
    async function row() {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "doctor", "--json"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
      const [output] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return (JSON.parse(output) as { name: string; level: string; detail: string }[]).find(item => item.name === "hub skills")!;
    }
    expect((await row()).detail).toContain("claude plugin uninstall agent-hub@agent-hub --scope user && ahub setup");
    for (const name of names) { const skill = join(plugin, "skills", name); mkdirSync(skill, { recursive: true }); writeFileSync(join(skill, "SKILL.md"), "fixture"); }
    expect(await row()).toMatchObject({ level: "ok", detail: "Claude plugin skills present" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
