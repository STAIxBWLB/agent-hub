import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ReviewerPrintPeer, type ReviewerBackend, type ReviewerFailure, type ReviewerLaunch, type ReviewerPrepareContext } from "../src/adapters/reviewer-print.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";

const fake = resolve(import.meta.dir, "fakes/fake-reviewer-print.ts"), cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-review-print-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5); expect(done()).toBe(true); };
const request = (id: number) => newEnvelope(HUB, `Review task #${id}`, { kind: "review", to: ["fixture-review"], refs: { task: String(id), commit: "a".repeat(40), reviewRevision: "7" } });
const plan = (ctx: ReviewerPrepareContext, log: string): ReviewerLaunch => ({ command: [process.execPath, fake, log], args: ["--fresh", ctx.sessionId, "--mcp", ctx.mcpConfig],
  isolation: { backend: "fixture", version: "test", binary: process.execPath, profile: "fixture-profile", readOnly: true, strictMcp: true, ephemeral: true, evidence: ["fixture only, not native isolation evidence"] } });

test("fresh reviewer honors its verified backend plan and keeps each review in a separate child", async () => {
  const dir = scratch(), log = join(dir, "calls.jsonl"), verified: string[] = [], usage: number[] = [];
  const backend: ReviewerBackend = { id: "fixture", prepare: async ctx => { verified.push(ctx.sessionId); return plan(ctx, log); }, usage: event => (event as { usage?: { input_tokens?: number } }).usage };
  const peer = new ReviewerPrintPeer("fixture-review", { cwd: dir, mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000, backend, verdictSince: () => true, onUsage: value => usage.push(value.input_tokens!) });
  cleanup.push(() => peer.stop());
  await peer.start();
  expect(verified).toHaveLength(1);
  await peer.deliver([request(1), request(2)], "delivery");
  await until(() => peer.state === "idle");
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls).toHaveLength(2);
  expect(new Set(calls.map(call => call.args[1])).size).toBe(2);
  for (const call of calls) expect(call.args).toEqual(["--fresh", call.args[1], "--mcp", "{}"]);
  expect(calls[0].prompt).not.toContain("#2"); expect(calls[1].prompt).not.toContain("#1");
  expect(usage).toEqual([3, 3]);
});

test("an unavailable isolation receipt refuses reviewer startup before a model child", async () => {
  const dir = scratch(), log = join(dir, "calls.jsonl");
  const peer = new ReviewerPrintPeer("fixture-review", { cwd: dir, command: [process.execPath, fake, log], mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000,
    backend: { id: "fixture", prepare: async () => ({ unavailable: "strict MCP isolation is unproven" }) }, verdictSince: () => false });
  cleanup.push(() => peer.stop());
  await expect(peer.start()).rejects.toThrow("strict MCP isolation is unproven");
  expect(existsSync(log)).toBe(false);
  expect(peer.state).toBe("offline");
});

test("expired isolation at delivery cannot spawn a child and reports a head-bound start failure", async () => {
  const dir = scratch(), log = join(dir, "calls.jsonl"), failures: ReviewerFailure[] = [];
  let starts = 0;
  const backend: ReviewerBackend = { id: "fixture", prepare: async ctx => ++starts === 1 ? plan(ctx, log) : ({ ...plan(ctx, log), current: () => false }) };
  const peer = new ReviewerPrintPeer("fixture-review", { cwd: dir, mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000, backend, verdictSince: () => false, onUnavailable: failure => { failures.push(failure); } });
  cleanup.push(() => peer.stop());
  await peer.start(); await peer.deliver([request(1)], "delivery");
  await until(() => peer.state === "idle" && failures.length === 1);
  expect(existsSync(log)).toBe(false);
  // #722: a receipt that expired before spawn is the binary class (the binary/config binding changed).
  expect(failures).toEqual([{ task: 1, head: "a".repeat(40), flowRevision: 7, cause: "start_failed", causeClass: "binary" }]);
});

test("a batch isolation failure reports every unprocessed review with its bound head/revision", async () => {
  const dir = scratch(), log = join(dir, "calls.jsonl"), failures: ReviewerFailure[] = [], states: string[] = [];
  let preparations = 0;
  const peer = new ReviewerPrintPeer("fixture-review", { cwd: dir, mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000,
    backend: { id: "fixture", prepare: async ctx => ++preparations === 1 ? plan(ctx, log) : { unavailable: "fixture start refusal" } }, verdictSince: () => false,
    onUnavailable: failure => { states.push(peer.state); failures.push(failure); } });
  cleanup.push(() => peer.stop());
  await peer.start(); await peer.deliver([request(11), request(12)], "batch-failure");
  await until(() => peer.state === "idle");
  // #722: a backend refusal with no class is `unknown`, never a guess.
  expect(failures).toEqual([11, 12].map(task => ({ task, head: "a".repeat(40), flowRevision: 7, cause: "start_failed", causeClass: "unknown" })));
  expect(states).toEqual(["busy", "busy"]);
  expect(existsSync(log)).toBe(false);
});

test("a quota end reports the unprocessed batch without spawning another child", async () => {
  const dir = scratch(), log = join(dir, "calls.jsonl"), failures: ReviewerFailure[] = [];
  const peer = new ReviewerPrintPeer("fixture-review", { cwd: dir, mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000,
    backend: { id: "fixture", prepare: async ctx => plan(ctx, log), failure: () => "quota" }, verdictSince: () => false, onUnavailable: failure => { failures.push(failure); } });
  cleanup.push(() => peer.stop());
  await peer.start(); await peer.deliver([request(21), request(22)], "batch-quota");
  await until(() => peer.state === "idle");
  expect(failures).toEqual([21, 22].map(task => ({ task, head: "a".repeat(40), flowRevision: 7, cause: "quota" })));
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
});

