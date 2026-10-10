import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { acquireRecoveryLock, claimRunner, writeOperation } from "../src/hub/recovery-store.ts";

test("installed-layout detached restart completes in an isolated project and preserves its task board", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-recovery-cli-"));
  mkdirSync(join(temp, "project"));
  const root = realpathSync(join(temp, "project")), home = join(temp, "home");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("ORCA_")) delete env[key];
  env.AGENTHUB_HOME = home;
  const main = join(import.meta.dir, "../src/cli/main.js");
  const cli = async (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawn([process.execPath, main, "--project", root, ...args], { cwd: root, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out, err };
  };
  let operation: string | undefined;
  // Every daemon generation this test starts (up, restart, recovery) is recorded, so a
  // failed `kill` can never leave a detached hub spinning behind the suite (issue #56).
  const pids = new Set<number>();
  const status = async () => {
    const client = await ControlClient.connect(join(root, ".agenthub/state"), { role: "console", projectRoot: root });
    try {
      const reply = (await client.request({ t: "status" })).status;
      if (typeof reply?.pid === "number") pids.add(reply.pid);
      return reply;
    }
    finally { client.close(); }
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitDead = async (pid: number, ms: number) => {
    const deadline = Date.now() + ms;
    while (alive(pid) && Date.now() < deadline) await Bun.sleep(50);
    return !alive(pid);
  };
  try {
    expect((await cli(["init"])).code).toBe(0);
    writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, omniroute: { urls: [] } }));
    expect((await cli(["up"])).code).toBe(0);
    expect((await cli(["task", "propose", "--class", "implement", "Keep this task through restart"])).code).toBe(0);
    const before = await status();
    const plan = await cli(["restart", "--dry-run"]);
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.out).projects[0].blockers).toEqual([]);
    const applied = await cli(["restart", "--yes"]);
    expect(applied.code).toBe(0);
    operation = /Recovery operation ([a-f0-9-]{36}) scheduled/.exec(applied.out)?.[1];
    expect(operation).toBeDefined();
    let receipt: any;
    for (let n = 0; n < 200; n++) {
      receipt = JSON.parse(readFileSync(join(home, "recovery", `${operation}.json`), "utf8"));
      if (["completed", "blocked"].includes(receipt.phase)) break;
      await Bun.sleep(50);
    }
    expect({ phase: receipt.phase, step: receipt.step, error: receipt.error }).toEqual({ phase: "completed", step: "completed", error: undefined });
    const after = await status();
    expect(after.instanceId).not.toBe(before.instanceId);
    expect(after.projectId).toBe(before.projectId);
    expect(after.tasks).toEqual(before.tasks);
    expect((await cli(["board"])).out).toContain("Keep this task through restart");
    expect((await cli(["task", "propose", "--class", "implement", "Normal writes after recovery"])).code).toBe(0);
    const second = await cli(["restart", "--dry-run"]);
    expect(JSON.parse(second.out).projects[0].blockers).toEqual([]);
    // #272: on a terminal, with no flag, the same restart is reviewed, applied with one key and followed to its end.
    const wrapper = join(temp, "terminal.ts");
    writeFileSync(wrapper, `for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: true });
process.argv = [process.execPath, ${JSON.stringify(main)}, "--project", ${JSON.stringify(root)}, "restart"];
await import(${JSON.stringify(main)});
`);
    const terminal = Bun.spawn([process.execPath, wrapper], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    terminal.stdin.write("a\n"); terminal.stdin.end();
    const [typedCode, screen] = await Promise.all([terminal.exited, new Response(terminal.stdout).text()]);
    expect(typedCode).toBe(0);
    expect(screen).toContain(`restart on ${after.version}\n\n${after.projectId}  ${root}  hub ${after.version} (running)`);
    expect(screen).toContain("[a] apply  [r] refresh  [j] plan as JSON  [x] reset a project's hub  [q] quit: ");
    expect(screen).toMatch(/operation [a-f0-9-]{36} started; Enter opens its menu, Ctrl\+C leaves, and neither stops the restart\n  staging the release\n/);
    expect(screen.trimEnd()).toEndWith(`  completed\nrestart to ${after.version} completed`);
    operation = /operation ([a-f0-9-]{36}) started/.exec(screen)?.[1] ?? operation;
    const typed = await status();
    expect(typed.instanceId).not.toBe(after.instanceId);
    expect(typed.recovery).toMatchObject({ operationId: operation, phase: "released" });
    expect((await cli(["board"])).out).toContain("Normal writes after recovery");
    // An agent restored by this operation may later invoke CLI commands with the old
    // operation environment still inherited. A regular stop/up must not replay it.
    expect((await cli(["kill"], { AGENTHUB_RECOVERY_OPERATION: operation! })).code).toBe(0);
    expect((await cli(["up"], { AGENTHUB_RECOVERY_OPERATION: operation! })).code).toBe(0);
    expect((await status()).recovery).toBeUndefined();
    expect((await cli(["board"])).out).toContain("Keep this task through restart");
    expect(pids.size).toBeGreaterThan(0); // the harness recorded at least one daemon generation
  } finally {
    try { await cli(["kill"], operation ? { AGENTHUB_RECOVERY_OPERATION: operation } : {}); } catch { /* best effort; the pid sweep below is the guarantee */ }
    // The recovery flow also runs a detached dashboard manager out of the staged source.
    try {
      const manifest = JSON.parse(readFileSync(join(home, "manager", "status.json"), "utf8"));
      if (typeof manifest?.pid === "number") pids.add(manifest.pid);
    } catch { /* no manager this run */ }
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    for (const pid of pids) if (!(await waitDead(pid, 5_000))) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    const stuck = [];
    for (const pid of pids) if (!(await waitDead(pid, 2_000))) stuck.push(pid);
    rmSync(temp, { recursive: true, force: true }); // unconditional: the watchdog removes the state a straggler still holds
    if (stuck.length) throw new Error(`hub daemon(s) survived SIGTERM and SIGKILL: ${stuck.join(", ")}`);
  }
}, 30_000);

