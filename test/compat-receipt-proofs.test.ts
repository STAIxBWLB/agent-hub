import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeProofs } from "../scripts/compat-receipts/proofs/claude.ts";
import { runReviewerProofs } from "../scripts/compat-receipts/proofs/reviewers.ts";
import { runManifestProofs } from "../scripts/compat-receipts/proofs.ts";
import { runBoundedReceiptCommand } from "../scripts/compat-receipts/runner.ts";
import { runCompatReceipt } from "../scripts/compat-receipt.ts";
import type { CommandResult, InstalledArtifact, ManifestEntry, ProofContext, ReceiptCommand } from "../scripts/compat-receipts/types.ts";
import { realPath } from "../src/hub/project.ts";
import { shellQuote } from "../src/cli/shell-quote.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const CASES = ["allow", "deny", "missing-tool", "hook-deny", "hook-allow", "mcp-error", "disconnect", "pending", "deadline"];
const WRAPPER = ["wrapper-cwd", "wrapper-root", "wrapper-executable", "wrapper-poison-env", "wrapper-host-env", "wrapper-tmp", "wrapper-replay", "wrapper-effect-once", "wrapper-quoted-paths", "wrapper-cleanup", "wrapper-binary-fence"];
const entry = (id: string): ManifestEntry => ({ receipt: "fixture.md", runnerOS: ["linux", "macos"], nativePlatform: "fixture", autoAdmit: true,
  install: { method: "fixture" }, legs: [{ id, label: id, category: "linux-ci", runnerOS: ["linux", "macos"], requiredForAdmission: true }] });
function artifact(prefix: string, marker: string): InstalledArtifact {
  const executable = join(prefix, "fake-native");
  writeFileSync(executable, `#!/bin/sh\n: > ${shellQuote(marker)}\n`, { mode: 0o700 });
  return { command: [executable], packageRoot: prefix, method: "fixture", integrity: "sha256:fixture" };
}
function fixture(): ProofContext & { marker: string } {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-compat-receipt-proofs-"))); roots.push(root);
  const home = join(root, "home"), prefix = join(root, "prefix"), cwd = join(root, "project"), bin = join(root, "bin");
  for (const dir of [home, prefix, cwd, bin]) mkdirSync(dir, { mode: 0o700 });
  // Discovery only. Every Claude producer invocation below is intercepted by the typed command port.
  writeFileSync(join(bin, "python3"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LANG: "C", LC_ALL: "C", TZ: "UTC", TERM: "dumb" };
  for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "AGENTHUB_HOME", "AMEM_HOME", "CODEX_HOME", "KIMI_CODE_HOME", "CLAUDE_CONFIG_DIR"]) {
    const dir = join(root, key.toLowerCase()); mkdirSync(dir, { mode: 0o700 }); env[key] = dir;
  }
  const marker = join(root, "native-executed");
  return { id: "claude-implementer", version: "9.9.9", root, home, prefix, cwd, env, marker, artifact: artifact(prefix, marker),
    entry: entry("fixture"), signal: new AbortController().signal,
    limits: { totalMs: 10_000, installMs: 5_000, legMs: 5_000, outputBytes: 64 * 1024, artifactBytes: 1024, expandedBytes: 1024, archiveEntries: 10 },
    run: async () => { throw Error("unexpected command port"); } };
}
type Fault = "exit" | "command-cleanup" | "missing-native-cleanup" | "native-cleanup" | "wrapper-cleanup";
function claudePort(f: ProofContext, calls: string[][], fault?: Fault): ReceiptCommand {
  return async argv => {
    calls.push([...argv]);
    const producer = argv.findIndex(arg => arg.endsWith("-native.py"));
    expect(producer).toBeGreaterThan(0);
    const output = argv[producer + 1]!; mkdirSync(output, { mode: 0o700 });
    const wrapper = output.endsWith("claude-wrapper"), rewrite = output.endsWith("claude-rewrite");
    const cases = wrapper ? ["context", "normalized"] : rewrite ? ["allow", "deny"] : CASES;
    const rows = cases.map(name => ({ case: name, version: f.version, passed: true, binaryUnchanged: true,
      ...(fault === "missing-native-cleanup" ? {} : { nativeGroupEmpty: fault !== "native-cleanup" }),
      ...(wrapper ? { hostStopped: fault !== "wrapper-cleanup", persistentCwd: true, rewrite: true, priorCd: true,
        environmentIsolation: true, replayRefused: true, effects: 1, quotedPaths: true } : {}) }));
    writeFileSync(join(output, "receipt.json"), JSON.stringify({ account: false, inference: false, certified: true, cases: rows }), { mode: 0o600 });
    return { exitCode: fault === "exit" ? 1 : 0, stdout: "fixture output", stderr: "", timedOut: false, cleanup: fault !== "command-cleanup" };
  };
}

