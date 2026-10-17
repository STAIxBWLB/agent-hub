import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFingerprint, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";
import { claimRunner, writeOperation } from "../src/hub/recovery-store.ts";
import { realPath } from "../src/hub/project.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { VERSION } from "../src/version.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const OPERATION = "00000000-0000-4000-8000-000000000466", NOW = 1234567890;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/;

function fixture() {
  const temp = realPath(mkdtempSync(join(tmpdir(), "ahub-presentation-cli-")));
  cleanup.push(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "cwd"), home = join(temp, "hub-home"), bin = join(temp, "bin");
  for (const dir of [root, home, bin, join(temp, "home"), join(temp, "amem")]) mkdirSync(dir, { mode: 0o700 });
  const main = join(PACKAGE_ROOT, "src/cli/main.js"), wrapper = join(temp, "cli.ts"), calls = join(temp, "external-calls.jsonl");
  // Freeze only the child clock so repeated disposal of the same reset receipt is byte-comparable, including audit
  // timestamps. The actual CLI parser, recovery driver and filesystem claim/receipt paths remain in use.
  writeFileSync(wrapper, `Date.now = () => ${NOW};\nif(process.env.FIXTURE_TTY==='1'){Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stdout,'isTTY',{value:true});Object.defineProperty(process.stdout,'columns',{value:80});}\nprocess.argv = [process.execPath, ${JSON.stringify(main)}, ...JSON.parse(process.env.FIXTURE_ARGV!)];\nawait import(${JSON.stringify(main)});\n`);
  for (const name of ["npm", "claude"]) {
    const allowed = name === "npm" ? ["view", `@staix/agent-hub@${VERSION}`, "version", "dist.integrity", "--json"] : ["--version"];
    const output = name === "npm" ? JSON.stringify({ version: VERSION, "dist.integrity": "sha512-fixture-only" }) : "fixture Claude 1.0.0";
    const executable = join(bin, name);
    writeFileSync(executable, `#!${process.execPath}\nconst args=process.argv.slice(2);\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify({name:${JSON.stringify(name)},args})+'\\n');\nif(JSON.stringify(args)!==JSON.stringify(${JSON.stringify(allowed)}))process.exit(83);\nconsole.log(${JSON.stringify(output)});\n`);
    chmodSync(executable, 0o700);
  }
  // An explicit child environment excludes every inherited identity, daemon selector, Orca binding and credential.
  const env: NodeJS.ProcessEnv = { HOME: join(temp, "home"), AGENTHUB_HOME: home, AMEM_HOME: join(temp, "amem"),
    PATH: `${bin}:/usr/bin:/bin`, TERM: "dumb", COLUMNS: "18", LANG: "C", CI: "1",
    AGENTHUB_PEER_ID: undefined, AGENTHUB_DELIVERY_ONLY: undefined, AGENTHUB_PROJECT_DIR: undefined, AGENTHUB_STATE_DIR: undefined,
    AGENTHUB_INSTANCE_ID: undefined, AGENTHUB_LAUNCH_ID: undefined, AGENTHUB_RECOVERY_OPERATION: undefined,
    CLAUDECODE: undefined, CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined };
  const cli = async (args: string[], tty = false) => {
    const child = Bun.spawn([process.execPath, wrapper], { cwd: root, env: { ...env, FIXTURE_ARGV: JSON.stringify(args), FIXTURE_TTY: tty ? "1" : "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err };
  };
  const missing = join(temp, "confirmed-missing-project");
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "restart", version: VERSION, sourceRoot: PACKAGE_ROOT, sourceDigest: "fixture-source",
    projects: [{ project: { id: "fixture-missing", root: missing, stateDir: join(missing, "state"), basePort: 4600, instanceId: "source-instance", pid: null },
      source: { state: "running", instanceId: "source-instance", version: VERSION, protocol: PROTOCOL, peers: [], blockers: [] }, terminals: [], blockers: [] }], blockers: [] };
  const plan = { ...body, fingerprint: planFingerprint(body) };
  const operation = (phase: "completed" | "blocked" = "completed"): RecoveryOperation => ({ schema: 1, id: OPERATION, plan, sourceRoot: PACKAGE_ROOT,
    createdAt: 1, updatedAt: 1, phase, step: phase === "completed" ? "completed" : "stage", projects: [{ id: "fixture-missing", phase: phase === "completed" ? "verified" : "pending", terminals: {} }] });
  const reset = (phase: "completed" | "blocked" = "completed") => { const receipt = operation(phase); writeOperation(OPERATION, receipt, home); return receipt; };
  const completedProjection = {
    id: OPERATION, phase: "completed", step: "completed", version: VERSION, updatedAt: 1, runner: { state: "none" },
    projects: [{ id: "fixture-missing", phase: "verified", recordedSessions: ["codex", "pi", "claude"].map(peer => ({ peer,
      note: `${peer}: recorded session identity unavailable; inspect the retained recovery receipt before choosing a conversation` })) }],
    pluginInstalled: false, globalInstalled: false, next: [],
  };
  return { temp, root, home, cli, calls, reset, operation, completedProjection,
    readReceipt: () => JSON.parse(readFileSync(join(home, "recovery", `${OPERATION}.json`), "utf8")) as RecoveryOperation };
}

test("#466 recovery status pipe output remains byte-identical to the prior raw JSON projection", async () => {
  const f = fixture(); f.reset();
  const plain = await f.cli(["recovery", "status", OPERATION]);
  expect(plain.code, plain.err).toBe(0);
  const expected = JSON.stringify(f.completedProjection, null, 2) + "\n";
  expect(plain.out).toBe(expected);
  const never = await f.cli(["recovery", "status", OPERATION, "--color=never"]);
  expect(never.code, never.err).toBe(0);
  expect(never.out).toBe(plain.out); expect(never.err).toBe(plain.err);
  expect(never.out).not.toMatch(ANSI);
}, 15_000);

test("#466 restart dry-run and default pipe retain the old plan document and never start a runtime", async () => {
  const f = fixture();
  const plain = await f.cli(["restart", "--dry-run"]);
  expect(plain.code, plain.err).toBe(0);
  const parsed = JSON.parse(plain.out);
  expect(Object.keys(parsed)).toEqual(["schema", "kind", "version", "sourceRoot", "sourceDigest", "projects", "blockers", "fingerprint"]);
  expect(parsed.sourceDigest).toMatch(/^[a-f0-9]{64}$/); expect(parsed.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const knownPlan = { schema: 1, kind: "restart", version: VERSION, sourceRoot: PACKAGE_ROOT, sourceDigest: parsed.sourceDigest,
    projects: [], blockers: ["no running registered projects in scope"], fingerprint: parsed.fingerprint };
  expect(plain.out).toBe(JSON.stringify(knownPlan, null, 2) + "\n");
  const never = await f.cli(["restart", "--color=never", "--dry-run"]);
  expect(never.code, never.err).toBe(0); expect(never.out).toBe(plain.out); expect(never.err).toBe(plain.err);
  const defaultPipe = await f.cli(["restart"]), neverPipe = await f.cli(["restart", "--color=never"]);
  expect(defaultPipe.code).toBe(1); expect(defaultPipe.err).toContain("plan has blockers; no runtime was changed");
  expect(neverPipe.code).toBe(defaultPipe.code); expect(neverPipe.out).toBe(defaultPipe.out); expect(neverPipe.err).toBe(defaultPipe.err);
  expect(defaultPipe.out).toBe(plain.out);
}, 15_000);

test("#466 explicit-version upgrade plan is identical in default and never-color pipes using closed-list metadata fakes", async () => {
  const f = fixture();
  const plain = await f.cli(["upgrade", "--to", VERSION, "--dry-run"]);
  expect(plain.code, plain.err).toBe(0);
  const never = await f.cli(["upgrade", "--to", VERSION, "--dry-run", "--color=never"]);
  expect(never.code, never.err).toBe(0); expect(never.out).toBe(plain.out); expect(never.err).toBe(plain.err);
  const plan = JSON.parse(plain.out);
  expect(Object.keys(plan)).toEqual(["schema", "kind", "version", "sourceRoot", "sourceDigest", "integrity", "projects", "blockers", "fingerprint"]);
  expect(plan.kind).toBe("upgrade"); expect(plan.version).toBe(VERSION); expect(plan.integrity).toBe("sha512-fixture-only");
  const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls).toEqual([
    { name: "npm", args: ["view", `@staix/agent-hub@${VERSION}`, "version", "dist.integrity", "--json"] }, { name: "claude", args: ["--version"] },
    { name: "npm", args: ["view", `@staix/agent-hub@${VERSION}`, "version", "dist.integrity", "--json"] }, { name: "claude", args: ["--version"] },
  ]);
}, 15_000);

test("#466 stop-and-archive of a confirmed missing project preserves default pipe bytes with color disabled", async () => {
  const f = fixture(), args = ["recovery", "dispose", OPERATION, "--stop-and-archive", "--reason", "fixture exit"];
  f.reset("blocked"); const plain = await f.cli(args);
  expect(plain.code, plain.err).toBe(0);
  expect(f.readReceipt().phase).toBe("cancelled");
  expect(plain.out).toContain('"phase": "cancelled"');
  expect(plain.out).toContain("restart abandoned, not completed; committed transitions were not rolled back.");
  f.reset("blocked"); const never = await f.cli([...args, "--color=never"]);
  expect(never.code, never.err).toBe(0); expect(never.out).toBe(plain.out); expect(never.err).toBe(plain.err);
  expect(never.out).not.toMatch(ANSI);
}, 15_000);

for (const color of [undefined, "never", "always"] as const) {
  test(`#466 explicit JSON status remains one uncolored, unwrapped raw document (color=${color ?? "default"})`, async () => {
    const f = fixture(); f.reset();
    const result = await f.cli(["recovery", "--json", "status", OPERATION, "--verbose", ...(color ? [`--color=${color}`] : [])]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual(f.completedProjection);
    expect(result.out).toBe(JSON.stringify(f.completedProjection, null, 2) + "\n");
    expect(result.out).not.toMatch(ANSI);
  }, 15_000);
}

for (const color of [undefined, "never"] as const) {
  test(`#466 explicit JSON disposition has no appended human summary (color=${color ?? "default"})`, async () => {
    const f = fixture(); f.reset("blocked");
    const result = await f.cli(["recovery", "dispose", OPERATION, "--stop-and-archive", "--reason", "fixture JSON exit", "--json", ...(color ? [`--color=${color}`] : [])]);
    expect(result.code, result.err).toBe(0);
    const projection = JSON.parse(result.out);
    expect(Object.keys(projection)).toEqual(["id", "phase", "step", "version", "updatedAt", "runner", "projects", "pluginInstalled", "globalInstalled", "disposition", "audit", "next"]);
    expect(projection.phase).toBe("cancelled"); expect(projection.updatedAt).toBe(NOW);
    expect(projection.disposition.projects["fixture-missing"]).toBe("project directory is missing; nothing was stopped or archived (ahub doctor --orphans lists a hub left running there)");
    expect(projection.audit[0].reason).toBe("fixture JSON exit");
    expect(result.out).toBe(JSON.stringify(projection, null, 2) + "\n"); expect(result.out).not.toMatch(ANSI);
    expect(result.out).not.toContain("committed transitions were not rolled back.");
  }, 15_000);
}

test("#466 a reason whose literal value is --json is never consumed as a presentation flag", async () => {
  const f = fixture(); f.reset("blocked");
  const result = await f.cli(["recovery", "dispose", OPERATION, "--stop-and-archive", "--reason", "--json", "--color=never"]);
  expect(result.code, result.err).toBe(0);
  expect(f.readReceipt().audit?.[0]?.reason).toBe("--json");
  expect(result.out).toContain("committed transitions were not rolled back.");
}, 15_000);

test("#466 explicit JSON resume of a completed operation returns its receipt without scheduling", async () => {
  const f = fixture(); f.reset();
  const result = await f.cli(["recovery", "resume", OPERATION, "--json"]);
  expect(result.code, result.err).toBe(0);
  expect(result.out).toBe(JSON.stringify(f.completedProjection, null, 2) + "\n");
}, 15_000);

test("#466 explicit JSON preflight abort returns only the saved cancelled receipt", async () => {
  const f = fixture(); f.reset("blocked");
  const result = await f.cli(["recovery", "abort", OPERATION, "--json", "--color=never"]);
  expect(result.code, result.err).toBe(0);
  const projection = JSON.parse(result.out);
  expect(projection.phase).toBe("cancelled"); expect(projection.next).toEqual([]);
  expect(f.readReceipt().phase).toBe("cancelled");
  expect(result.out).toBe(JSON.stringify(projection, null, 2) + "\n");
}, 15_000);

test("#466 reattach handover carries resolved colour and verbose to a capable retained coordinator", async () => {
  const f = fixture(), coordinator = join(f.temp, "retained coordinator with a long path"), folder = join(coordinator, "src/cli"), recorded = join(f.temp, "handover-args.json");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "upgrade.ts"), "export async function disposeRecovery() {}\nexport async function reattachRecovery() {}\n");
  writeFileSync(join(folder, "upgrade-presentation-flags.ts"), "// fixture parser capability\n");
  writeFileSync(join(folder, "main.js"), `require('node:fs').writeFileSync(${JSON.stringify(recorded)},JSON.stringify(process.argv.slice(2)));\n`);
  const op = f.reset("blocked"); op.sourceRoot = coordinator; writeOperation(OPERATION, op, f.home);
  const result = await f.cli(["recovery", "reattach", OPERATION, "pi", "--color=never", "--verbose"], true);
  expect(result.code, result.err).toBe(0);
  expect(JSON.parse(readFileSync(recorded, "utf8"))).toEqual(["recovery", "reattach", OPERATION, "pi", "--color=never", "--verbose"]);
}, 15_000);

test("#466 TTY resume with an existing runner hides internal paths unless verbose while pipe bytes stay exact", async () => {
  const f = fixture(); f.reset("blocked"); cleanup.push(claimRunner(OPERATION, f.home));
  const pipe = await f.cli(["recovery", "resume", OPERATION, "--color=never"]);
  expect(pipe.code, pipe.err).toBe(0);
  expect(pipe.out).toBe(`runner ${process.pid} is still working on this operation; bun ${join(PACKAGE_ROOT, "src/cli/main.js")} recovery status ${OPERATION}\n`);
  const tty = await f.cli(["recovery", "resume", OPERATION, "--color=never"], true);
  expect(tty.code, tty.err).toBe(0); expect(tty.out).toContain(`ahub recovery status ${OPERATION}`); expect(tty.out).not.toContain("bun "); expect(tty.out).not.toMatch(ANSI);
  for (const line of tty.out.trimEnd().split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  const verbose = await f.cli(["recovery", "resume", OPERATION, "--color=never", "--verbose"], true);
  expect(verbose.code, verbose.err).toBe(0); expect(verbose.out).toContain("bun "); expect(verbose.out).toContain("main.js");
  for (const line of verbose.out.trimEnd().split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
}, 15_000);
