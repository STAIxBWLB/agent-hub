import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEnvelope } from "../src/hub/envelope.ts";
import { isReviewObserverExcluded } from "../src/hub/memory-policy.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { ClaudeImplementerPeer, isClaudeImplementerPeer } from "../src/adapters/claude-implementer.ts";
import { ReviewerPrintPeer, isReviewerPrintPeer, reviewerNoVerdictLine, type ReviewerBackend } from "../src/adapters/reviewer-print.ts";
import { LocalPeer, type LocalOptions } from "../src/adapters/local-worker.ts";
import type { OwnedInputContext } from "../src/adapters/claude-print-child.ts";
import { gitProject } from "./fakes/git-project.ts";

class CountingPeer extends BasePeer {
  deliveries = 0;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() { this.deliveries++; }
}

async function waitUntil(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

function childScript(file: string, log: string): string {
  const source = "const fs=require(\"node:fs\");\n"
    + "const log=" + JSON.stringify(log) + ";\n"
    + "const args=process.argv;\n"
    + "const i=args.indexOf(\"--session-id\");\n"
    + "const r=args.indexOf(\"--resume\");\n"
    + "const j=args.indexOf(\"--session\");\n"
    + "const session=i>=0?args[i+1]:r>=0?args[r+1]:j>=0?args[j+1]:\"\";\n"
    + "fs.appendFileSync(log,JSON.stringify({phase:\"spawn\",session})+\"\\n\");\n"
    + "let input=\"\";\nprocess.stdin.setEncoding(\"utf8\");\n"
    + "process.stdin.on(\"data\",chunk=>input+=chunk);\n"
    + "process.stdin.on(\"end\",()=>{fs.appendFileSync(log,JSON.stringify({phase:\"received\",session,input})+\"\\n\");process.stdout.write(JSON.stringify({type:\"result\",subtype:\"success\",session_id:session})+\"\\n\");});\n";
  writeFileSync(file, source, { mode: 0o700 });
  return file;
}

test("LocalPeer exposes its owned in-memory observer SID without claiming nativeSession", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-owned-local-"));
  try {
    gitProject(root);
    const contexts: OwnedInputContext[] = [], completions: string[] = [];
    let calls = 0;
    const peer = new LocalPeer("local", { cwd: root, fixedModel: "fixture", watchdogMs: 5000,
      omni: { onCampus: async () => true, chat: async () => { calls++; return { message: { role: "assistant", content: "fixture answer" } }; } },
      tools: { deny: [], permit: async () => true }, beforeInput: context => contexts.push(context), inputReleased: context => contexts.push(context),
    } as unknown as LocalOptions);
    expect(peer.observerSessionId).toBe(peer.recoveryMetadata().sessionId);
    expect(peer.observerSessionId).toMatch(/^agent-hub-local-/);
    expect("nativeSession" in peer).toBe(false);
    peer.onDelivery = receipt => { if (receipt.state === "completed") completions.push(receipt.id); };
    await peer.start();
    await peer.deliver([newEnvelope("user", "local input", { to: [peer.id] })], "local-input");
    await waitUntil(() => completions.includes("local-input"));
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[0]!.sessionId).toBe(peer.observerSessionId);
    expect(calls).toBe(1);
    await peer.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the Bus defers only an actual guarded ReviewerPrint peer to its native input guard", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-owned-bus-")), reviewMarker = join(root, "review-events.jsonl"), implMarker = join(root, "impl-events.jsonl");
  const reviewScript = childScript(join(root, "fake-print.js"), reviewMarker), implScript = childScript(join(root, "fake-claude.js"), implMarker), stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const before: string[] = [];
  const reviewer = new ReviewerPrintPeer("reviewer-print-actual", {
    cwd: root, command: [process.execPath], mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 5000,
    backend: { id: "fixture", prepare: async context => ({ command: [process.execPath, reviewScript], args: ["--session", context.sessionId], isolation: {
      backend: "fixture", version: "1", binary: process.execPath, profile: "fresh", readOnly: true, strictMcp: true, ephemeral: true, evidence: ["fixture"],
    } }) },
    verdictSince: () => true,
    beforeInput: (context, envs) => { expect(Object.isFrozen(context)).toBe(true); expect(envs.some(isReviewObserverExcluded)).toBe(true); expect(existsSync(reviewMarker)).toBe(false); before.push("review"); },
  });
  const implementer = new ClaudeImplementerPeer("claude-implementer-actual", {
    cwd: root, stateDir, projectRoot: root, instanceId: "fixture", server: implScript, factsHook: implScript,
    systemPrompt: "fixture", watchdogMs: 5000, command: [process.execPath, implScript], mode: "ask",
    prove: async () => () => true, admit: () => true, chatTask: () => undefined,
    beforeInput: (context, envs) => { expect(Object.isFrozen(context)).toBe(true); expect(envs.some(isReviewObserverExcluded)).toBe(true); expect(existsSync(implMarker)).toBe(false); before.push("implementer"); },
  });
  const unbound = new CountingPeer("unbound-reviewer");
  expect(isReviewerPrintPeer(reviewer)).toBe(true); expect(isClaudeImplementerPeer(implementer)).toBe(true);
  const guarded = new WeakSet<object>([reviewer, implementer]);
  const bus = new Bus({ batchMs: 0, batchMax: 1, beforeReviewInputHandoff: (peer, envs) => {
    if (guarded.has(bus.peers.get(peer)!)) return;
    if (envs.some(isReviewObserverExcluded)) throw new Error("stable session provenance required before quote handoff");
  } });
  try {
    bus.add(reviewer); bus.add(implementer); bus.add(unbound);
    await reviewer.start(); await implementer.start(); await unbound.start();
    const message = newEnvelope("hub", "UNBOUND_BUS_REVIEW_CANARY", { to: [reviewer.id, implementer.id, unbound.id], kind: "review", priority: "important", refs: { task: "41", reviewPackage: "review:bus-guard" } });
    expect(bus.publish(message).targets).toEqual([reviewer.id, implementer.id, unbound.id]);
    await waitUntil(() => reviewer.state === "idle" && implementer.state === "idle" && before.length === 2 && unbound.deliveries === 0 && bus.queued(unbound.id) === 1);
    expect(before.sort()).toEqual(["implementer", "review"]);
    expect(unbound.deliveries).toBe(0);
    expect(bus.queued(unbound.id)).toBe(1);
  } finally { await reviewer.stop().catch(() => {}); await implementer.stop().catch(() => {}); await unbound.stop(); bus.closeJournal(); rmSync(root, { recursive: true, force: true }); }
});

