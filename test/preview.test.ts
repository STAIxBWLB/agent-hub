import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, linkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planInit, init } from "../src/cli/init.ts";
import { launcherPreview } from "../src/cli/preview.ts";
import { buildLaunch, buildKimiLaunch, claudeObservationHooks } from "../src/cli/launch.ts";
import { buildPiLaunch } from "../src/pi/launch.ts";

function tree(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (root: string, prefix: string) => {
    for (const name of readdirSync(root).sort()) {
      const file = join(root, name), path = prefix + name;
      const stat = lstatSync(file);
      found[path] = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : createHash("sha256").update(readFileSync(file)).digest("hex");
      if (stat.isDirectory()) walk(file, path + "/");
    }
  };
  walk(dir, ""); return found;
}

test("init preview is read-only and exactly lists apply changes across legacy aliases", () => {
  for (const alias of ["none", "hardlink", "claude-symlink", "agents-symlink", "legacy-only", "legacy-user"]) {
    const dir = mkdtempSync(join(tmpdir(), "ahub-plan-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# user\n");
      const legacy = "<!-- AGENT_HUB:BEGIN -->\nold\n<!-- AGENT_HUB:END -->\n";
      if (alias === "hardlink") linkSync(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md"));
      if (alias === "claude-symlink") symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
      if (alias === "agents-symlink") {
        rmSync(join(dir, "AGENTS.md")); writeFileSync(join(dir, "CLAUDE.md"), "# user\n");
        symlinkSync("CLAUDE.md", join(dir, "AGENTS.md"));
      }
      if (alias.startsWith("legacy")) writeFileSync(join(dir, "CLAUDE.md"), (alias === "legacy-user" ? "# user\n\n" : "") + legacy);
      const before = tree(dir), plan = planInit(dir);
      expect(tree(dir)).toEqual(before);
      expect(plan.some(change => "next" in change)).toBe(false);
      expect(init(dir)).toEqual(plan.map(change => change.path));
      expect(planInit(dir)).toEqual([]);
      if (alias === "hardlink") expect(lstatSync(join(dir, "AGENTS.md")).ino).toBe(lstatSync(join(dir, "CLAUDE.md")).ino);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("default previews match native builders with explicit dynamic placeholders", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-launch-plan-")), state = join(dir, ".agenthub/state");
  try {
    const codex = launcherPreview("codex", [], dir, state, false);
    expect(codex.args).toEqual(buildLaunch("codex", [], { unattended: false, proxyUrl: "[unresolved]" }).args);
    expect(codex.unresolved.length).toBeGreaterThan(0);
    const kimi = launcherPreview("kimi", [], dir, state, false);
    expect(kimi.args).toEqual(buildKimiLaunch(["kimi", "acp"]).args);
    const claude = launcherPreview("claude", ["--settings", "{}"], dir, state, false);
    const nativeClaude = buildLaunch("claude", ["--settings", "{}"], { preview: true, unattended: false, facts: claudeObservationHooks({}, { script: join(import.meta.dir, "../src/cli/facts-hook.ts"), stateDir: state }) });
    expect(claude.args).toEqual(nativeClaude.args);
    const tee = launcherPreview("claude", [], dir, state, false);
    expect(tee.args.slice(0, 3)).toEqual([...nativeClaude.args.slice(0, 2), "--settings"]);
    expect(JSON.parse(tee.settings!).statusLine.command).toContain("statusline-tee.ts");
    for (const mode of ["headless", "tui"] as const) {
      const pi = launcherPreview("pi", ["--mode", mode], dir, state, false);
      expect(pi.args).toEqual(buildPiLaunch({ stateDir: state, mode, backend: "auto", relay: { url: "[unresolved]", token: "[unresolved]", models: ["hub/auto", "mlx/fast", "dgx/coding", "dgx/fast"].map(id => ({ id })) }, tools: [], preamble: "[redacted]" }, {}, join(import.meta.dir, "../src/pi/extension.ts"), "[unresolved]", "[unresolved]").args);
      expect(pi.envNames).toContain("AGENTHUB_PI_RELAY_TOKEN");
    }
    expect(tree(dir)).toEqual({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI previews neither create state nor execute configured natives, and redact canaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-preview-cli-"));
  try {
    const project = join(dir, "project"), home = join(dir, "home");
    mkdirSync(join(project, ".agenthub"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(home);
    const canary = "previewCredentialCanary";
    const executable = join(dir, canary);
    writeFileSync(executable, "#!/bin/sh\ntouch " + join(dir, "native-was-run") + "\n", { mode: 0o700 });
    writeFileSync(join(project, ".agenthub/config.local.json"), JSON.stringify({ codex_bin: executable, kimi_cmd: [executable, canary], pi: { cmd: [executable, canary], enabled: true } }));
    writeFileSync(join(project, ".claude/settings.json"), JSON.stringify({ statusLine: { command: "echo " + canary } }));
    const before = tree(dir);
    for (const args of [
      ["init", "--dry-run", "--json"],
      ["claude", "--print-command", "--settings", JSON.stringify({ token: canary }), canary, "--token=" + canary],
      ["claude", "--dry-run"],
      ["codex", "--print-command", "-c", "password=" + canary],
      ["kimi", "--print-command", "--model", canary],
      ["pi", "--dry-run", "--mode", "headless", "--session-id", canary],
      ["pi", "--print-command", "--mode", "tui", "--model", canary],
    ]) {
      const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", project, ...args], { cwd: project, env: { PATH: process.env.PATH, HOME: home, AGENTHUB_HOME: join(home, "hub"), AGENTHUB_SECRET: canary, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      const output = child.stdout.toString() + child.stderr.toString();
      expect(output).not.toContain(canary);
      expect(child.exitCode).toBe(0);
      expect(tree(dir)).toEqual(before);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);


test("advisory sweep preview shares actual native hook selection and reports conditional runtime env names safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-observation-preview-"));
  const originalInstance = process.env.AGENTHUB_INSTANCE_ID;
  const originalLaunch = process.env.AGENTHUB_LAUNCH_ID;
  const canary = "identity-value-must-stay-private";
  try {
    process.env.AGENTHUB_INSTANCE_ID = canary;
    process.env.AGENTHUB_LAUNCH_ID = canary;
    mkdirSync(join(dir, ".agenthub"));
    writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ coordination: "advisory", task_sweep: { enabled: true } }));
    const stateDir = join(dir, ".agenthub/state");
    const before = tree(dir);
    const preview = launcherPreview("claude", [], dir, stateDir, false);
    const facts = claudeObservationHooks({ coordination: "advisory", task_sweep: { enabled: true } }, { script: join(import.meta.dir, "../src/cli/facts-hook.ts"), stateDir });
    const actual = buildLaunch("claude", [], { unattended: false, statusLine: { script: join(import.meta.dir, "../src/cli/statusline-tee.ts"), stateDir }, facts, preview: true });
    expect(JSON.parse(preview.settings!).hooks).toEqual(JSON.parse(actual.args[actual.args.indexOf("--settings") + 1]!).hooks);
    expect(() => launcherPreview("claude", ["--settings", canary], dir, stateDir, false)).toThrow("permission hook must be installed");
    for (const [tool, args] of [["claude", []], ["codex", []]] as const) {
      const value = launcherPreview(tool, [...args], dir, stateDir, false);
      expect(value.envNames).toEqual(expect.arrayContaining(["AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID"]));
      expect(value.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({ field: "env.AGENTHUB_INSTANCE_ID" }), expect.objectContaining({ field: "env.AGENTHUB_LAUNCH_ID" })]));
      expect(JSON.stringify(value)).not.toContain(canary);
    }
    delete process.env.AGENTHUB_INSTANCE_ID;
    delete process.env.AGENTHUB_LAUNCH_ID;
    expect(launcherPreview("claude", [], dir, stateDir, false).envNames).toContain("AGENTHUB_LAUNCH_ID");
    expect(launcherPreview("pi", ["--mode", "tui"], dir, stateDir, false).envNames).not.toContain("AGENTHUB_INSTANCE_ID");
    expect(tree(dir)).toEqual(before);
  } finally {
    if (originalInstance === undefined) delete process.env.AGENTHUB_INSTANCE_ID; else process.env.AGENTHUB_INSTANCE_ID = originalInstance;
    if (originalLaunch === undefined) delete process.env.AGENTHUB_LAUNCH_ID; else process.env.AGENTHUB_LAUNCH_ID = originalLaunch;
    rmSync(dir, { recursive: true, force: true });
  }
});
