import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runQwenProofs } from "../scripts/compat-receipts/proofs/qwen.ts";
import { runBoundedReceiptCommand } from "../scripts/compat-receipts/runner.ts";
import type { ManifestEntry, ProofContext } from "../scripts/compat-receipts/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ACP = "native-acp-auth-session-modes", PERMISSION = "actual-published-permission-handler", NETWORK = "preload-network-cleanup";
function fixture(fault?: string): ProofContext {
  const root = mkdtempSync(join(tmpdir(), "ahub-qwen-receipt-")); roots.push(root);
  const home = join(root, "home"), prefix = join(root, "prefix"), cwd = join(root, "project"), packageRoot = join(prefix, "node_modules/@qwen-code/qwen-code");
  for (const folder of [home, cwd, join(packageRoot, "chunks")]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const code = new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(readFileSync(join(import.meta.dir, "fakes/compat-receipt-qwen.ts"), "utf8"));
  const cli = join(packageRoot, "cli-entry.js"); writeFileSync(cli, code, { mode: 0o755 });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@qwen-code/qwen-code", type: "module", version: "9.8.7", fixtureFault: fault }));
  writeFileSync(join(packageRoot, "chunks/acpAgent-FIXTURE.js"), `
const fault=${JSON.stringify(fault)};
if(Object.values(process.env).some(value=>value?.includes('PARENT_QWEN_CANARY')))throw Error('parent credential reached permission import');
class SubAgentTracker {
  toolStates=new Map();
  constructor(context,client){this.context=context;this.client=client;}
  toolKey(event){return event.callId;}
  createApprovalHandler(){return async event=>{
    const options=toPermissionOptions();
    const params={sessionId:this.context.sessionId,toolCall:{toolCallId:event.callId,status:'pending',rawInput:this.toolStates.get(this.toolKey(event)).args,_meta:{toolName:fault==='permission-meta'?'wrong':event.name}},options};
    const response=await this.client.requestPermission(params);
    const outcome=resolvePermissionOutcome(response,options);
    await event.respond(fault==='permission-cancel'&&outcome==='cancel'?'proceed_once':outcome);
  };}
}
function toPermissionOptions(){return [['proceed_always_project','allow_always'],['proceed_always_user','allow_always'],[fault==='permission-options'?'wrong':'proceed_once','allow_once'],['cancel','reject_once']].map(([optionId,kind])=>({optionId,kind}));}
function resolvePermissionOutcome(value,options){if(value.outcome.outcome==='cancelled')return 'cancel';const id=value.outcome.optionId;if(!options.some(option=>option.optionId===id)){if(fault==='permission-unoffered')return 'proceed_once';throw Error('unoffered option');}return id;}
`);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, OPENAI_API_KEY: "PARENT_QWEN_CANARY_OPENAI", ANTHROPIC_API_KEY: "PARENT_QWEN_CANARY_ANTHROPIC" };
  for (const name of ["TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "QWEN_HOME", "QWEN_RUNTIME_DIR"]) {
    const folder = join(root, name.toLowerCase()); mkdirSync(folder, { mode: 0o700 }); env[name] = folder;
  }
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../scripts/compat-receipts/manifest.json"), "utf8")) as { entries: Record<string, ManifestEntry> };
  return { id: "qwen", version: "9.8.7", root, home, prefix, cwd, env, signal: new AbortController().signal,
    limits: { totalMs: 20_000, installMs: 1000, legMs: 10_000, outputBytes: 1024 * 1024, artifactBytes: 1024 * 1024, expandedBytes: 2 * 1024 * 1024, archiveEntries: 10 },
    artifact: { method: "npm-exact", integrity: `sha512-${createHash("sha512").update(code).digest("base64")}`, packageRoot, command: [cli] },
    entry: manifest.entries.qwen!, run: runBoundedReceiptCommand };
}

test("the committed Qwen promotions exercise the exact fake candidate, RPC mode walk and permission callback without parent credentials", async () => {
  const context = fixture(), before = { ...context.env }, source = readFileSync(join(context.artifact.packageRoot, "chunks/acpAgent-FIXTURE.js"));
  const result = await runQwenProofs(context);
  for (const id of ["artifact-private-install-integrity", ACP, PERMISSION, NETWORK]) expect(result[id], id).toEqual({ status: "pass", cause: "ok" });
  expect(result["reviewed-optional-lifecycle-replay"]).toEqual({ status: "not-run", cause: "source-review-required" });
  expect(result["native-macos-repetition"]?.status).toBe(process.platform === "darwin" && process.arch === "arm64" ? "pass" : "not-run");
  const childHome = join(context.root, "qwen-producer/acp/home");
  const calls = readFileSync(join(childHome, "fixture-methods.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(call => call.method)).toEqual(["initialize", "session/new", "session/set_mode", "session/set_mode", "session/set_mode", "session/set_mode"]);
  expect(calls.filter(call => call.method === "session/set_mode").map(call => call.modeId)).toEqual(["default", "auto-edit", "yolo", "default"]);
  const observed = JSON.parse(readFileSync(join(childHome, "fixture-environment.jsonl"), "utf8").trim());
  expect(observed).toMatchObject({ home: childHome, runtime: childHome, fixtureKey: true, parentCanary: false });
  expect(context.env).toEqual(before);
  expect(readFileSync(join(context.artifact.packageRoot, "chunks/acpAgent-FIXTURE.js"))).toEqual(source);
  expect(readdirSync(join(context.artifact.packageRoot, "chunks"))).toEqual(["acpAgent-FIXTURE.js"]);
}, 20_000);

test("canonical Qwen helpers load the actual network preload from a path containing spaces", async () => {
  const context = fixture(), original = join(import.meta.dir, "../scripts/compat-receipts/proofs");
  const relocated = join(context.root, "producer helpers with spaces 한글"), helpers = join(relocated, "scripts/compat-receipts/proofs"), project = join(relocated, "src/hub");
  mkdirSync(helpers, { recursive: true, mode: 0o700 }); mkdirSync(project, { recursive: true, mode: 0o700 });
  // Relocate canonical files byte-for-byte; keep the production path helper single-sourced.
  for (const name of ["qwen.ts", "qwen-acp.py", "qwen-permission.mjs", "qwen-network.cjs"]) copyFileSync(join(original, name), join(helpers, name));
  writeFileSync(join(project, "project.ts"), `export { realPath } from ${JSON.stringify(new URL("../src/hub/project.ts", import.meta.url).href)};\n`);
  const nativeRun = context.run, positiveLog = join(context.root, "permission-positive.log"); let permissionControlPassed = false;
  context.run = async (argv, options) => {
    if (argv[1] === join(helpers, "qwen-permission.mjs")) {
      const control = await nativeRun([argv[0]!, "-e", "try{require('node:net').connect(9,'203.0.113.1');process.exit(4)}catch(error){if(error.message!=='model-free receipt refuses network')throw error;process.stdout.write('NETWORK_BLOCKED')}"],
        { ...options, env: { ...options.env, PROBE_NETWORK_LOG: positiveLog } });
      expect(control.exitCode).toBe(0); expect(control.stdout).toBe("NETWORK_BLOCKED"); expect(control.ownedStopConfirmed).toBe(true); expect(control.timedOut).toBe(false);
      permissionControlPassed = true;
    }
    return nativeRun(argv, options);
  };
  const relocatedProducer = await import(pathToFileURL(join(helpers, "qwen.ts")).href) as { runQwenProofs(context: ProofContext): ReturnType<typeof runQwenProofs> };
  const result = await relocatedProducer.runQwenProofs(context);
  expect(result[ACP]).toEqual({ status: "pass", cause: "ok" }); expect(result[PERMISSION]).toEqual({ status: "pass", cause: "ok" }); expect(result[NETWORK]).toEqual({ status: "pass", cause: "ok" });
  expect(permissionControlPassed).toBe(true); expect(readFileSync(positiveLog, "utf8")).toContain("blocked network attempt");
  const native = JSON.parse(readFileSync(join(context.root, "qwen-producer/acp-result.json"), "utf8"));
  expect(native.guardPositiveControl).toBe(true); expect(native.groupGone).toBe(true);
  expect(readFileSync(join(context.root, "qwen-producer/acp/network-positive.log"), "utf8")).toContain("blocked network attempt");
  const input = JSON.parse(readFileSync(join(context.root, "qwen-producer/acp-input.json"), "utf8"));
  expect(input.guard).toBe(join(helpers, "qwen-network.cjs")); expect(input.guard).toContain("producer helpers with spaces 한글");
  expect(readFileSync(input.guard)).toEqual(readFileSync(join(original, "qwen-network.cjs")));
}, 20_000);

for (const fault of ["identity", "version", "protocol", "auth", "default-mode", "model", "missing-mode", "mode-ack"] as const) test(`Qwen ACP ${fault} cannot become a passing native leg`, async () => {
  const result = await runQwenProofs(fixture(fault));
  expect(result[ACP]).toEqual({ status: "fail", cause: "proof-failed" });
}, 20_000);

for (const fault of ["permission-meta", "permission-options", "permission-cancel", "permission-unoffered"] as const) test(`the actual promoted permission assertions reject ${fault}`, async () => {
  const context = fixture(fault), result = await runQwenProofs(context);
  expect(result[ACP]).toEqual({ status: "pass", cause: "ok" });
  expect(result[PERMISSION]).toEqual({ status: "fail", cause: "proof-failed" });
  expect(readdirSync(join(context.artifact.packageRoot, "chunks"))).toEqual(["acpAgent-FIXTURE.js"]);
}, 20_000);

test("candidate package/version binding refuses before any fake protocol or callback executes", async () => {
  const context = fixture(); context.version = "0.0.0";
  const result = await runQwenProofs(context);
  expect(result[ACP]?.status).toBe("fail"); expect(result[PERMISSION]?.status).toBe("fail");
  expect(existsSync(join(context.root, "qwen-producer"))).toBe(false);
});

test("Qwen producer stop failure overrides optimistic report flags", async () => {
  const context = fixture(), nativeRun = context.run;
  context.run = async (argv, options) => ({ ...await nativeRun(argv, options), ownedStopConfirmed: false });
  const result = await runQwenProofs(context);
  expect(result[ACP]).toEqual({ status: "fail", cause: "cleanup" });
  expect(result[PERMISSION]).toEqual({ status: "fail", cause: "cleanup" });
  expect(result[NETWORK]).toEqual({ status: "fail", cause: "cleanup" });
}, 20_000);

test("importing the promoted Python and JavaScript producer modules has no proof side effects", async () => {
  const context = fixture(), python = Bun.which("python3", { PATH: context.env.PATH! }), node = Bun.which("node", { PATH: context.env.PATH! });
  expect(python).not.toBeNull(); expect(node).not.toBeNull();
  const directory = join(import.meta.dir, "../scripts/compat-receipts/proofs");
  const py = await context.run([python!, "-I", "-c", "import importlib.util,sys; spec=importlib.util.spec_from_file_location('qwen_receipt',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)", join(directory, "qwen-acp.py")],
    { cwd: context.cwd, env: { PATH: context.env.PATH, HOME: context.home }, signal: context.signal, timeoutMs: 5000 });
  const js = await context.run([node!, "--input-type=module", "-e", "await import(process.argv[1])", new URL("../scripts/compat-receipts/proofs/qwen-permission.mjs", import.meta.url).href],
    { cwd: context.cwd, env: { PATH: context.env.PATH, HOME: context.home }, signal: context.signal, timeoutMs: 5000 });
  expect(py.exitCode).toBe(0); expect(js.exitCode).toBe(0);
  expect(existsSync(join(context.root, "qwen-producer"))).toBe(false);
}, 20_000);


test("a pre-existing exports path is refused and never deleted as producer-owned scratch", async () => {
  const context = fixture(), sentinel = join(context.artifact.packageRoot, "chunks/compat-receipt-qwen-exports.mjs");
  writeFileSync(sentinel, "candidate-owned sentinel");
  const result = await runQwenProofs(context);
  expect(result[PERMISSION]?.status).toBe("fail"); expect(readFileSync(sentinel, "utf8")).toBe("candidate-owned sentinel");
});
