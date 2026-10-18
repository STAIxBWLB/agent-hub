import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectTerminals, type TerminalBinding } from "../src/cli/terminal-recovery.ts";
import { makeRecoveryDriver } from "../src/cli/upgrade-runtime.ts";
import type { RecoveryOperation } from "../src/cli/upgrade.ts";
import { personEnv } from "../src/hub/child-process.ts";

// Compare public CLI behavior, not the wording of the adapter's internal parser in isolation.
test("#451 R3 Qwen conductor overrides retain the original CLI refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-r3-conductor-"));
  try {
    const env = { ...personEnv(process.env), AGENTHUB_HOME: join(root, "home"), AGENTHUB_PEER_ID: "codex" };
    const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/cli/main.js"), "qwen", "--model", "ignored"], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ahub: conductor starts accept no launch overrides; use ahub qwen");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#451 R3 Pi terminal files come from terminal observation, never launch args", async () => {
  const root = "/synthetic/r3-terminal", sessionId = "pi-session";
  for (const observed of ["top", "nested", "none"] as const) {
    const terminal = { handle: "pi-terminal", incarnationId: "pi-incarnation", worktreeId: "pi-worktree", worktreePath: root,
      connected: true, orphaned: false, agentIdentity: "pi", sessionId,
      args: { sessionFile: "/synthetic/requested.jsonl" },
      ...(observed === "top" ? { sessionFile: "/synthetic/observed-top.jsonl", sessionPath: "/synthetic/observed-path.jsonl" } : {}),
      ...(observed !== "none" ? { session: { file: "/synthetic/observed-nested.jsonl", path: "/synthetic/observed-nested-path.jsonl" } } : {}),
    };
    const result = await inspectTerminals(root, { pi: sessionId }, { packageEntrypoint: "/synthetic/main.js", runner: async argv => {
      if (argv[1] === "list") return { result: { terminals: [terminal] } };
      if (argv[1] === "show") return { result: { terminal } };
      throw new Error(`unexpected terminal read ${argv.join(" ")}`);
    } });
    expect(result.manualRequired).toBe(false);
    expect(result.byPeer.pi?.sessionFile).toBe(observed === "top" ? "/synthetic/observed-top.jsonl" : observed === "nested" ? "/synthetic/observed-nested.jsonl" : undefined);
    expect(result.byPeer.pi?.sessionFile).not.toBe("/synthetic/requested.jsonl");
  }
});

test("#451 R3 Pi TUI bindings retain the captured Claude config directory in target startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-r3-config-env-")), stateDir = join(root, "state");
  try {
    mkdirSync(stateDir);
    const id = "parity-operation", project = { id: "parity-project", root, stateDir, pid: null, instanceId: null, basePort: 4600 };
    const configDir = join(root, "captured-claude-config"), codexHome = join(root, "unrelated-codex-home");
    const launch = { packageEntrypoint: "/synthetic/main.js", command: "unused", argv: [], env: { CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: codexHome } };
    const binding: TerminalBinding = { peer: "pi", projectRoot: root, handle: "pi-terminal", incarnationId: "pi-incarnation", worktreeId: "pi-worktree", sessionId: "pi-session", launch, launchMetadata: launch };
    writeFileSync(join(stateDir, "restart.json"), JSON.stringify({ projectId: project.id, projectRoot: root, operationId: id }));
    const op = { id, targetRoot: "/synthetic/target", plan: { projects: [{ project, terminals: [binding] }] } } as RecoveryOperation;
    const environments: NodeJS.ProcessEnv[] = [];
    const driver = makeRecoveryDriver(async (_argv, options) => {
      environments.push(options?.env ?? {});
      return { code: 0, stdout: "", stderr: "" };
    });
    await driver.start(project, op);
    expect(environments).toHaveLength(1);
    expect(environments[0]?.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(environments[0]?.CODEX_HOME).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
