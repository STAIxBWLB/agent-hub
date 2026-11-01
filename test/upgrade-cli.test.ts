import { expect, test } from "bun:test";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { acquireRecoveryLock, claimRunner, writeOperation } from "../src/hub/recovery-store.ts";
import { processSignature } from "../src/pi/process-signature.ts";

const RESTART_LOG_BYTES = 64 * 1024;
const RESTART_OPERATION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function diagnosticParents(file: string, anchor: string): void {
  const base = resolve(anchor), parts = relative(base, dirname(resolve(file))).split(/[\\/]/).filter(Boolean);
  if (parts.includes("..")) throw new Error("outside fixture diagnostics");
  let current = base;
  // The caller owns the fixture anchor. Check it and every directory underneath;
  // system aliases above it (macOS /var -> /private/var) are not fixture entries.
  for (const part of ["", ...parts]) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("symlinked diagnostic parent");
  }
}

function readDiagnosticFile(file: string, anchor: string, tail: boolean): { text: string; copiedBytes: number; truncated: boolean } {
  diagnosticParents(file, anchor);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular diagnostic file");
    if (!tail && stat.size > RESTART_LOG_BYTES) throw new Error("diagnostic JSON exceeds bound");
    const length = Math.min(stat.size, RESTART_LOG_BYTES), offset = stat.size - length, data = Buffer.alloc(length);
    const bytes = readSync(fd, data, 0, length, offset);
    let start = 0;
    if (offset > 0) {
      const previous = Buffer.alloc(1); readSync(fd, previous, 0, 1, offset - 1);
      if (previous[0] !== 10) { const newline = data.indexOf(10); start = newline < 0 ? bytes : newline + 1; }
    }
    return { text: data.subarray(start, bytes).toString("utf8"), copiedBytes: bytes, truncated: offset > 0 };
  } finally { closeSync(fd); }
}

