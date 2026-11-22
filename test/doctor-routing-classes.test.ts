import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const template = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8");
const roots: string[] = [];

/** A fixture project with the roster and roles the row reads, and either its own routing.toml or none at all (the shipped default). */
function project(roster: Record<string, boolean>, peers?: readonly string[]): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "ahub-routing-classes-"));
  roots.push(dir);
  const bin = join(dir, "bin"), home = join(dir, "home");
  mkdirSync(bin); mkdirSync(home); mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ roster, roles: Object.fromEntries(Object.keys(roster).map(peer => [peer, ["implementer"]])) }));
  if (peers) writeFileSync(join(dir, ".agenthub", "routing.toml"), template.replace(/\[classes\.implement\]\npeers = \[[^\]]*\]/, `[classes.implement]\npeers = ${JSON.stringify(peers)}`));
  const inventory = JSON.stringify([{ id: "agent-hub@agent-hub", scope: "user", version: "fixture", installPath: join(dir, "plugin") }]);
  for (const name of ["bun", "claude", "codex", "kimi", "jcode", "qwen", "agy", "pi", "amem"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\ncase "$1" in --version) echo fixture;; plugin) echo '${inventory}';; esac\n`, { mode: 0o755 });
  }
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(dir, "claude"), AGENTHUB_HOME: join(dir, "hub"), AMEM_HOME: join(dir, "mem"), PATH: `${bin}:/usr/bin:/bin`, AGENTHUB_OMNIROUTE_URL: "http://127.0.0.1:9/v1" };
  // The row reads the roster and routing only, so every host and session variable the runner may carry is cleared.
  for (const key of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "CLAUDECODE", "CODEX_THREAD_ID", "CODEX_HOME", "KIMI_CODE_HOME", "QWEN_HOME", "JCODE_HOME", "PI_CODING_AGENT_DIR"]) delete env[key as keyof typeof env];
  return { dir, env };
}

async function routingRow(fixture: { dir: string; env: NodeJS.ProcessEnv }): Promise<{ name: string; level: string; detail: string }> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "doctor", "--json"], { cwd: fixture.dir, env: fixture.env, stdout: "pipe", stderr: "pipe" });
  const [output] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return (JSON.parse(output) as { name: string; level: string; detail: string }[]).find(item => item.name === "routing classes")!;
}

test("routing classes warns for a rostered implementer that no class list names", async () => {
  try {
    const missing = project({ jcode: true, codex: true }, ["codex"]);
    const warned = await routingRow(missing);
    expect(warned.level).toBe("warn");
    expect(warned.detail).toContain("jcode can implement but no [classes.*].peers list names it");
    expect(warned.detail).toContain("the hub never offers it a task automatically");
    expect(warned.detail).toContain(join(missing.dir, ".agenthub", "routing.toml"));
    expect(warned.detail).toContain("[classes.implement].peers");
    expect(warned.detail).not.toContain("codex can implement");

    const listed = project({ jcode: true, codex: true }, ["codex", "jcode"]);
    const ok = await routingRow(listed);
    expect(ok.level).toBe("ok");
    expect(ok.detail).toBe("every rostered implementer is in a class peer list");

    // A peer the person took off the roster is not routed work anyway, so it is not reported.
    const offRoster = project({ jcode: false, codex: true }, ["codex"]);
    expect((await routingRow(offRoster)).level).toBe("ok");

    // No routing.toml: the shipped default is what the loader read, and it names no jcode.
    const absent = project({ jcode: true }, undefined);
    const unshipped = await routingRow(absent);
    expect(unshipped.level).toBe("warn");
    expect(unshipped.detail).toContain("no such file yet, so the shipped default is in use");
  } finally { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }
}, 60_000);