class ControlledWatchdogReviewer extends ReviewerPrintPeer { expire(): void { this.onWatchdog(); } }
const hangingPlan = (ctx: ReviewerPrepareContext, log: string): ReviewerLaunch => ({ ...plan(ctx, log), command: [process.execPath, "-e", `const prompt=await new Response(Bun.stdin.stream()).text();await Bun.write(${JSON.stringify(log)},String(process.pid));setInterval(()=>{},1000);`], args: [] });

test("watchdog reroutes the current and remaining batch only after the group is gone", async () => {
  const dir = scratch(), log = join(dir, "child.pid"), failures: ReviewerFailure[] = [];
  let aliveDuringCallback = false;
  const peer = new ControlledWatchdogReviewer("fixture-review", { cwd: dir, mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000,
    backend: { id: "fixture", prepare: async ctx => hangingPlan(ctx, log) }, verdictSince: () => false,
    onUnavailable: failure => { try { process.kill(Number(readFileSync(log, "utf8")), 0); aliveDuringCallback = true; } catch { /* confirmed gone */ } expect(peer.state).toBe("busy"); failures.push(failure); } });
  cleanup.push(() => peer.stop());
  await peer.start(); await peer.deliver([request(31), request(32)], "batch-watchdog");
  await until(() => peer.reviewing === 31 && existsSync(log));
  const token = peer.reviewToken(31); expect(token).toBeDefined();
  peer.expire();
  expect(peer.reviewToken(31)).toBeUndefined();
  await until(() => peer.state === "idle");
  expect(aliveDuringCallback).toBe(false);
  expect(failures).toEqual([31, 32].map(task => ({ task, head: "a".repeat(40), flowRevision: 7, cause: "no_verdict" })));
});

test("a person stop revokes a watchdog fallback before it can reroute", async () => {
  const dir = scratch(), log = join(dir, "child.pid"), failures: ReviewerFailure[] = [];
  const peer = new ControlledWatchdogReviewer("fixture-review", { cwd: dir, mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000,
    backend: { id: "fixture", prepare: async ctx => hangingPlan(ctx, log) }, verdictSince: () => false, onUnavailable: failure => { failures.push(failure); } });
  cleanup.push(() => peer.stop());
  await peer.start(); await peer.deliver([request(41), request(42)], "batch-stop");
  await until(() => peer.reviewing === 41 && existsSync(log));
  peer.expire(); await peer.stop("person requested stop");
  expect(peer.state).toBe("offline");
  expect(failures).toEqual([]);
});

test("stop invalidates an awaiting fallback and suppresses later batch callbacks", async () => {
  const dir = scratch(), log = join(dir, "calls.jsonl"), failures: number[] = [];
  let preparations = 0, entered = false, finished = false, current: (() => boolean) | undefined, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const peer = new ReviewerPrintPeer("fixture-review", { cwd: dir, mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000,
    backend: { id: "fixture", prepare: async ctx => ++preparations === 1 ? plan(ctx, log) : { unavailable: "fixture start refusal" } }, verdictSince: () => false,
    onUnavailable: async (failure, valid) => { failures.push(failure.task); current = valid; entered = true; await held; finished = true; } });
  cleanup.push(() => peer.stop());
  await peer.start(); await peer.deliver([request(51), request(52)], "batch-callback-stop");
  await until(() => entered);
  expect(peer.state).toBe("busy"); expect(current?.()).toBe(true);
  await peer.stop("person requested stop");
  expect(current?.()).toBe(false);
  release(); await until(() => finished);
  expect(failures).toEqual([51]); expect(peer.state).toBe("offline");
});

for (const mode of ["frame", "total"] as const) test(`reviewer ${mode} output overflow revokes authority and reroutes after group cleanup`, async () => {
  const dir = scratch(), log = join(dir, "child.pid"), failures: ReviewerFailure[] = [], diagnostics: string[] = [];
  const backend: ReviewerBackend = { id: "fixture", prepare: async ctx => ({ ...plan(ctx, log), command: [process.execPath, "-e", `import { existsSync } from "node:fs";await new Response(Bun.stdin.stream()).text();await Bun.write(${JSON.stringify(log)},String(process.pid));while(!existsSync(${JSON.stringify(join(dir, "send"))}))await Bun.sleep(5);const body=${JSON.stringify(mode)} === "frame" ? "PRIVATE_OUTPUT_CANARY".repeat(20000) : (JSON.stringify({type:"noise",padding:"PRIVATE_OUTPUT_CANARY".repeat(30)})+"\\n").repeat(9000);process.stdout.write(body);setInterval(()=>{},1000);`], args: [] }) };
  const peer = new ReviewerPrintPeer("fixture-review", { cwd: dir, mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000, backend, verdictSince: () => false,
    log: line => diagnostics.push(line), onUnavailable: failure => { try { process.kill(Number(readFileSync(log, "utf8")), 0); throw new Error("group still alive"); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); } expect(peer.reviewToken(61)).toBeUndefined(); failures.push(failure); } });
  cleanup.push(() => peer.stop());
  await peer.start(); await peer.deliver([request(61), request(62)], "batch-overflow");
  await until(() => peer.reviewing === 61 && existsSync(log));
  expect(peer.reviewToken(61)).toBeDefined();
  await Bun.write(join(dir, "send"), "go");
  await until(() => failures.length > 0); await until(() => peer.state === "idle");
  expect(failures).toEqual([61, 62].map(task => ({ task, head: "a".repeat(40), flowRevision: 7, cause: "no_verdict" })));
  expect(diagnostics.join("\n")).not.toContain("PRIVATE_OUTPUT_CANARY");
});
