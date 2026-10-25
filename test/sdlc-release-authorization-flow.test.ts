import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/cli/init.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";

// The real hook, CLI, control identity and daemon ledger run here. Only the host's
// committed-doc readback is substituted; no native release command is executed.
test("S6 actual pre-push hook requires person consent for its captured commit and version and loses it on restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-release-flow-")), root = join(dir, "repo"), stateDir = join(dir, "state");
  mkdirSync(root); mkdirSync(stateDir);
  const git = (...args: string[]) => { const r = hubGitSync(args, { cwd: root, encoding: "utf8", timeout: 2000 }); expect(r.status).toBe(0); return r.stdout.trim(); };
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, agent: ControlClient | undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(dir, "home"), AGENTHUB_HOME: join(dir, "home/hub"), AGENTHUB_PROJECT_DIR: root, AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "fixture" };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_SESSION_ID;
  const cli = join(import.meta.dir, "../src/cli/main.ts"), saved = join(dir, "saved-input");
  async function run(argv: string[], input?: string, asPerson = false) {
    const childEnv = { ...env }; if (asPerson) { delete childEnv.AGENTHUB_PEER_ID; delete childEnv.CODEX_THREAD_ID; }
    const child = Bun.spawn(argv, { cwd: root, env: childEnv, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  }
  const start = async () => {
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      releaseDocEvidence: async () => ({ schemaVersion: 1, head: git("rev-parse", "HEAD"), version: "1.2.3", fresh: true, errors: 0,
        documents: [{ path: "README.md", state: "fresh", verifiedAgainst: git("rev-parse", "HEAD"), commits: 0, dirty: false }] }),
      config: { ...DEFAULT_CONFIG, roster: { claude: false, codex: true, kimi: false, qwen: false, jcode: false, pi: false, local: false },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { enabled: false, keep: 1 } } });
    person = await ControlClient.connect(stateDir, { role: "console" });
    agent = await ControlClient.connect(stateDir, { role: "tools", peer: "codex" });
  };
  try {
    git("init", "-q"); git("remote", "add", "origin", "https://example.test/project.git");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3" }));
    git("add", "package.json"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "candidate");
    const first = git("rev-parse", "HEAD"); git("tag", "v1.2.3"); git("tag", "v1.2.4");
    const hook = join(root, ".git/hooks/pre-push");
    writeFileSync(hook, `#!/bin/sh\ncat > '${saved}'\n`, { mode: 0o755 });
    init(root, undefined, false, true);
    // This account-free fixture disables MLX; remove init's explicit MLX pins.
    const routing = join(root, ".agenthub/routing.toml");
    writeFileSync(routing, readFileSync(routing, "utf8").replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"'));
    const input = `refs/tags/v1.2.3 ${first} refs/tags/v1.2.3 ${"0".repeat(40)}\n`;
    const hookRun = (data = input) => run([hook, "origin", "https://example.test/project.git"], data);
    await start();
    expect((await agent!.request({ t: "sdlc", op: "authorize-release", version: "1.2.3", commit: first })).ok).toBe(false);
    expect((await run([process.execPath, cli, "sdlc", "authorize-release", "1.2.3"])).code).toBe(1);
    expect((await run([process.execPath, cli, "--live-test", "sdlc", "authorize-release", "1.2.3"])).code).toBe(1);
    expect((await hookRun()).code).toBe(1); expect(existsSync(saved)).toBe(false);
    const approval = await run([process.execPath, cli, "sdlc", "authorize-release", "1.2.3", "--json"], undefined, true);
    expect(approval.code, approval.stderr).toBe(0); expect(JSON.parse(approval.stdout)).toMatchObject({ by: "user", version: "1.2.3", commit: first, docs: { fresh: true } });
    expect((await hookRun()).code).toBe(0); expect(readFileSync(saved, "utf8")).toBe(input);
    rmSync(saved);
    expect((await hookRun(input.replaceAll("v1.2.3", "v1.2.4"))).code).toBe(1); expect(existsSync(saved)).toBe(false);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "changed candidate");
    git("tag", "-f", "v1.2.3"); const next = git("rev-parse", "HEAD");
    expect((await hookRun(input.replace(first, next))).code).toBe(1);
    person!.close(); agent!.close(); await daemon!.stop(); daemon = undefined;
    // Hub down refuses tags, but branch-only stdin still reaches the preserved user hook.
    expect((await hookRun()).code).toBe(1);
    const branchInput = `refs/heads/main ${next} refs/heads/main ${"0".repeat(40)}\n`;
    expect((await hookRun(branchInput)).code).toBe(0); expect(readFileSync(saved, "utf8")).toBe(branchInput);
    git("tag", "-f", "v1.2.3", first); await start();
    expect((await hookRun()).code).toBe(1);
    expect(readFileSync(join(stateDir, "events.jsonl"), "utf8")).toContain('"type":"release_authorization"');
  } finally { person?.close(); agent?.close(); await daemon?.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
