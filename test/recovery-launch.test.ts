import { expect, test } from "bun:test";
import { createTerminal, type TerminalBinding, type TerminalRecoveryOptions } from "../src/cli/terminal-recovery.ts";

test("#1426 AC2 a rejected launch blocks before MAX_WAIT_MS even while the shell stays alive", async () => {
  const launch = { packageEntrypoint: "/fixture/main.js", command: "fixture", argv: [], env: {} };
  const binding: TerminalBinding = { peer: "pi", handle: "old", incarnationId: "old-i", worktreeId: "w", projectRoot: "/fixture", sessionId: "s", launch, launchMetadata: launch };
  const shown = { handle: "new", incarnationId: "new-i", worktreeId: "w", worktreePath: "/fixture", connected: true, orphaned: false };
  const now = Date.now, start = now(); let elapsed = 0;
  Date.now = () => start + elapsed;
  try {
    const options = {
      runner: async (argv: readonly string[]) => {
        if (argv[1] === "wait") { elapsed += Number(argv[argv.indexOf("--timeout-ms") + 1]); return { status: 1, stdout: JSON.stringify({ ok: false, error: { code: "timeout" } }) }; }
        return { result: { terminal: shown } };
      },
      launchFailure: () => ({ code: "version_refused", exitCode: 1, firstLine: "Version not verified: Pi 1.5.2" }),
    } as TerminalRecoveryOptions;
    const result = await createTerminal(binding, options);
    expect(elapsed, `restoration consumed ${elapsed}ms of MAX_WAIT_MS=600000 after its command already refused`).toBeLessThan(10_000);
    expect(result.blockers[0]?.code).toBe("launch-failed");
    expect(result.blockers[0]).toMatchObject({ failure: { code: "version_refused", exitCode: 1 } });
  } finally { Date.now = now; }
});

import { prepareRecoveryLaunch } from "../src/cli/recovery-launch.ts";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const peer of ["pi", "codex"]) test(`#1426 ${peer}: private launcher captures refusal, then a fresh attempt succeeds`, async () => {
  const state = mkdtempSync(join(tmpdir(), "ahub-launch-result-"));
  try {
    const fake = join(state, "fake.ts");
    writeFileSync(fake, 'console.error("ahub: Version not verified: Pi 1.5.2"); process.exit(1);');
    const first = prepareRecoveryLaunch(state, peer, [process.execPath, fake], {}, state);
    try {
      const child = Bun.spawn(["/bin/sh", "-c", first.command], { cwd: state, env: { ...process.env, HOME: state, AGENTHUB_HOME: state, AMEM_HOME: join(state, "amem"), CODEX_HOME: state, CLAUDE_CONFIG_DIR: state }, stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, child.stderr.text()]);
      expect(code).toBe(1); expect(stderr).toContain("Version not verified:");
      expect(first.read()).toMatchObject({ code: "version_refused", exitCode: 1, firstLine: "ahub: Version not verified: Pi 1.5.2" });
    } finally { first.dispose(); }
    writeFileSync(fake, 'console.log("ready");');
    const second = prepareRecoveryLaunch(state, peer, [process.execPath, fake], {}, state);
    try {
      const child = Bun.spawn(["/bin/sh", "-c", second.command], { cwd: state, env: { ...process.env, HOME: state, AGENTHUB_HOME: state, AMEM_HOME: join(state, "amem"), CODEX_HOME: state, CLAUDE_CONFIG_DIR: state }, stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(0);
      expect(second.read()).toBeUndefined();
    } finally { second.dispose(); }
    expect(readdirSync(state).filter(name => name.startsWith("restore-launch-"))).toEqual([]);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("#1426 outcome matching and privacy fail closed without revealing stderr", async () => {
  const state = mkdtempSync(join(tmpdir(), "ahub-launch-private-"));
  mkdirSync(join(state, ".agenthub"));
  writeFileSync(join(state, ".agenthub/routing.toml"), '[signals]\npii_patterns = ["900101"]\n');
  try {
    const fake = join(state, "fake.ts");
    writeFileSync(fake, 'console.error("patient 900101-1234567 refused"); process.exit(7);');
    const capture = prepareRecoveryLaunch(state, "pi", [process.execPath, fake], {}, state);
    try {
      const dir = join(state, readdirSync(state).find(name => name.startsWith("restore-launch-"))!);
      const preload = readFileSync(join(dir, "capture.ts"), "utf8");
      const payload = JSON.parse(preload.split("captureLaunchExit(")[1]!.split(");")[0]!);
      writeFileSync(payload.file, JSON.stringify({ schemaVersion: 1, nonce: "stale-attempt", peer: "pi", exitCode: 7, firstLine: "canary", complete: true }));
      expect(capture.read()).toBeUndefined();
      rmSync(payload.file);
      const child = Bun.spawn(["/bin/sh", "-c", capture.command], { cwd: state, env: { ...process.env, HOME: state, AGENTHUB_HOME: state, AMEM_HOME: join(state, "amem"), CODEX_HOME: state, CLAUDE_CONFIG_DIR: state }, stdout: "pipe", stderr: "pipe" });
      await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
      const outcome = capture.read();
      expect(outcome?.code).toBe("launch_exit"); expect(outcome?.exitCode).toBe(7);
      expect(JSON.stringify(outcome)).not.toContain("900101");
      expect(outcome?.firstLine).toContain("privacy");
    } finally { capture.dispose(); }
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("#1426 an owned fake launch keeps all three terminal descriptors as TTYs", async () => {
  const state = mkdtempSync(join(tmpdir(), "ahub-launch-pty-"));
  try {
    const fake = join(state, "tty.ts"), report = join(state, "tty.json");
    writeFileSync(fake, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(report)}, JSON.stringify([process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY])); console.error("ahub: Version not verified: Pi 1.5.2"); process.exit(1);`);
    const capture = prepareRecoveryLaunch(state, "pi", [process.execPath, fake], {}, state);
    try {
      const script = "import os,pty,subprocess,sys\nm,s=pty.openpty()\ntry:\n r=subprocess.run(['/bin/sh','-c',sys.argv[1]],stdin=s,stdout=s,stderr=s)\nfinally:\n os.close(s);os.close(m)\nsys.exit(r.returncode)\n";
      const child = Bun.spawn(["python3", "-c", script, capture.command], { cwd: state, env: { ...process.env, HOME: state, AGENTHUB_HOME: state, AMEM_HOME: join(state, "amem"), CODEX_HOME: state, CLAUDE_CONFIG_DIR: state }, stdout: "pipe", stderr: "pipe" });
      const [code] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
      expect(code).toBe(1);
      expect(JSON.parse(readFileSync(report, "utf8"))).toEqual([true, true, true]);
      expect(capture.read()?.code).toBe("version_refused");
    } finally { capture.dispose(); }
  } finally { rmSync(state, { recursive: true, force: true }); }
});

import { runCommand } from "../src/cli/recovery-package.ts";
test("#1426 private target-parser input is delivered through stdin without changing ordinary probe output", async () => {
  const result = await runCommand([process.execPath, "-e", 'const input=await Bun.stdin.text(); console.log(JSON.stringify({input,argv:process.argv}));'], { input: "PRIVATE_STDIN_CANARY", pipeExitGraceMs: 250 });
  const data = JSON.parse(result.stdout);
  expect(result.code).toBe(0); expect(data.input).toBe("PRIVATE_STDIN_CANARY");
  expect(data.argv.some((arg: string) => arg.includes("PRIVATE_STDIN_CANARY"))).toBe(false);
});
