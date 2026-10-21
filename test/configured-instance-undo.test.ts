import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { repoOf, snapshot, Turns } from "../src/hub/snapshots.ts";

test("CLI undo binds the current project catalog with configured and Codex worktree instances together", async () => {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-configured-undo-"))), project = join(base, "project"), home = join(base, "home");
  mkdirSync(project); mkdirSync(home);
  try {
    const git = (...args: string[]) => { const result = hubGitSync(["-C", project, ...args], { encoding: "utf8" }); if (result.status) throw new Error(String(result.stderr)); };
    git("init", "-q"); writeFileSync(join(project, ".gitignore"), ".agenthub/\n.worktrees/\n"); writeFileSync(join(project, "owned.txt"), "before\n");
    git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    const executionCwd = join(project, ".worktrees", "codex-worker"); git("worktree", "add", "-b", "worker", executionCwd, "HEAD");
    mkdirSync(join(project, ".agenthub", "state"), { recursive: true });
    writeFileSync(join(project, ".agenthub", "config.local.json"), JSON.stringify({ adapters: { fixture: { transport: "acp", command: "fixture-only", displayName: "Fixture", roles: ["verifier"] } }, instances: { "fixture-reader": { kind: "fixture", roles: ["verifier"] }, "codex-worker": { kind: "codex", roles: ["implementer"], worktree: executionCwd } }, memory: { enabled: false } }));
    const repo = repoOf(executionCwd)!, before = snapshot(repo)!;
    await new Promise(resolve => setImmediate(resolve));
    writeFileSync(join(executionCwd, "owned.txt"), "after\n"); const after = snapshot(repo)!;
    const turns = new Turns(join(project, ".agenthub", "state", "hub.db"));
    try { turns.begin("mixed-undo", "codex-worker", before, executionCwd); turns.end("mixed-undo", after, ["owned.txt"], 20); } finally { turns.close(); }
    const entry = join(import.meta.dir, "../src/cli/main.ts"), wrapper = join(base, "cli.ts");
    writeFileSync(wrapper, `for(const key of ["CODEX_THREAD_ID","CLAUDECODE","CLAUDE_CODE_SESSION_ID","AGENTHUB_PEER_ID","AGENTHUB_CHANNEL","AGENTHUB_PROJECT_DIR","AGENTHUB_STATE_DIR","AGENTHUB_INSTANCE_ID","AGENTHUB_LAUNCH_ID"])delete process.env[key];process.env.AGENTHUB_HOME=${JSON.stringify(home)};process.argv=[process.execPath,${JSON.stringify(entry)},"--project",${JSON.stringify(project)},"undo","mixed-undo","--yes"];await import(${JSON.stringify(entry)});`);
    const child = Bun.spawn([process.execPath, wrapper], { cwd: project, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain("owned.txt");
    expect(readFileSync(join(executionCwd, "owned.txt"), "utf8")).toBe("before\n");
    expect(readFileSync(join(project, "owned.txt"), "utf8")).toBe("before\n");
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 20_000);
