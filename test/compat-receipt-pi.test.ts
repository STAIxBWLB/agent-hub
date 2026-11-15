import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPiProofs } from "../scripts/compat-receipts/proofs/pi.ts";
import type { CommandResult, ProofContext, ReceiptCommand } from "../scripts/compat-receipts/types.ts";

// #1248: the committed Pi producer. The command port is the fake: it answers each native command the way the 1.5.x CLI and SDK do and talks to the producer's REAL loopback bridge
// (so the real PiToolReceipts ledger, the bearer check and the provider counter run), which makes every leg's failure condition testable without installing Pi or using any account.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ok = (stdout: string, stderr = ""): CommandResult => ({ exitCode: 0, stdout, stderr, timedOut: false, ownedStopConfirmed: true, survivorDetected: false, processCleanup: "unproven", processCleanupReason: "fixture" });

type Fault = "none" | "version" | "version-stderr" | "no-shutdown" | "messages" | "provider" | "double-effect" | "denied-ok" | "extension" | "host" | "cleanup" | "stop-unconfirmed";
function fixture(fault: Fault = "none") {
  const root = mkdtempSync(join(tmpdir(), "ahub-pi-receipt-")); roots.push(root);
  const home = join(root, "home"), prefix = join(root, "prefix"), cwd = join(root, "project"), packageRoot = join(prefix, "node_modules/@earendil-works/pi-coding-agent"), bin = join(prefix, "node_modules/.bin/pi");
  for (const folder of [home, cwd, packageRoot, join(prefix, "node_modules/.bin")]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.8.7" }));
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  const realHome = join(root, "real-pi-agent"); mkdirSync(join(realHome, "settings"), { recursive: true }); writeFileSync(join(realHome, "settings/a.json"), "{}");
  const seen: string[][] = [];
  const bridge = (env: NodeJS.ProcessEnv, path: string, body: unknown) => fetch(`${env.AGENTHUB_PI_BRIDGE_URL}${path}`, { method: "POST", headers: { authorization: `Bearer ${env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then(response => response.json() as Promise<{ text?: string; failed?: boolean }>);
  const run: ReceiptCommand = async (argv, options) => {
    seen.push([...argv]);
    const env = options.env;
    if (argv[1] === "--version") return ok(`${fault === "version" ? "9.9.9" : "9.8.7"}\n`, fault === "version-stderr" ? "warning\n" : "");
    if (argv[0] === process.execPath && argv[1] === "test") return fault === "host" ? { ...ok("", " 3 pass\n 1 fail\n"), exitCode: 1 } : ok("", " 12 pass\n 0 fail\n");
    if (argv.includes("--mode")) {
      await bridge(env, "/event", { type: "session_start" });
      if (fault !== "no-shutdown") await bridge(env, "/event", { type: "session_shutdown" });
      if (fault === "provider") await fetch(`${env.AGENTHUB_PI_RELAY_URL}/chat`, { method: "POST", headers: { authorization: `Bearer ${env.AGENTHUB_PI_RELAY_TOKEN}` }, body: "{}" }).catch(() => {});
      const wire = JSON.stringify({ id: "probe", type: "response", command: "get_state", success: true, data: { messageCount: fault === "messages" ? 3 : 0, sessionId: "s", sessionFile: "/tmp/f.jsonl" } }) + "\n";
      return ok(JSON.stringify({ wire, stderr: "" }));
    }
    // the native SDK driver: register compat_probe, call it twice with one id (replay) and once denied
    const call = (id: string, value: string) => bridge(env, "/tool", { sessionId: "s", toolCallId: id, name: "compat_probe", args: { value } });
    const first = await call("same-call", "fixture"), replay = await call(fault === "double-effect" ? "other-call" : "same-call", "fixture"), denied = await call("denied-call", fault === "denied-ok" ? "fixture" : "deny");
    const result = (item: { text?: string; failed?: boolean }) => ({ content: [{ type: "text", text: item.text }], isError: item.failed === true });
    return ok(JSON.stringify({ extension: fault === "extension" ? "missing" : "loaded", first: result(first), replay: result(replay), denied: result(denied), tools: ["compat_probe"] }));
  };
  const context: ProofContext = { id: "pi", version: "9.8.7", root, home, prefix, cwd, env: { PATH: process.env.PATH, HOME: home }, signal: new AbortController().signal,
    limits: { totalMs: 20_000, installMs: 1000, legMs: 10_000, outputBytes: 1024 * 1024, artifactBytes: 1024 * 1024, expandedBytes: 2 * 1024 * 1024, archiveEntries: 10 },
    artifact: { method: "npm-exact", integrity: "sha512-x", packageRoot, command: [bin] }, entry: {} as never,
    run: fault === "stop-unconfirmed" ? async (argv, options) => ({ ...(await run(argv, options)), ownedStopConfirmed: false }) : run };
  return { context, realHome, seen };
}
const IDS = ["native-identity", "cli-rpc-session", "sdk-registration", "tool-replay", "failed-tool", "zero-provider-requests", "host-permission-modes", "version-admission", "isolated-home-cleanup"];
const statuses = (results: Record<string, { status: string }>) => Object.fromEntries(IDS.map(id => [id, results[id]?.status]));

test("every manifest leg of pi passes against a faithful candidate, with no account, key or provider request", async () => {
  const { context, realHome, seen } = fixture();
  const results = await runPiProofs(context, { realHome });
  expect(Object.keys(results).sort()).toEqual([...IDS].sort());
  for (const id of IDS) expect(results[id], id).toEqual({ status: "pass", cause: "ok" });
  // the native children never saw the account's HOME and ran with no credential variable
  for (const argv of seen) expect(argv.join(" ")).not.toContain(realHome);
});

test("the producer's legs are exactly the manifest's legs for pi", async () => {
  const manifest = JSON.parse(await Bun.file(new URL("../scripts/compat-receipts/manifest.json", import.meta.url)).text()) as { entries: Record<string, { legs: { id: string }[] }> };
  expect(manifest.entries.pi!.legs.map(leg => leg.id).sort()).toEqual([...IDS].sort());
});

const FAULTS: [Fault, string[]][] = [
  ["version", ["native-identity"]],
  ["version-stderr", ["native-identity"]],
  ["extension", ["sdk-registration"]],
  ["double-effect", ["tool-replay"]],
  ["denied-ok", ["sdk-registration"]],
  ["messages", ["cli-rpc-session"]],
  ["no-shutdown", ["cli-rpc-session"]],
  ["provider", ["zero-provider-requests"]],
];
for (const [fault, failing] of FAULTS) test(`a candidate that ${fault} fails ${failing.join(", ")} and never reports a leg it did not prove`, async () => {
  const { context, realHome } = fixture(fault);
  const results = await runPiProofs(context, { realHome });
  for (const id of failing) expect(results[id]?.status, `${id} under ${fault}`).toBe("fail");
  // the host fixtures test this checkout, so they are independent of the candidate
  expect(results["host-permission-modes"]?.status).toBe("pass");
  expect(results["version-admission"]?.status).toBe("pass");
  // legs after the first failure that were never reached are failures, not passes
  if (fault === "version" || fault === "version-stderr") for (const id of ["sdk-registration", "tool-replay", "failed-tool", "cli-rpc-session", "zero-provider-requests"]) expect(results[id]?.status, id).toBe("fail");
});

test("a failing host fixture fails its leg without touching the candidate legs", async () => {
  const { context, realHome } = fixture("host");
  const results = await runPiProofs(context, { realHome });
  expect(results["host-permission-modes"]).toEqual({ status: "fail", cause: "proof-failed" });
  expect(results["version-admission"]).toEqual({ status: "fail", cause: "proof-failed" });
  for (const id of ["native-identity", "cli-rpc-session", "sdk-registration", "tool-replay", "failed-tool", "zero-provider-requests"]) expect(results[id]?.status, id).toBe("pass");
});

test("isolated-home-cleanup fails when the account's real Pi home changed during the run, and ignores the volatile directories", async () => {
  const { context, realHome } = fixture();
  const original = context.run;
  context.run = async (argv, options) => { if (argv[1] === "--version") writeFileSync(join(realHome, "settings/a.json"), "{\"changed\":true}"); return original(argv, options); };
  expect((await runPiProofs(context, { realHome }))["isolated-home-cleanup"]).toEqual({ status: "fail", cause: "proof-failed" });
  const quiet = fixture();
  const quietRun = quiet.context.run;
  quiet.context.run = async (argv, options) => { mkdirSync(join(quiet.realHome, "sessions"), { recursive: true }); writeFileSync(join(quiet.realHome, "sessions/live.jsonl"), String(Math.random())); return quietRun(argv, options); };
  expect((await runPiProofs(quiet.context, { realHome: quiet.realHome }))["isolated-home-cleanup"]).toEqual({ status: "pass", cause: "ok" });
  // an absent home (a hosted runner has none) passes only while it stays absent: a run that creates it leaks outside the private home
  expect((await runPiProofs(fixture().context, { realHome: join(tmpdir(), "ahub-no-such-pi-home") }))["isolated-home-cleanup"]).toEqual({ status: "pass", cause: "ok" });
  const leaky = fixture(), leakyRun = leaky.context.run, absent = join(leaky.context.root, "never-there");
  leaky.context.run = async (argv, options) => { if (argv[1] === "--version") mkdirSync(join(absent, "settings"), { recursive: true }); return leakyRun(argv, options); };
  expect((await runPiProofs(leaky.context, { realHome: absent }))["isolated-home-cleanup"]).toEqual({ status: "fail", cause: "proof-failed" });
});

test("an owned process that cannot be confirmed stopped fails every leg that ran a command", async () => {
  const { context, realHome } = fixture("stop-unconfirmed");
  const results = await runPiProofs(context, { realHome });
  expect(results["native-identity"]).toEqual({ status: "fail", cause: "cleanup" });
  expect(statuses(results)["zero-provider-requests"]).toBe("fail");
});

test("an aborted run is a cancelled failure, never a pass", async () => {
  const { context, realHome } = fixture();
  const controller = new AbortController(); controller.abort();
  const results = await runPiProofs({ ...context, signal: controller.signal }, { realHome });
  for (const id of ["host-permission-modes", "version-admission"]) expect(results[id]).toEqual({ status: "fail", cause: "cancelled" });
  expect(results["native-identity"]?.status).toBe("fail");
});