test("fresh ReviewerPrint input is guarded before backend preparation and released after stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-owned-print-")), marker = join(root, "child-events.jsonl"), script = childScript(join(root, "fake-print.js"), marker);
  const events: { type: string; sessionId?: string; inputId?: string; frozen?: boolean; input?: string }[] = [];
  const backend: ReviewerBackend = {
    id: "fixture-review-backend",
    taskMcp: true,
    prepare: async context => {
      if (context.input !== undefined) events.push({ type: "prepare", sessionId: context.sessionId, input: context.input });
      return { command: [process.execPath, script], args: ["--session", context.sessionId], isolation: {
        backend: "fixture-review-backend", version: "1", binary: process.execPath, profile: "fresh-profile", readOnly: true,
        strictMcp: true, ephemeral: true, evidence: ["fixture"],
      }, cleanup: () => { if (context.input !== undefined) events.push({ type: "cleanup", sessionId: context.sessionId }); } };
    },
  };
  const peer = new ReviewerPrintPeer("reviewer-print-fixture", {
    cwd: root, command: [process.execPath], mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 5000,
    backend, verdictSince: () => true,
    taskMcp: () => { events.push({ type: "mcp-created" }); return { config: "{}", close: () => { events.push({ type: "mcp-closed" }); } }; },
    beforeInput: (context: OwnedInputContext, envs) => {
      expect(envs).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
      events.push({ type: "before", sessionId: context.sessionId, inputId: context.inputId, frozen: Object.isFrozen(context) });
    },
    inputReleased: (context, envs) => { events.push({ type: "released", sessionId: context.sessionId, inputId: context.inputId, frozen: Object.isFrozen(context), input: envs[0]?.body }); },
    inputFinished: (context, envs) => { events.push({ type: "finished", sessionId: context.sessionId, inputId: context.inputId, frozen: Object.isFrozen(context), input: envs[0]?.body }); },
  });
  try {
    expect("nativeSession" in peer).toBe(false);
    await peer.start();
    const receipts: string[] = [];
    peer.onDelivery = receipt => { if (receipt.state === "completed") receipts.push(receipt.id); };
    const review = newEnvelope("hub", "OWNED_REVIEW_INPUT_CANARY", { to: [peer.id], kind: "review", priority: "important", refs: { task: "41", reviewPackage: "review:owned-fixture" } });
    await peer.deliver([review], "review-delivery");
    await waitUntil(() => receipts.includes("review-delivery"));
    const before = events.find(event => event.type === "before")!;
    const prepare = events.find(event => event.type === "prepare")!;
    const released = events.find(event => event.type === "released")!;
    const finished = events.find(event => event.type === "finished")!;
    expect(before.sessionId).toBe(prepare.sessionId);
    expect(before.inputId).toBe(released.inputId);
    expect(released.inputId).toBe(finished.inputId);
    expect(before.frozen).toBe(true);
    expect(events.findIndex(event => event.type === "before")).toBeLessThan(events.findIndex(event => event.type === "prepare"));
    expect(events.findIndex(event => event.type === "released")).toBeLessThan(events.findIndex(event => event.type === "finished"));
    expect(events.findIndex(event => event.type === "mcp-closed")).toBeLessThan(events.findIndex(event => event.type === "finished"));
    expect(readFileSync(marker, "utf8")).toContain("OWNED_REVIEW_INPUT_CANARY");
    expect("nativeSession" in peer).toBe(false);
  } finally { await peer.stop().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});