function redactRestartDiagnostic(value: string, root: string, home: string): string {
  const roots = [[root, "<fixture-project>"], [home, "<fixture-home>"], [join(import.meta.dir, ".."), "<checkout>"], [homedir(), "<host-home>"], [tmpdir(), "<temp>"]]
    .sort((a, b) => b[0]!.length - a[0]!.length);
  let text = value;
  for (const [path, label] of roots) text = text.replaceAll(path!, label!);
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, url => {
    if (/^file:/i.test(url)) return "<absolute-path>";
    return url.replace(/(:\/\/)[^/]*@/, "$1")
      .replace(/([?&])([^=&]+)=([^&#]*)/g, (whole, prefix, key: string) => {
        let decoded = key; try { decoded = decodeURIComponent(key); } catch { /* retain the literal name for classification */ }
        return /token|secret|password|api[_-]?key|credential|authorization/i.test(decoded) ? `${prefix}${key}=redacted` : whole;
      });
  });
  text = text.replace(/(["']?[\w.-]+["']?\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:Bearer\s+)?[^\s,;}\r\n]+)/gi, (whole, prefix: string) =>
    /token|secret|password|api[_-]?key|authorization|cookie/i.test(prefix) ? `${prefix}<redacted>` : whole);
  text = text.replace(/\b(?:set-)?cookie\s*[:=][^\r\n]*/gi, "cookie=<redacted>");
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{10,})\b/g, "<redacted-key>");
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>");
  return text.replace(/(^|[\s("'=:])\/(?!\/)[^\r\n"'<>)]*/gm, "$1<absolute-path>")
    .replace(/\b[A-Z]:[\\/][^\r\n"'<>)]*/gi, "<absolute-path>")
    .replace(/(?:~[\\/]|\\\\)[^\r\n"'<>)]*/g, "<absolute-path>");
}

function writeBoundedDiagnostic(file: string, text: string): void {
  const data = Buffer.from(text), offset = Math.max(0, data.length - RESTART_LOG_BYTES);
  const newline = offset ? data.indexOf(10, offset) : -1;
  const start = offset ? newline < 0 ? data.length : newline + 1 : 0;
  writeFileSync(file, data.subarray(start), { mode: 0o600 });
}

/** Failure diagnostics only: bounded selected logs/receipt fields and modes, never DB or control contents. */
function retainRestartDiagnostics(root: string, home: string, operation: string | undefined, destination = process.env.AHUB_RESTART_DIAGNOSTICS_DIR): string | undefined {
  if (!destination) return undefined;
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const output = mkdtempSync(join(destination, "installed-layout-restart-"));
  const redact = (text: string) => redactRestartDiagnostic(text, root, home);
  const logs: Record<string, { copiedBytes?: number; truncated?: boolean; available: boolean }> = {};
  for (const [name, file, anchor] of [["hub.log", join(root, ".agenthub", "state", "hub.log"), root], ["manager.log", join(home, "manager", "manager.log"), home]]) {
    try {
      const log = readDiagnosticFile(file!, anchor!, true);
      writeBoundedDiagnostic(join(output, name!), redact(log.text));
      logs[name!] = { available: true, copiedBytes: log.copiedBytes, truncated: log.truncated };
    } catch { logs[name!] = { available: false }; }
  }
  const databases: Record<string, { mode: string; bytes: number; regular: boolean } | { exists: false }> = {};
  const selected = [["hub.db", join(root, ".agenthub", "state", "hub.db"), root], ["registry.db", join(home, "registry.db"), home]];
  const validOperation = operation !== undefined && RESTART_OPERATION.test(operation);
  if (validOperation) selected.push(["runner.db", join(home, "recovery", `${operation}.json.runner.db`), home]);
  for (const [name, file, anchor] of selected) for (const suffix of ["", "-wal", "-shm"]) {
    try {
      diagnosticParents(file! + suffix, anchor!);
      const stat = lstatSync(file! + suffix);
      databases[name! + suffix] = { mode: (stat.mode & 0o777).toString(8).padStart(3, "0"), bytes: stat.size, regular: stat.isFile() };
    } catch { databases[name! + suffix] = { exists: false }; }
  }
  if (validOperation) {
    try {
      const receipt = JSON.parse(readDiagnosticFile(join(home, "recovery", `${operation}.json`), home, false).text);
      const string = (value: unknown, length = 4096) => typeof value === "string" ? redact(value).slice(0, length) : undefined;
      const failure = receipt.failure && typeof receipt.failure === "object" ? {
        code: string(receipt.failure.code, 64), retryable: typeof receipt.failure.retryable === "boolean" ? receipt.failure.retryable : undefined,
        site: Array.isArray(receipt.failure.site) ? receipt.failure.site.slice(0, 8).map((frame: unknown) => string(frame, 1024)) : string(receipt.failure.site),
      } : undefined;
      const subset = { phase: string(receipt.phase, 64), step: string(receipt.step, 256), error: string(receipt.error), failure,
        projects: Array.isArray(receipt.projects) ? receipt.projects.slice(0, 20).map((project: any) => ({ id: string(project.id, 128), phase: string(project.phase, 64), ...(typeof project.commitSent === "boolean" ? { commitSent: project.commitSent } : {}) })) : [] };
      writeBoundedDiagnostic(join(output, "receipt.json"), JSON.stringify(subset, null, 2) + "\n");
    } catch { /* missing/oversized/malformed/untrusted receipt: preserve the other selected diagnostics */ }
  }
  writeFileSync(join(output, "files.json"), JSON.stringify({ logs, databases }, null, 2) + "\n", { mode: 0o600 });
  return output;
}

async function withRestartDiagnostics<T>(body: () => Promise<T>, context: () => { root: string; home: string; operation: string | undefined }, destination = process.env.AHUB_RESTART_DIAGNOSTICS_DIR): Promise<T> {
  try { return await body(); }
  catch (error) {
    const { root, home, operation } = context();
    try { retainRestartDiagnostics(root, home, operation, destination); }
    catch { console.warn("restart diagnostics could not be retained"); }
    throw error;
  }
}

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
    await withRestartDiagnostics(async () => {
    expect((await cli(["init"])).code).toBe(0);
    writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, omniroute: { urls: [] } }));
    expect((await cli(["up"])).code).toBe(0);
    expect((await cli(["task", "propose", "--class", "implement", "Keep this task through restart"])).code).toBe(0);
    const before = await status();
    const plan = await cli(["restart", "--dry-run", "--json"]);
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.out).projects[0].blockers).toEqual([]);
    // #814: the same plan for a person, from a real running hub: its project, a clean plan, and what to do next
    const readable = await cli(["restart", "--dry-run"]);
    expect(readable.code).toBe(0);
    expect(() => JSON.parse(readable.out)).toThrow();
    expect(readable.out.replace(/\s+/g, " ")).toContain(JSON.parse(plan.out).projects[0].project.id);
    expect(readable.out).toContain("Apply with `--yes`"); expect(readable.out).not.toContain("Blocked:");
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
    const second = await cli(["restart", "--dry-run", "--json"]);
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
    // #466 reviewer-approved exception: replace only the four #272 TTY presentation goldens.
    const plain = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const { wrap } = await import("../src/cli/console-state.ts");
    // Only platform-dependent paths need the shared console wrapping primitive; UI text is pinned literally.
    const wrapped = (...rows: string[]) => rows.flatMap(row => wrap(row, 80)).join("\n");
    expect(screen).toContain(String.fromCharCode(27) + "[");
    expect(plain).toContain(wrapped(`restart to ${after.version}: plan`, `Coordinator version ${after.version}`, "",
      `${after.projectId}  ${root}  hub ${after.version} (running)`));
    expect(plain).toContain("[a] apply this reviewed plan\n[r] refresh the plan (recommended; Enter)\n[j] plan as JSON\n[x] reset a project's hub [warning]\n[q] quit\n>");
    const announced = /operation ([a-f0-9-]{36}) started/.exec(screen)?.[1];
    expect(announced).toBeDefined();
    expect(plain).toContain(wrapped(`operation ${announced} started; Enter opens its menu, Ctrl+C leaves, and neither stops the restart`,
      "[running] staging the release (timing unknown)") + "\n");
    expect(plain.trimEnd()).toEndWith(wrapped("[done] completed (timing unknown)", "restart completed",
      `${after.projectId}: running on ${after.version} (fresh readback).`,
      `${after.projectId}: target ${after.version} had started; this is a recorded historical step.`,
      ...["codex", "pi", "claude"].map(peer => `${after.projectId} ${peer}: ${peer}: recorded session identity unavailable; inspect the retained recovery receipt before choosing a conversation`),
      "Claude plugin installation not recorded.", "global CLI installation not recorded; a restart does not install a new CLI."));
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
    }, () => ({ root, home, operation }));
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
    // --json keeps the stderr blocker lines exactly (#206); the default prints the blocker on stdout, in the plan, and keeps only the final refusal on stderr.
    expect(await cli(["restart", "--dry-run", "--json"])).toEqual({ code: 0, err: ["ahub: blocker: no running registered projects in scope"] });
    expect(await cli(["restart", "--dry-run"])).toEqual({ code: 0, err: [""] });
    expect(await cli(["restart", "--yes", "--json"])).toEqual({ code: 1, err: ["ahub: blocker: no running registered projects in scope", "ahub: plan has blockers; no runtime was changed"] });
    expect(await cli(["restart", "--yes"])).toEqual({ code: 1, err: ["ahub: plan has blockers; no runtime was changed"] });
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
    expect({ code, err: err.trim() }).toEqual({ code: 1, err: "ahub: claude cannot run ahub recovery dispose; the person runs it in ahub console or a terminal. Refused because inherited agent markers (CLAUDECODE) identify this shell as an agent. A ! command in an agent session runs as that agent; use a separate terminal outside the agent session" });
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
    expect(JSON.parse((await cli(["recovery", "status", id, "--json"])).out)).toMatchObject({ runner: { state: "running", pid: process.pid } });
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
    const handed = (flags: string[]) => ["x", "--package", "@staix/agent-hub@99.0.0", "ahub", "--project", root, "upgrade", "--to", "99.0.0", ...flags];
    // A dry run without --to: the latest release, named, then handed over with the same flag; its exit code is ours.
    expect(await cli(["upgrade", "--dry-run"])).toEqual({ code: 7, out: "", ran: handed(["--dry-run"]), err: [
      "ahub: the latest release is 99.0.0",
      `ahub: 99.0.0 is newer than this CLI (${VERSION}), so its own coordinator runs the upgrade: bun ${handed(["--dry-run"]).join(" ")}`,
    ] });
    // The issue's command-local selector preserves the same canonical project in the target coordinator.
    expect(await cli(["upgrade", "--project", root, "--dry-run"])).toEqual(await cli(["--project", root, "upgrade", "--dry-run"]));
    const duplicated = await cli(["--project", root, "upgrade", "--project", root, "--dry-run"]);
    expect(duplicated.code).toBe(1); expect(duplicated.ran).toBeUndefined();
    expect(duplicated.err.join("\n")).toContain("--project may appear only once");
    // An explicit newer target with --yes is handed over without a prompt.
    expect((await cli(["upgrade", "--to", "99.0.0", "--yes"])).ran).toEqual(handed(["--yes"]));
    // --yes still names its release, and through a pipe so does a plain run: nothing is resolved or run.
    for (const args of [["upgrade", "--yes"], ["upgrade"]]) expect(await cli(args)).toEqual({ code: 1, out: "", err: ["ahub: upgrade requires --to <exact-version>"], ran: undefined });
    // A range never reaches a package spec.
    expect(await cli(["upgrade", "--to", "99", "--dry-run"])).toEqual({ code: 1, out: "", err: ["ahub: --to requires an exact package version"], ran: undefined });
    // A target that is not newer is planned by this coordinator.
    const here = await cli(["upgrade", "--to", "0.0.1", "--dry-run", "--json"]);
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
    expect(JSON.parse((await cli(["recovery", "status", "--json"])).out)).toMatchObject({ id, phase: "completed", next: [] });
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
    expect(JSON.parse((await cli(["recovery", "status", id, "--json"])).out)).toMatchObject({ id });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

// #482 replaces #215's pre-start publication premise: an unconnected recovery attempt is not a native owner.
test("ahub Codex and Pi failed recovery starts preserve prior owner rows without pre-attach publication (#482)", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-codex-record-"));
  mkdirSync(join(temp, "project"));
  const root = realpathSync(join(temp, "project")), home = join(temp, "home"), stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true });
  // An unreachable hub cannot establish native ownership for either ordinary or recovery launches.
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
    const file = join(stateDir, "terminal-recovery.json");
    const incumbent = ["codex", "pi"].map(peer => ({ peer, projectRoot: root, stateDir, instanceId: "i-codex", launcherPid: process.pid,
      launcherSignature: processSignature(process.pid), launchId: `incumbent-${peer}`, handle: `term-${peer}`, incarnationId: `inc-${peer}`, worktreeId: "wt", env: {} }));
    const authoritative = JSON.stringify(incumbent);
    writeFileSync(file, authoritative);
    expect(await codex({ AGENTHUB_RECOVERY_OPERATION: id })).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(authoritative);
    // Pi's failed recovery start has the same no-publication boundary.
    const pi = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, "pi", "--mode", "tui"], { cwd: root, env: { ...env, AGENTHUB_RECOVERY_OPERATION: id }, stdout: "pipe", stderr: "pipe" });
    const [piCode] = await Promise.all([pi.exited, new Response(pi.stdout).text(), new Response(pi.stderr).text()]);
    expect(piCode).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(authoritative);
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