// #206 AC3: a refused --yes names each blocker on stderr, not only its last line.
test("a refused restart lists every blocker before its final line", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-refused-cli-"));
  mkdirSync(join(temp, "project"));
  const root = realpathSync(join(temp, "project"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("ORCA_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) delete env[key];
  env.AGENTHUB_HOME = join(temp, "home");
  const cli = async (args: string[]) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [code, , err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, err: err.trim().split("\n") };
  };
  try {
    expect(await cli(["restart", "--dry-run"])).toEqual({ code: 0, err: ["ahub: blocker: no running registered projects in scope"] });
    expect(await cli(["restart", "--yes"])).toEqual({ code: 1, err: ["ahub: blocker: no running registered projects in scope", "ahub: plan has blockers; no runtime was changed"] });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

// #215 AC4: the disposition is a person's decision; an agent shell is refused before any receipt is read.
test("an agent shell cannot dispose of a recovery operation", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-dispose-cli-"));
  mkdirSync(join(temp, "project"));
  const root = realpathSync(join(temp, "project"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("ORCA_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) delete env[key];
  Object.assign(env, { AGENTHUB_HOME: join(temp, "home"), CLAUDECODE: "1" });
  try {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, "recovery", "dispose", "00000000-0000-4000-8000-000000000000", "--stop-and-archive", "--reason", "test"],
      { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [code, , err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect({ code, err: err.trim() }).toEqual({ code: 1, err: "ahub: claude cannot run ahub recovery dispose; the person runs it in ahub console or a terminal" });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

// #215: resume does not start a second runner while one holds the operation; status names it.
test("resume declines while a runner holds the operation", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-runner-cli-"));
  mkdirSync(join(temp, "project"));
  const root = realpathSync(join(temp, "project")), home = join(temp, "home");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("ORCA_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) delete env[key];
  env.AGENTHUB_HOME = home;
  const id = "00000000-0000-4000-8000-000000000215";
  writeOperation(id, { schema: 1, id, phase: "running", step: "restore:p", sourceRoot: "/preserved/coordinator", plan: { version: "0.0.0" }, projects: [], updatedAt: 1 }, home);
  const release = claimRunner(id, home);
  const cli = async (args: string[]) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out };
  };
  try {
    // Never the bare global ahub, which may be the older release mid-upgrade (#215); a coordinator without the #215
    // commands (as this one, which does not exist) is replaced by the running release.
    expect(await cli(["recovery", "resume", id])).toEqual({ code: 0, out: `runner ${process.pid} is still working on this operation; bun ${join(import.meta.dir, "../src/cli/main.js")} recovery status ${id}\n` });
    expect(JSON.parse((await cli(["recovery", "status", id])).out)).toMatchObject({ runner: { state: "running", pid: process.pid } });
  } finally { release(); rmSync(temp, { recursive: true, force: true }); }
});

// #272 AC1: without --to the latest release is the target, and a target newer than this CLI goes to its own coordinator.
test("upgrade resolves the latest release and hands a newer target to that release's coordinator", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-handover-cli-"));
  mkdirSync(join(temp, "project")); mkdirSync(join(temp, "bin"));
  const root = realpathSync(join(temp, "project")), record = join(temp, "bunx-argv");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("ORCA_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) delete env[key];
  env.AGENTHUB_HOME = join(temp, "home");
  env.PATH = `${join(temp, "bin")}:${env.PATH}`;
  // A registry that knows a far newer latest release and one old exact release.
  writeFileSync(join(temp, "bin/npm"), `#!/bin/sh
case "$*" in
  "view @staix/agent-hub version --json") echo '"99.0.0"' ;;
  "view @staix/agent-hub@0.0.1 version dist.integrity --json") echo '{"version":"0.0.1","dist.integrity":"sha512-test"}' ;;
  *) exit 1 ;;
esac
`);
  // Stands in for bun: it records what it was asked to run and exits with a code of its own.
  const bun = join(temp, "bin/recorded-bun");
  writeFileSync(bun, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nexit 7\n`);
  for (const file of [join(temp, "bin/npm"), bun]) chmodSync(file, 0o755);
  const main = join(import.meta.dir, "../src/cli/main.js"), wrapper = join(temp, "cli.ts");
  writeFileSync(wrapper, `const args = JSON.parse(process.env.CLI_ARGV!);
process.execPath = ${JSON.stringify(bun)};
process.argv = [${JSON.stringify(bun)}, ${JSON.stringify(main)}, ...args];
await import(${JSON.stringify(main)});
`);
  const cli = async (args: string[]) => {
    rmSync(record, { force: true });
    const p = Bun.spawn([process.execPath, wrapper], { cwd: root, env: { ...env, CLI_ARGV: JSON.stringify(args) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    let ran: string[] | undefined;
    try { ran = readFileSync(record, "utf8").trim().split("\n"); } catch { /* bun x was not run */ }
    return { code, out, err: err.trim().split("\n"), ran };
  };
  try {
    const { VERSION } = await import("../src/version.ts");
    const handed = (flags: string[]) => ["x", "--package", "@staix/agent-hub@99.0.0", "ahub", "upgrade", "--to", "99.0.0", ...flags];
    // A dry run without --to: the latest release, named, then handed over with the same flag; its exit code is ours.
    expect(await cli(["upgrade", "--dry-run"])).toEqual({ code: 7, out: "", ran: handed(["--dry-run"]), err: [
      "ahub: the latest release is 99.0.0",
      `ahub: 99.0.0 is newer than this CLI (${VERSION}), so its own coordinator runs the upgrade: bun ${handed(["--dry-run"]).join(" ")}`,
    ] });
    // An explicit newer target with --yes is handed over without a prompt.
    expect((await cli(["upgrade", "--to", "99.0.0", "--yes"])).ran).toEqual(handed(["--yes"]));
    // --yes still names its release, and through a pipe so does a plain run: nothing is resolved or run.
    for (const args of [["upgrade", "--yes"], ["upgrade"]]) expect(await cli(args)).toEqual({ code: 1, out: "", err: ["ahub: upgrade requires --to <exact-version>"], ran: undefined });
    // A range never reaches a package spec.
    expect(await cli(["upgrade", "--to", "99", "--dry-run"])).toEqual({ code: 1, out: "", err: ["ahub: --to requires an exact package version"], ran: undefined });
    // A target that is not newer is planned by this coordinator.
    const here = await cli(["upgrade", "--to", "0.0.1", "--dry-run"]);
    expect({ code: here.code, ran: here.ran, version: JSON.parse(here.out).version }).toEqual({ code: 0, ran: undefined, version: "0.0.1" });
    expect(here.err).toContain("ahub: blocker: no running registered projects in scope");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

// #272 AC6: without an id the recovery commands take the operation that holds the machine's lock.
test("recovery commands without an id use the operation that holds the lock", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-lock-cli-"));
  mkdirSync(join(temp, "project"));
  const root = realpathSync(join(temp, "project")), home = join(temp, "home");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("ORCA_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) delete env[key];
  env.AGENTHUB_HOME = home;
  const id = "00000000-0000-4000-8000-000000000272";
  const cli = async (args: string[]) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out, err: err.trim() };
  };
  try {
    writeOperation(id, { schema: 1, id, phase: "completed", step: "completed", sourceRoot: "/preserved/coordinator", plan: { version: "0.0.0" }, projects: [], updatedAt: 1 }, home);
    expect(await cli(["recovery", "status"])).toEqual({ code: 1, out: "", err: "ahub: no recovery operation holds the lock; name one by its id" });
    acquireRecoveryLock(id, home);
    expect(JSON.parse((await cli(["recovery", "status"])).out)).toMatchObject({ id, phase: "completed", next: [] });
    expect((await cli(["recovery", "resume"])).out).toBe("recovery is already completed\n");
    // abort and dispose reach the same operation as with its id (this bare receipt has no plan to abort), and
    // dispose's flags are still its flags.
    expect(await cli(["recovery", "abort"])).toEqual(await cli(["recovery", "abort", id]));
    const dispose = ["--stop-and-archive", "--reason", "done with it"];
    expect(await cli(["recovery", "dispose", ...dispose])).toEqual(await cli(["recovery", "dispose", id, ...dispose]));
    expect((await cli(["recovery", "dispose", ...dispose])).err).not.toContain("usage");
    expect((await cli(["recovery", "dispose", "--stop-and-archive"])).err).toStartWith("ahub: usage: ahub recovery");
    // Not a terminal: the bare command has no screen to open, and a word that is no id is not taken for one.
    expect((await cli(["recovery"])).err).toStartWith("ahub: usage: ahub recovery [status|resume|abort] [<operation-id>]");
    expect((await cli(["recovery", "status", "latest"])).err).toStartWith("ahub: usage: ahub recovery");
    expect(JSON.parse((await cli(["recovery", "status", id])).out)).toMatchObject({ id });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

// #215 review: a recovery launch of `ahub codex` records its launcher before the hub round trip, so the coordinator
// never takes a launcher still starting for one that never ran; an ordinary launch records only after the hub accepted.
test("ahub codex records a recovery launch before the hub start, and an ordinary one only after it", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-codex-record-"));
  mkdirSync(join(temp, "project"));
  const root = realpathSync(join(temp, "project")), home = join(temp, "home"), stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true });
  // A hub manifest whose port nothing listens on: the start round trip fails after the launcher could have recorded.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const deadPort = probe.port; probe.stop(true);
  writeFileSync(join(stateDir, "control-token"), "token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: deadPort, protocol: 16, projectId: "p", instanceId: "i-codex", cwd: root }));
  const orca = join(temp, "orca");
  writeFileSync(orca, `#!${process.execPath}\nconsole.log(JSON.stringify({ ok: true, result: { terminal: { handle: "term-x", worktreePath: ${JSON.stringify(root)}, worktreeId: "wt", incarnationId: "inc-x" } } }));\n`);
  chmodSync(orca, 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("ORCA_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) delete env[key];
  Object.assign(env, { AGENTHUB_HOME: home, ORCA_CLI_COMMAND: orca, ORCA_TERMINAL_HANDLE: "term-x", ORCA_WORKTREE_ID: "wt" });
  const codex = async (extra: Record<string, string>) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, "codex"], { cwd: root, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [code] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return code;
  };
  const records = () => { try { return JSON.parse(readFileSync(join(stateDir, "terminal-recovery.json"), "utf8")) as { peer: string; handle: string }[]; } catch { return []; } };
  const id = "00000000-0000-4000-8000-000000000216";
  try {
    expect(await codex({})).toBe(1);
    expect(records()).toEqual([]); // ordinary: the refused start recorded nothing
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "recovery.lock"), JSON.stringify({ operationId: id }));
    expect(await codex({ AGENTHUB_RECOVERY_OPERATION: id })).toBe(1);
    expect(records().map((row) => [row.peer, row.handle])).toEqual([["codex", "term-x"]]);
    // A Pi TUI launch by the same operation records itself before the hub round trip too.
    const pi = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, "pi", "--mode", "tui"], { cwd: root, env: { ...env, AGENTHUB_RECOVERY_OPERATION: id }, stdout: "pipe", stderr: "pipe" });
    const [piCode] = await Promise.all([pi.exited, new Response(pi.stdout).text(), new Response(pi.stderr).text()]);
    expect(piCode).toBe(1);
    expect(records().map((row) => [row.peer, row.handle])).toEqual([["codex", "term-x"], ["pi", "term-x"]]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

// #215 review: an older coordinator resumes anything not finished; the running release refuses to resume an operation
// whose stop-and-archive is partway, whatever coordinator started it.
test("resume refuses an operation whose stop-and-archive is partway", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-disposed-cli-"));
  mkdirSync(join(temp, "project"));
  const root = realpathSync(join(temp, "project")), home = join(temp, "home");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("ORCA_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) delete env[key];
  env.AGENTHUB_HOME = home;
  const id = "00000000-0000-4000-8000-000000000217";
  writeOperation(id, { schema: 1, id, phase: "blocked", step: "disposed", sourceRoot: "/releases/source-older", plan: { version: "0.12.19", projects: [] }, projects: [], updatedAt: 1,
    disposition: { choice: "stop-and-archive", at: 1, projects: {} } }, home);
  try {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, "recovery", "resume", id], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect({ code, out }).toEqual({ code: 1, out: "" });
    expect(err).toContain("a stop-and-archive of this operation is partway; nothing was resumed; next actions: rerun");
    expect(err).toContain("recovery dispose 00000000-0000-4000-8000-000000000217 --stop-and-archive --reason <text>");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