test("a refused ReviewerPrint input never creates task MCP, prepares the input or spawns a child", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-owned-refusal-")), marker = join(root, "child-events.jsonl"), script = childScript(join(root, "fake-print.js"), marker);
  let taskMcpCreated = 0, taskMcpClosed = 0, inputPrepares = 0;
  const peer = new ReviewerPrintPeer("reviewer-print-refusal", {
    cwd: root, command: [process.execPath], mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 5000,
    backend: { id: "fixture", taskMcp: true, prepare: async context => {
      if (context.input !== undefined) inputPrepares++;
      return { command: [process.execPath, script], args: ["--session", context.sessionId], isolation: {
        backend: "fixture", version: "1", binary: process.execPath, profile: "fresh", readOnly: true, strictMcp: true, ephemeral: true, evidence: ["fixture"],
      } };
    } },
    taskMcp: () => { taskMcpCreated++; return { config: "{}", close: () => { taskMcpClosed++; } }; },
    verdictSince: () => true,
    beforeInput: () => { throw new Error("fixture refuses input provenance"); },
  });
  try {
    await peer.start();
    let failedSafe = false;
    peer.onDelivery = receipt => { if (receipt.state === "failed_safe") failedSafe = true; };
    await peer.deliver([newEnvelope("hub", "REFUSED_BODY_CANARY", { to: [peer.id], kind: "review", priority: "important", refs: { task: "41", reviewPackage: "review:refused-fixture" } })], "refused-review");
    await waitUntil(() => failedSafe && peer.state === "idle");
    expect(taskMcpCreated).toBe(0);
    expect(taskMcpClosed).toBe(0);
    expect(inputPrepares).toBe(0);
    expect(existsSync(marker)).toBe(false);
  } finally { await peer.stop().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});

test("a prepared fresh ReviewerPrint context is retired only after failed preparation and MCP close", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-owned-prepare-failure-")), marker = join(root, "child-events.jsonl"), script = childScript(join(root, "fake-print.js"), marker);
  const events: string[] = [];
  const peer = new ReviewerPrintPeer("reviewer-print-prepare-failure", {
    cwd: root, command: [process.execPath], mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 5000,
    backend: { id: "fixture", taskMcp: true, prepare: async context => {
      if (context.input !== undefined) { events.push("prepare-input"); throw new Error("fixture preparation refused"); }
      return { command: [process.execPath, script], args: ["--session", context.sessionId], isolation: {
        backend: "fixture", version: "1", binary: process.execPath, profile: "fresh", readOnly: true, strictMcp: true, ephemeral: true, evidence: ["fixture"],
      } };
    } },
    taskMcp: () => { events.push("mcp-created"); return { config: "{}", close: () => { events.push("mcp-closed"); } }; },
    verdictSince: () => true,
    beforeInput: () => { events.push("before"); },
    inputReleased: () => { events.push("released"); },
    inputFinished: () => { events.push("finished"); },
  });
  try {
    await peer.start();
    let failedSafe = false;
    peer.onDelivery = receipt => { if (receipt.state === "failed_safe") failedSafe = true; };
    await peer.deliver([newEnvelope("hub", "PREPARE_FAILURE_REVIEW_CANARY", { to: [peer.id], kind: "review", priority: "important", refs: { task: "41", reviewPackage: "review:prepare-failure" } })], "prepare-failure");
    await waitUntil(() => failedSafe && peer.state === "idle");
    expect(events.indexOf("before")).toBeLessThan(events.indexOf("prepare-input"));
    expect(events.indexOf("mcp-closed")).toBeLessThan(events.indexOf("finished"));
    expect(events).not.toContain("released");
    expect(existsSync(marker)).toBe(false);
  } finally { await peer.stop().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});