test("restart failure diagnostics retain only bounded logs and database modes, with private paths redacted (#303)", () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-restart-diagnostics-"));
  const root = join(temp, "project"), home = join(temp, "home"), artifacts = join(temp, "artifacts");
  const state = join(root, ".agenthub", "state"), operation = "12345678-1234-1234-1234-123456789abc";
  mkdirSync(state, { recursive: true }); mkdirSync(join(home, "manager"), { recursive: true }); mkdirSync(join(home, "recovery"));
  try {
    writeFileSync(join(state, "hub.log"), "discarded-prefix\n" + "x".repeat(RESTART_LOG_BYTES) + `\nSQLiteError: database is locked\n at ${root}/hub.db\n at ${home}/registry.db\n at /Users/private-person/work/secret.db\n token=dont-upload-token\n`);
    writeFileSync(join(home, "manager", "manager.log"), "manager diagnostic\n");
    writeFileSync(join(state, "hub.db"), "dont-upload-db-contents"); chmodSync(join(state, "hub.db"), 0o600);
    writeFileSync(join(state, "hub.db-wal"), "dont-upload-wal-contents");
    writeFileSync(join(home, "registry.db"), "dont-upload-registry-contents");
    writeFileSync(join(home, "recovery", `${operation}.json.runner.db`), "dont-upload-runner-contents");
    for (const name of ["control-token", "status.json", "config.json"]) writeFileSync(join(state, name), "dont-upload-control-files");
    const result = retainRestartDiagnostics(root, home, operation, artifacts)!;
    expect(readdirSync(result).sort()).toEqual(["files.json", "hub.log", "manager.log"]);
    rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); // evidence survives fixture cleanup
    const log = readFileSync(join(result, "hub.log"), "utf8");
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(RESTART_LOG_BYTES);
    expect(log).toContain("SQLiteError: database is locked"); expect(log).not.toContain("discarded-prefix");
    expect(log).toContain("<fixture-project>/hub.db"); expect(log).toContain("<fixture-home>/registry.db");
    expect(log).toContain("<absolute-path>"); expect(log).toContain("token=<redacted>");
    for (const privateValue of [root, home, "/Users/private-person", "dont-upload-token"]) expect(log).not.toContain(privateValue);
    const metadata = JSON.parse(readFileSync(join(result, "files.json"), "utf8"));
    expect(metadata.logs["hub.log"]).toEqual({ available: true, copiedBytes: RESTART_LOG_BYTES, truncated: true });
    expect(metadata.databases["hub.db"]).toMatchObject({ mode: "600", regular: true });
    expect(metadata.databases["hub.db-shm"]).toEqual({ exists: false });
    expect(metadata.databases["runner.db"].regular).toBe(true);
    for (const file of readdirSync(result)) expect(readFileSync(join(result, file), "utf8")).not.toMatch(/dont-upload-(db|wal|registry|runner|control)/);
    expect(retainRestartDiagnostics("unused", "unused", undefined, "")).toBeUndefined();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

function restartDiagnosticsFixture() {
  const temp = mkdtempSync(join(tmpdir(), "ahub-diagnostics-review-"));
  const root = join(temp, "project"), home = join(temp, "home"), output = join(temp, "artifacts");
  const state = join(root, ".agenthub", "state"), operation = "12345678-1234-1234-1234-123456789abc";
  mkdirSync(state, { recursive: true }); mkdirSync(join(home, "manager"), { recursive: true }); mkdirSync(join(home, "recovery"));
  return { temp, root, home, state, operation, output, capture: (op = operation) => retainRestartDiagnostics(root, home, op, output)!, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

test("restart diagnostics redact named/quoted credentials, URLs and paths with spaces (#303)", () => {
  const f = restartDiagnosticsFixture();
  try {
    const lines = [
      "ANTHROPIC_API_KEY=secret-value-one", "GITHUB_TOKEN=secret-value-two", "access_token=secret-value-three", "client_secret=secret-value-four",
      '{"token":"secret-value-five","NAME_API_KEY":"secret-value-six"}',
      JSON.stringify({ NAME_TOKEN: 'secret-value-thirteen " escape-secret', cookie: "secret-value-fourteen" }),
      `https://example.invalid/api?${encodeURIComponent("테스트_TOKEN")}=secret-value-fifteen`,
      "Authorization: Bearer secret-value-seven", "Cookie: session=secret-value-eight; other=secret-value-nine",
      "https://private-user:secret-value-ten@example.invalid/api?access_token=secret-value-eleven&client_secret=secret-value-twelve",
      "cwd:/Users/private person/Secret Folder/database.db", "file:///Users/private-person/secret.db", "~/Secret Folder/secret.db",
      String.raw`C:\Users\private-person\Secret Folder\secret.db`, String.raw`\\private-server\Secret Folder\secret.db`,
      "private-person@example.invalid", "sk-secretvaluewithenoughcharacters", "ghp_secretvaluewithenoughcharacters",
      "SQLiteError: database is locked", ` at ${join(import.meta.dir, "..")}/src/hub/daemon.ts:3001:18`,
    ];
    writeFileSync(join(f.state, "hub.log"), lines.join("\n"));
    const capture = f.capture(), log = readFileSync(join(capture, "hub.log"), "utf8");
    expect(log).not.toMatch(/secret-value|private-person|private person|private-user|private-server|Secret Folder|secretvaluewithenoughcharacters|escape-secret/);
    expect(log).toContain("<redacted>"); expect(log).toContain("<redacted-key>"); expect(log).toContain("<email>"); expect(log).toContain("<absolute-path>");
    expect(log).toContain("SQLiteError: database is locked"); expect(log).toContain("<checkout>/src/hub/daemon.ts:3001:18");
  } finally { f.cleanup(); }
});

test("restart diagnostics discard partial first lines and cap redaction expansion (#303)", () => {
  const f = restartDiagnosticsFixture();
  try {
    const partial = "s/boundary-person/dir/file.db", tail = partial + "x".repeat(RESTART_LOG_BYTES - partial.length - 1) + "\n";
    writeFileSync(join(f.state, "hub.log"), "private-prefix/Users/" + tail);
    expect(readFileSync(join(f.capture(), "hub.log"), "utf8")).toBe("");
    writeFileSync(join(f.state, "hub.log"), "token=x\n".repeat(RESTART_LOG_BYTES / 8));
    const capture = f.capture(), log = readFileSync(join(capture, "hub.log"), "utf8");
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(RESTART_LOG_BYTES);
    expect(log).toContain("token=<redacted>"); expect(log).not.toContain("token=x");
  } finally { f.cleanup(); }
});

test("restart diagnostics refuse symlinked leaves and parent directories and nonregular files (#303)", () => {
  const f = restartDiagnosticsFixture(), outside = join(f.temp, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "hub.log"), "outside log must never be copied"); writeFileSync(join(outside, "manager.log"), "outside manager must never be copied");
  try {
    symlinkSync(join(outside, "hub.log"), join(f.state, "hub.log"));
    let captured = f.capture();
    expect(existsSync(join(captured, "hub.log"))).toBe(false); // removing O_NOFOLLOW must fail this assertion
    expect(JSON.parse(readFileSync(join(captured, "files.json"), "utf8")).logs["hub.log"].available).toBe(false);
    unlinkSync(join(f.state, "hub.log")); rmSync(f.state, { recursive: true }); symlinkSync(outside, f.state, "dir");
    rmSync(join(f.home, "manager"), { recursive: true }); symlinkSync(outside, join(f.home, "manager"), "dir");
    captured = f.capture();
    expect(existsSync(join(captured, "hub.log"))).toBe(false); expect(existsSync(join(captured, "manager.log"))).toBe(false);
    expect(() => readDiagnosticFile("/dev/null", "/dev", true)).toThrow("not a regular diagnostic file"); // removing fstat regular-file check must fail
    writeFileSync(join(outside, `${f.operation}.json`), JSON.stringify({ phase: "outside receipt" }));
    rmSync(join(f.home, "recovery"), { recursive: true }); symlinkSync(outside, join(f.home, "recovery"), "dir");
    expect(existsSync(join(f.capture(), "receipt.json"))).toBe(false);
  } finally { f.cleanup(); }
});

test("restart diagnostics retain only redacted receipt outcome fields and validate the operation id (#303)", () => {
  const f = restartDiagnosticsFixture();
  try {
    const receipt = { phase: "blocked", step: "commit:project-one", error: `registry read failed at ${f.home}/registry.db; GITHUB_TOKEN=secret-value-receipt`,
      failure: { code: "database_busy", retryable: true, site: [` at ${join(import.meta.dir, "..")}/src/cli/upgrade.ts:562:1`, " at /Users/private-person/registry.db:1:2"], private: "do-not-copy" },
      projects: [{ id: "project-one", phase: "prepared", commitSent: false, terminals: { token: "do-not-copy" } }, { id: "project-two", phase: "prepared", commitSent: true }],
      plan: { sourceRoot: "/private/checkout", secret: "do-not-copy" }, summary: "do-not-copy", token: "do-not-copy" };
    writeFileSync(join(f.home, "recovery", `${f.operation}.json`), JSON.stringify(receipt));
    const captured = f.capture(), text = readFileSync(join(captured, "receipt.json"), "utf8"), parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ phase: "blocked", step: "commit:project-one", failure: { code: "database_busy", retryable: true }, projects: [{ id: "project-one", phase: "prepared", commitSent: false }, { id: "project-two", phase: "prepared", commitSent: true }] });
    expect(parsed.failure.site).toEqual([" at <checkout>/src/cli/upgrade.ts:562:1", " at <absolute-path>"]);
    expect(text).not.toMatch(/secret-value|private-person|do-not-copy|sourceRoot|terminals|summary/);
    expect(text).not.toContain(f.home); expect(parsed.error).toContain("GITHUB_TOKEN=<redacted>");
    const invalid = "not-an-operation";
    writeFileSync(join(f.home, "recovery", `${invalid}.json`), JSON.stringify(receipt));
    writeFileSync(join(f.home, "recovery", `${invalid}.json.runner.db`), "untrusted runner");
    const rejected = f.capture(invalid);
    expect(existsSync(join(rejected, "receipt.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(rejected, "files.json"), "utf8")).databases["runner.db"]).toBeUndefined();
  } finally { f.cleanup(); }
});

test("the installed-layout full-body catch retains diagnostics before cleanup and preserves the original failure (#303)", async () => {
  const f = restartDiagnosticsFixture(), original = new Error("injected fixture assertion");
  const context = () => ({ root: f.root, home: f.home, operation: f.operation });
  try {
    expect(await withRestartDiagnostics(async () => 42, context, f.output)).toBe(42);
    expect(existsSync(f.output)).toBe(false); // passing full bodies never write an artifact
    writeFileSync(join(f.state, "hub.log"), "diagnostic present before cleanup\n");
    await expect(withRestartDiagnostics(async () => { throw original; }, context, f.output).finally(() => {
      rmSync(f.root, { recursive: true, force: true }); rmSync(f.home, { recursive: true, force: true });
    })).rejects.toBe(original);
    expect(readdirSync(f.output)).toHaveLength(1);
    const capture = join(f.output, readdirSync(f.output)[0]!);
    expect(readFileSync(join(capture, "hub.log"), "utf8")).toBe("diagnostic present before cleanup\n");
  } finally { f.cleanup(); }
});

test("a diagnostic capture failure preserves the original fixture error (#303)", async () => {
  const f = restartDiagnosticsFixture();
  try {
    const unavailable = join(f.temp, "not-a-directory");
    writeFileSync(unavailable, "occupied");
    const original = new Error("original fixture failure");
    await expect(withRestartDiagnostics(async () => { throw original; }, () => ({ root: f.root, home: f.home, operation: undefined }), join(unavailable, "capture"))).rejects.toBe(original);
  } finally { f.cleanup(); }
});

test("the installed-layout restart fixture retains diagnostics around its assertions (#303)", () => {
  const source = readFileSync(import.meta.filename, "utf8");
  const fixture = source.slice(source.indexOf('test("installed-layout detached restart'), source.indexOf('test(', source.indexOf('test("installed-layout detached restart') + 6));
  expect(fixture).toContain("await withRestartDiagnostics(async () => {");
});


test("installed-layout restart preserves an off-roster peer queue and open task without relaunch (#315)", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-roster-recovery-cli-"));
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
    await withRestartDiagnostics(async () => {
    expect((await cli(["init"])).code).toBe(0);
    writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, omniroute: { urls: [] } }));
    expect((await cli(["up"])).code).toBe(0);
    const stateDir = join(root, ".agenthub/state");
    const request = async (message: Record<string, unknown>) => {
      const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
      try { return await client.request(message); } finally { client.close(); }
    };
    const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", projectRoot: root, channel: false });
    try {
      let attached: any;
      for (let n = 0; n < 100; n++) { attached = await status(); if (attached.peers.claude?.state === "idle") break; }
      expect(attached.peers.claude.state).toBe("idle");
      const task = await request({ t: "task", op: "hub_task_propose", args: { title: "retained planner work", class: "plan", owner: "claude" } });
      expect(task.ok).toBe(true);
      const id = Number(task.text.match(/task #(\d+)/)![1]);
      expect((await request({ t: "pause", peer: "claude" })).ok).toBe(true);
      expect((await request({ t: "send", to: ["claude"], body: "retained installed-layout message" })).ok).toBe(true);
      const removed = await request({ t: "settings_set", key: "roster.claude", value: false, confirm: "claude" });
      expect(removed.ok).toBe(true); expect(removed.text).toContain("retained planner work stays with claude");
      const taskBefore = JSON.parse((await request({ t: "task", op: "task_show", args: { id } })).text);
      const queueBefore = (await request({ t: "queue", op: "list", peer: "claude" })).deliveries;
      const originals = queueBefore.flatMap((row: any) => row.envelopeIds).sort();
      expect(originals.length).toBeGreaterThanOrEqual(2);
      const before = await status(); expect(before.peers.claude).toMatchObject({ state: "offline", rostered: false });
      const plan = await cli(["restart", "--dry-run", "--json"]); expect(plan.code).toBe(0);
      const planned = JSON.parse(plan.out).projects[0]; expect(planned.blockers).toEqual([]);
      expect(planned.source.peers.find((row: any) => row.id === "claude").state).toBe("offline");
      expect(planned.reconnectOnly ?? []).not.toContain("claude"); expect(planned.terminals).toEqual([]);
      const applied = await cli(["restart", "--yes"]); expect(applied.code).toBe(0);
      operation = /Recovery operation ([a-f0-9-]{36}) scheduled/.exec(applied.out)?.[1]; expect(operation).toBeDefined();
      let receipt: any;
      const deadline = Date.now() + 10_000;
      do {
        receipt = JSON.parse(readFileSync(join(home, "recovery", `${operation}.json`), "utf8"));
        if (["completed", "blocked"].includes(receipt.phase)) break;
        await Bun.sleep(50);
      } while (Date.now() < deadline);
      expect({ phase: receipt.phase, step: receipt.step, error: receipt.error }).toEqual({ phase: "completed", step: "completed", error: undefined });
      const after = await status(); expect(after.instanceId).not.toBe(before.instanceId);
      expect(after.peers.claude).toMatchObject({ state: "offline", rostered: false, queued: before.peers.claude.queued });
      expect(JSON.parse((await request({ t: "task", op: "task_show", args: { id } })).text)).toEqual(taskBefore);
      const queueAfter = (await request({ t: "queue", op: "list", peer: "claude" })).deliveries;
      expect(queueAfter.flatMap((row: any) => row.envelopeIds).sort()).toEqual(originals);
      expect(queueAfter.every((row: any) => row.rostered === false && row.holdReason === "off roster")).toBe(true);
      expect((await request({ t: "settings_get" })).roster.find((row: any) => row.peer === "claude").on).toBe(false);
    } finally { peer.close(); }
    }, () => ({ root, home, operation }));
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