test("Claude module maps all transport/rewrite/wrapper legs through the actual command port and production arguments", async () => {
  const f = fixture(), calls: string[][] = [], results = await runClaudeProofs({ ...f, run: claudePort(f, calls) });
  const expected = [...CASES.map(name => `write-${name}`), ...CASES.map(name => `bash-${name}`), "bash-rewrite-allow", "bash-rewrite-deny", ...WRAPPER];
  expect(Object.keys(results).sort()).toEqual(expected.sort());
  expect(Object.values(results).every(row => row.status === "pass" && row.cause === "ok")).toBe(true);
  expect(calls).toHaveLength(4);
  const bash = calls.find(args => args.includes("--tool") && !args.includes("--rewrite-bash"))!;
  expect(bash.slice(bash.indexOf("--tool"))).toEqual(["--tool", "Bash", "--server-name", "agent-hub", "--permission-tool", "hub_permission_request", "--require-tool-use-id"]);
  const rewrite = calls.find(args => args.includes("--rewrite-bash"))!;
  expect(rewrite).toContain("--require-tool-use-id");
  const wrapper = calls.find(args => args.includes("--bun"))!;
  expect(wrapper[wrapper.indexOf("--bun") + 1]).toBe(process.execPath);
  expect(calls.every(args => args[args.indexOf("--expected-version") + 1] === f.version)).toBe(true);
  expect(existsSync(f.marker)).toBe(false);
});

test("Claude producer exit failure overrides otherwise fully passing receipt rows", async () => {
  const f = fixture(), results = await runClaudeProofs({ ...f, run: claudePort(f, [], "exit") });
  expect(Object.keys(results)).toHaveLength(31);
  expect(Object.values(results).every(row => row.status === "fail" && row.cause === "proof-failed")).toBe(true);
});

for (const fault of ["command-cleanup", "missing-native-cleanup", "native-cleanup"] as const) test(`Claude module refuses ${fault} despite passed receipt flags`, async () => {
  const f = fixture(), results = await runClaudeProofs({ ...f, run: claudePort(f, [], fault) });
  expect(Object.values(results).every(row => row.status === "fail" && row.cause === "cleanup")).toBe(true);
});

test("Claude wrapper host cleanup is required independently of native group cleanup", async () => {
  const f = fixture(), results = await runClaudeProofs({ ...f, run: claudePort(f, [], "wrapper-cleanup") });
  expect(WRAPPER.every(id => results[id]?.status === "fail" && results[id]?.cause === "cleanup")).toBe(true);
  expect(results["write-allow"]).toEqual({ status: "pass", cause: "ok" });
});

test("reviewer module rejects the caller HOME before importing preparation or executing a candidate", async () => {
  const f = fixture(), before = readdirSync(f.root);
  // Do not rewrite process.env or supply any account home. This fresh fixture cannot be the caller's HOME.
  expect(process.env.HOME).not.toBe(f.home);
  await expect(runReviewerProofs({ ...f, id: "codex-review" })).rejects.toMatchObject({ causeCode: "input" });
  expect(existsSync(f.marker)).toBe(false);
  expect(readdirSync(f.root)).toEqual(before);
});

test("manifest dispatcher runs the actual isolated worker for unsupported qwen and never executes its artifact", async () => {
  const f = fixture();
  const results = await runManifestProofs({ ...f, id: "qwen", entry: entry("native-acp-auth-session-modes"), run: runBoundedReceiptCommand });
  expect(results).toEqual({});
  expect(existsSync(f.marker)).toBe(false);
  expect(readdirSync(f.root).some(name => name.startsWith("request-"))).toBe(false);
}, 20_000);

test("default qwen receipt wiring records not-run after the real worker, with only fake installation", async () => {
  const f = fixture(), calls: { argv: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const result = await runCompatReceipt({ id: "qwen", version: "9.9.9", out: join(f.root, "output") }, {
    entry: entry("native-acp-auth-session-modes"),
    install: async context => artifact(context.prefix, f.marker),
    run: async (argv, options): Promise<CommandResult> => {
      calls.push({ argv, env: options.env, cwd: options.cwd });
      return await runBoundedReceiptCommand(argv, options);
    },
    limits: { totalMs: 10_000, installMs: 5_000, legMs: 5_000 },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.argv[1]).toContain("proof-worker.ts");
  expect(calls[0]!.env.HOME).not.toBe(process.env.HOME);
  expect(calls[0]!.env.AGENTHUB_PEER_ID).toBeUndefined();
  expect(calls[0]!.env.NODE_OPTIONS).toBeUndefined();
  expect(result.legs).toMatchObject([{ id: "native-acp-auth-session-modes", status: "not-run", cause: "producer-not-committed" }]);
  expect(result.outcome).toBe("not-run"); expect(result.eligible).toBe(false);
  expect(result.cleanupConfirmed).toBe(true);
  expect(existsSync(f.marker)).toBe(false);
}, 20_000);