test("ClaudeImplementer uses its actual persistent task SID and per-input release token", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-owned-implementer-")), stateDir = join(root, "state"), marker = join(root, "child-events.jsonl");
  mkdirSync(stateDir, { recursive: true });
  const script = childScript(join(root, "fake-claude.js"), marker); const before: OwnedInputContext[] = [], beforeMarkerRows: number[] = [], released: OwnedInputContext[] = [];
  const peer = new ClaudeImplementerPeer("claude-implementer-fixture", {
    cwd: root, stateDir, projectRoot: root, instanceId: "fixture-instance", server: script, factsHook: script,
    systemPrompt: "fixture", watchdogMs: 5000, command: [process.execPath, script], mode: "ask",
    prove: async () => () => true, admit: () => true, chatTask: () => undefined,
    beforeInput: context => { before.push(context); beforeMarkerRows.push(existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0); },
    inputReleased: (context, envs) => { expect(envs).toHaveLength(1); released.push(context); },
  });
  try {
    expect("nativeSession" in peer).toBe(false);
    await peer.start();
    const completed: string[] = [];
    peer.onDelivery = receipt => { if (receipt.state === "completed") completed.push(receipt.id); };
    for (const id of ["implementer-first", "implementer-second"]) {
      await peer.deliver([newEnvelope("user", id + "-body", { to: [peer.id], refs: { task: "41" } })], id);
      await waitUntil(() => completed.includes(id));
    }
    expect(before).toHaveLength(2);
    expect(released).toHaveLength(2);
    expect(before[0]!.sessionId).toBe(before[1]!.sessionId);
    expect(before[0]!.inputId).not.toBe(before[1]!.inputId);
    expect(released.map(context => context.inputId)).toEqual(before.map(context => context.inputId));
    expect(before.every(context => Object.isFrozen(context))).toBe(true);
    expect(beforeMarkerRows).toEqual([0, 2]);
    const childEvents = readFileSync(marker, "utf8").trim().split("\n").map(line => JSON.parse(line) as { phase: string; session: string; input?: string });
    expect(childEvents.filter(event => event.phase === "received")).toHaveLength(2);
    expect(childEvents.filter(event => event.phase === "received").map(event => event.session)).toEqual(before.map(context => context.sessionId));
    expect(childEvents.map(event => event.input ?? "").join("\n")).toContain("implementer-first-body");
    expect(childEvents.map(event => event.input ?? "").join("\n")).toContain("implementer-second-body");
    expect("nativeSession" in peer).toBe(false);
  } finally { await peer.stop().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});

test("a review-scoped ReviewerPrint refusal trace is withheld while a clean review trace remains visible", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-owned-diagnostic-")), marker = join(root, "child-events.jsonl"), script = childScript(join(root, "fake-print.js"), marker);
  const lines: string[] = [];
  const contexts: OwnedInputContext[] = [];
  let observerHeld = false;
  const backend: ReviewerBackend = {
    id: "fixture-diagnostic-backend",
    prepare: async context => ({ command: [process.execPath, script], args: ["--session", context.sessionId], isolation: {
      backend: "fixture-diagnostic-backend", version: "1", binary: process.execPath, profile: "fresh-profile", readOnly: true,
      strictMcp: true, ephemeral: true, evidence: ["fixture"],
    } }),
    toolTrace: () => ({ tool: "hub_review", refusal: "PUBLIC_REFUSAL_CANARY" }),
  };
  const peer = new ReviewerPrintPeer("reviewer-print-diagnostic", {
    cwd: root, command: [process.execPath], mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 5000,
    backend, verdictSince: () => false,
    beforeInput: (context, envs) => { contexts.push(context); observerHeld = envs.some(env => env.refs?.reviewPackage !== undefined || env.refs?.reviewResponse !== undefined); },
    onNoVerdict: diagnostic => {
      const safe = observerHeld ? undefined : diagnostic.refusal;
      lines.push(reviewerNoVerdictLine(peer.id, diagnostic, safe, observerHeld));
    },
  });
  const deliver = async (id: string, env: ReturnType<typeof newEnvelope>) => {
    const settled: string[] = [];
    peer.onDelivery = receipt => { if (["completed", "needs_review", "failed_safe"].includes(receipt.state)) settled.push(receipt.id); };
    await peer.deliver([env], id);
    await waitUntil(() => settled.includes(id));
  };
  try {
    await peer.start();
    await deliver("held-review", newEnvelope("hub", "REVIEW_INPUT_CANARY", { to: [peer.id], kind: "review", priority: "important", refs: { task: "41", reviewPackage: "review:diagnostic" } }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("PUBLIC_REFUSAL_CANARY");
    expect(lines[0]).toContain("diagnostic withheld");
    await deliver("clean-review", newEnvelope("hub", "ordinary review request", { to: [peer.id], kind: "review", priority: "important", refs: { task: "41" } }));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("PUBLIC_REFUSAL_CANARY");
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.sessionId).not.toBe(contexts[1]!.sessionId);
  } finally { await peer.stop().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});
