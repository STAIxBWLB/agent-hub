import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpPeer, canonicalMcpToolName, type AcpOptions } from "../src/adapters/acp.ts";
import { Bus } from "../src/hub/bus.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { processTable } from "../src/hub/child-process.ts";
import { ActiveFailureLatch, activeExit, classifyNativeTermination, QWEN_0_24_7_LOOP_PROTECTION_MESSAGE } from "../scripts/benchmarks/native-pi-qwen.ts";

const FAKE = ["bun", join(import.meta.dir, "fakes/acp-server.ts")];
let peer: AcpPeer | undefined;
afterEach(() => peer?.stop());

async function setup(extra: Partial<AcpOptions> = {}) {
  const bus = new Bus({ batchMs: 0 });
  const said: Envelope[] = [];
  bus.tap((e) => e.t === "envelope" && e.env.from === "kimi" && said.push(e.env));
  peer = new AcpPeer("kimi", { cmd: FAKE, cwd: process.cwd(), ...extra });
  bus.add(peer);
  await peer.start();
  return { bus, said };
}
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

test("prompt round trip: chunks are aggregated into one reply that inherits the trace", async () => {
  const { bus, said } = await setup();
  const env = newEnvelope("user", "ping", { to: ["kimi"] });
  bus.publish(env);
  await until(() => said.length === 1);
  expect(said[0]!.body).toBe("echo: ping");
  expect(said[0]!.trace).toBe(env.trace);
  expect(said[0]!.hop).toBe(1);
  expect(peer!.state).toBe("idle");
});

test("correlated ACP delivery reports acceptance before completion and ignores a late cancelled result", async () => {
  const { peer: acp } = await (async () => { const p = new AcpPeer("kimi", { cmd: FAKE, cwd: process.cwd(), watchdogMs: 40 }); await p.start(); return { peer: p }; })();
  const receipts: { id: string; state: string }[] = [];
  acp.onDelivery = (r) => receipts.push({ id: r.id, state: r.state });
  try {
    await acp.deliver([newEnvelope("user", "ping", { to: ["kimi"] })], "d-accepted");
    expect(receipts).toEqual([]);
    await until(() => receipts.some((r) => r.id === "d-accepted" && r.state === "accepted"));
    await until(() => receipts.some((r) => r.state === "completed"));
    expect(receipts.map((r) => r.state)).toEqual(["accepted", "completed"]);

    await acp.deliver([newEnvelope("user", "ACK_SLOW", { to: ["kimi"] })], "d-slow");
    await until(() => receipts.some((r) => r.id === "d-slow" && r.state === "needs_review"));
    await Bun.sleep(100);
    expect(receipts.filter((r) => r.id === "d-slow")).toHaveLength(2); // accepted + one uncertain terminal state
  } finally { await acp.stop(); }
});

test("a failed prompt turn reports onTurnFailure; an abnormal end with no answer does too; a stale cancelled turn never does (#160)", async () => {
  const failures: { ids: string[]; reason: string }[] = [];
  const latch = new ActiveFailureLatch();
  latch.begin(Date.now());
  const acpPeer = new AcpPeer("qwen", { cmd: FAKE, cwd: process.cwd(), onTurnFailure: (envs, reason) => {
    failures.push({ ids: envs.map((e) => e.id), reason });
    latch.note("qwen", reason, Date.now());
  } });
  peer = acpPeer;
  const said: string[] = [];
  acpPeer.onMessage = (body) => said.push(body);
  await acpPeer.start();
  // A rejected prompt: the peer returns to idle with no answer, but the failure is reported — no silent wait.
  const broken = newEnvelope("user", "BROKEN", { to: ["kimi"] });
  await acpPeer.deliver([broken]);
  await until(() => failures.length === 1);
  expect(failures[0]!.reason).toContain("session error");
  expect(failures[0]!.ids).toEqual([broken.id]);
  expect(peer!.state).toBe("idle");
  expect(said).toHaveLength(0);
  expect(latch.failure?.peer).toBe("qwen");
  expect(activeExit({ stopRequested: false, terminalFailure: !!latch.failure, peerUnreachable: acpPeer.state === "offline", settled: false, quietMs: 0 })).toBe("peer-failure");
  // An abnormal end that streamed nothing (a turn cap): the same report, with the adapter's reason.
  await acpPeer.deliver([newEnvelope("user", "CAPPED", { to: ["qwen"] })]);
  await until(() => failures.length === 2);
  expect(failures[1]!.reason).toBe("ACP prompt ended without normal completion (max_turn_requests)");
  expect(said).toHaveLength(0);
  await acpPeer.deliver([newEnvelope("user", "PARTIAL_CAPPED", { to: ["qwen"] })]);
  await until(() => failures.length === 3);
  expect(said).toEqual(["partial work"]);
  expect(failures[2]!.reason).toBe("ACP prompt ended without normal completion (max_turn_requests)");
  await peer!.stop();

  // A watchdog-cancelled turn's late report is stale and never fires the callback.
  const lateFailures: string[] = [];
  const acp = new AcpPeer("kimi", { cmd: FAKE, cwd: process.cwd(), watchdogMs: 40, onTurnFailure: async (_e, r) => { lateFailures.push(r); } });
  await acp.start();
  try {
    const answered: string[] = [];
    acp.onMessage = (body) => answered.push(body);
    await acp.deliver([newEnvelope("user", "SLOW", { to: ["kimi"] })]); // no deliveryId: the watchdog returns it to idle
    await until(() => acp.state === "idle");
    await acp.deliver([newEnvelope("user", "ping", { to: ["kimi"] })]);
    await until(() => answered.length === 1);
    await Bun.sleep(150); // the cancelled prompt's late report lands here, stale
    expect(lateFailures).toEqual([]);
  } finally { await acp.stop(); }
});

// issue #175: Qwen 0.24.7's native loop-protection stop rejects session/prompt with the pinned message and
// structured error data; the failure callback surfaces the message alone, and it classifies as the fixed
// terminal class.
test("a native loop-protection rejection reports the pinned message and classifies as tool-loop-protection", async () => {
  const failures: string[] = [];
  const latch = new ActiveFailureLatch();
  latch.begin(Date.now());
  const acp = new AcpPeer("qwen", { cmd: FAKE, cwd: process.cwd(), onTurnFailure: (_e, reason) => { failures.push(reason); latch.note("qwen", reason, Date.now()); } });
  try {
    await acp.start();
    await acp.deliver([newEnvelope("user", "LOOPPROTECT", { to: ["qwen"] })]);
    await until(() => failures.length === 1);
    expect(failures[0]).toBe(QWEN_0_24_7_LOOP_PROTECTION_MESSAGE); // the message alone; the error data stays in the protocol
    const classification = classifyNativeTermination("qwen", failures[0]);
    expect(classification).toEqual({ class: "tool-loop-protection", evidence: "pinned-message" });
    expect(latch.failure).toMatchObject({ peer: "qwen", failureClass: QWEN_0_24_7_LOOP_PROTECTION_MESSAGE });
    expect(activeExit({ stopRequested: false, terminalFailure: latch.failure !== undefined, peerUnreachable: false, settled: false, quietMs: 0 })).toBe("peer-failure");
    // A peer whose pinned contract this is not: the same words are not its loop-protection evidence.
    expect(classifyNativeTermination("pi", failures[0]).class).toBe("unknown");
  } finally { await acp.stop(); }
});

test("the canonical MCP binding resolves only a configured server's announced title (#138)", () => {
  expect(canonicalMcpToolName("hub_send (pilot-peer-bus MCP Server)", ["pilot-peer-bus"])).toBe("mcp__pilot-peer-bus__hub_send");
  expect(canonicalMcpToolName("hub_send (other-bus MCP Server)", ["pilot-peer-bus"])).toBeUndefined(); // an unconfigured server resolves to nothing
  expect(canonicalMcpToolName('{"text":"arguments quoted as the title"}', ["pilot-peer-bus"])).toBeUndefined();
  expect(canonicalMcpToolName("hub_send (pilot-peer-bus MCP Server)", undefined)).toBeUndefined(); // no configured servers
  expect(canonicalMcpToolName(undefined, ["pilot-peer-bus"])).toBeUndefined();
});

test("messages arriving mid-prompt are queued, then drained as one digest prompt, never lost", async () => {
  const { bus, said } = await setup();
  for (const body of ["one", "two", "three"]) bus.publish(newEnvelope("user", body, { to: ["kimi"] }));
  expect(peer!.state).toBe("busy");
  expect(bus.queued("kimi")).toBe(2);
  await until(() => said.length === 2);
  expect(said.map((e) => e.body)).toEqual(["echo: one", "echo: three (2 items)"]);
  expect(bus.queued("kimi")).toBe(0);
});

test("permission requests are relayed; no handler means cancelled", async () => {
  const asked: string[] = [];
  const { bus, said } = await setup({
    onPermission: async (req) => {
      asked.push(`${req.peer}:${req.title}`);
      return "yes";
    },
  });
  bus.publish(newEnvelope("user", "PERMISSION", { to: ["kimi"] }));
  await until(() => said.length === 1);
  expect(asked).toEqual(["kimi:write file (payload not reported by the agent)"]);
  expect(said[0]!.body).toBe("echo: PERMISSION permission=yes");

  await peer!.stop();
  const second = await setup();
  second.bus.publish(newEnvelope("user", "PERMISSION", { to: ["kimi"] }));
  await until(() => second.said.length === 1);
  expect(second.said[0]!.body).toEndWith("permission=cancelled");
});

// issue #31: the console was asked to approve a bare "Bash" because the request carried no rawInput.
test("a permission prompt shows the command the tool_call update announced", async () => {
  const asked: { title: string; options: string[] }[] = [];
  const { bus, said } = await setup({
    onPermission: async (req) => {
      asked.push({ title: req.title, options: req.options.map((o) => o.kind) });
      return "yes";
    },
  });
  bus.publish(newEnvelope("user", "PERMISSION ANNOUNCED", { to: ["kimi"] }));
  await until(() => said.length === 1);
  expect(asked[0]!.title).toBe("Bash: rm -rf build && make");
  expect(asked[0]!.options).toContain("allow_always"); // the payload is known: a session-wide grant is informed
});

test("a permission prompt with no resolvable payload says so and offers no session-wide grant", async () => {
  const asked: { title: string; options: string[] }[] = [];
  const { bus, said } = await setup({
    onPermission: async (req) => {
      asked.push({ title: req.title, options: req.options.map((o) => o.kind) });
      return "always"; // the option that is no longer on offer
    },
  });
  bus.publish(newEnvelope("user", "PERMISSION", { to: ["kimi"] }));
  await until(() => said.length === 1);
  expect(asked[0]!.title).toBe("write file (payload not reported by the agent)");
  expect(asked[0]!.options).not.toContain("allow_always");
  expect(said[0]!.body).toEndWith("permission=cancelled"); // an option that was withheld is not accepted
});

// issue #72: Kimi 2.1.1 sends no rawInput before the answer; the arguments stream as content text.
test("Kimi 2.1.1: streamed argument JSON is the payload once complete; a partial stream stays unresolved", async () => {
  const asked: { title: string; options: string[] }[] = [];
  const { bus, said } = await setup({
    onPermission: async (req) => {
      asked.push({ title: req.title, options: req.options.map((o) => o.kind) });
      return "yes";
    },
  });
  bus.publish(newEnvelope("user", "PERMISSION STREAMED", { to: ["kimi"] }));
  await until(() => said.length === 1);
  expect(asked[0]).toEqual({ title: 'Bash: {"command":"make test"}', options: ["allow_once", "allow_always", "reject_once"] });
  bus.publish(newEnvelope("user", "PERMISSION PARTIAL", { to: ["kimi"] }));
  await until(() => said.length === 2);
  expect(asked[1]!.title).toBe("Bash (payload not reported by the agent)");
  expect(asked[1]!.options).not.toContain("allow_always");
  // a payload the console cannot show whole is marked as cut and buys no session-wide grant
  bus.publish(newEnvelope("user", "PERMISSION LONG", { to: ["kimi"] }));
  await until(() => said.length === 3);
  expect(asked[2]!.title).toMatch(/^Bash: \{"command":"echo x+ \[cut, \d+ chars\]$/);
  expect(asked[2]!.options).not.toContain("allow_always");
  // the same call id again, announced but with nothing streamed: the earlier call's JSON must not stand in
  bus.publish(newEnvelope("user", "PERMISSION REUSED", { to: ["kimi"] }));
  await until(() => said.length === 4);
  expect(asked[3]!.title).toBe("Bash (payload not reported by the agent)");
  expect(asked[3]!.options).not.toContain("allow_always");
});

test("the hub's own tools are approved once without asking; a lookalike name still asks", async () => {
  const asked: string[] = [];
  const logs: string[] = [];
  const { bus, said } = await setup({
    autoApprove: (title) => title === "mcp__agent-hub__hub_task_list",
    log: (l) => logs.push(l),
    onPermission: async (req) => {
      asked.push(req.title);
      return "no";
    },
  });
  bus.publish(newEnvelope("user", "PERMISSION HUBTOOL", { to: ["kimi"] }));
  await until(() => said.length === 1);
  expect(said[0]!.body).toEndWith("permission=yes"); // the allow_once option, never allow_always
  expect(asked).toEqual([]);
  expect(logs).toContain("permission auto-approved for kimi: mcp__agent-hub__hub_task_list");
  bus.publish(newEnvelope("user", "PERMISSION SPOOF", { to: ["kimi"] }));
  await until(() => said.length === 2);
  expect(asked).toEqual(["mcp__agent-hub__rm_rf: {}"]);
  expect(said[1]!.body).toEndWith("permission=no");
});

// issue #138: Qwen 0.24.7 announces `hub_send (agent-hub MCP Server)` and then titles the permission
// request with the serialized arguments; identity must come from the announcement, never the payload text.
test("Qwen: the announced MCP identity, not the argument-JSON title, is what may be auto-approved", async () => {
  const asked: string[] = [];
  const logs: string[] = [];
  const { bus, said } = await setup({
    autoApprove: (title) => title === "mcp__agent-hub__hub_send",
    mcpServers: [{ name: "agent-hub", command: "bun", args: ["server.js"], env: [] }],
    log: (l) => logs.push(l),
    onPermission: async (req) => {
      asked.push(req.title);
      return "no";
    },
  });
  // the announced call resolves to the canonical name and is approved once without asking
  bus.publish(newEnvelope("user", "PERMISSION QWEN", { to: ["kimi"] }));
  await until(() => said.length === 1);
  expect(said[0]!.body).toEndWith("permission=yes"); // the allow_once option, never allow_always
  expect(asked).toEqual([]);
  expect(logs).toContain("permission auto-approved for kimi: mcp__agent-hub__hub_send");

  // a server this session was never configured with is not the hub's bus: the call goes to a person,
  // displayed under its announced title rather than a second copy of the argument JSON
  bus.publish(newEnvelope("user", "PERMISSION QWEN-FOREIGN", { to: ["kimi"] }));
  await until(() => said.length === 2);
  expect(asked).toEqual(['hub_send (other-bus MCP Server): {"text":"QWEN_NATIVE_READY"}']);
  expect(said[1]!.body).toEndWith("permission=no");

  // a completed call's identity is evicted: the same request shape no longer resolves
  bus.publish(newEnvelope("user", "PERMISSION QWEN-DONE", { to: ["kimi"] }));
  await until(() => said.length === 3);
  expect(asked[1]).toBe("tool call (payload not reported by the agent)");
  expect(said[2]!.body).toEndWith("permission=no");

  // a reused call id starts clean: the earlier call's identity must not stand in
  bus.publish(newEnvelope("user", "PERMISSION QWEN-REUSED", { to: ["kimi"] }));
  await until(() => said.length === 4);
  expect(asked[2]).toBe("Bash (payload not reported by the agent)");
  expect(said[3]!.body).toEndWith("permission=no");

  // argument text alone never names a tool
  bus.publish(newEnvelope("user", "PERMISSION QWEN-QUIET", { to: ["kimi"] }));
  await until(() => said.length === 5);
  expect(asked[3]).toBe("tool call (payload not reported by the agent)");
  expect(said[4]!.body).toEndWith("permission=no");
  expect(logs.filter((l) => l.includes("auto-approved"))).toHaveLength(1);

  // a tool_call_update's display title is mutable: it must not rewrite the announced identity,
  // in either direction
  bus.publish(newEnvelope("user", "PERMISSION QWEN-RETITLE", { to: ["kimi"] }));
  await until(() => said.length === 6);
  expect(asked[4]).toBe('Bash: {"text":"QWEN_NATIVE_READY"}');
  expect(said[5]!.body).toEndWith("permission=no");
  bus.publish(newEnvelope("user", "PERMISSION QWEN-RENAME", { to: ["kimi"] }));
  await until(() => said.length === 7);
  expect(said[6]!.body).toEndWith("permission=yes"); // still the announced hub tool
  expect(logs.filter((l) => l.includes("auto-approved"))).toHaveLength(2);
});

// review of #13: an approval longer than the watchdog must not cancel the turn it belongs to.
test("a pending approval keeps the turn alive past the watchdog", async () => {
  const { bus, said } = await setup({
    watchdogMs: 150,
    onPermission: async () => {
      await new Promise((r) => setTimeout(r, 600));
      return "yes";
    },
  });
  bus.publish(newEnvelope("user", "PERMISSION", { to: ["kimi"] }));
  await until(() => said.length === 1);
  expect(said[0]!.body).toBe("echo: PERMISSION permission=yes");
  expect(peer!.state).not.toBe("offline");
});

test("only a bare tool name travels apart from the title", async () => {
  const tools: (string | undefined)[] = [];
  const { bus, said } = await setup({ onPermission: async (req) => (tools.push(req.tool), "yes") });
  bus.publish(newEnvelope("user", "PERMISSION ANNOUNCED", { to: ["kimi"] })); // title "Bash"
  await until(() => said.length === 1);
  bus.publish(newEnvelope("user", "PERMISSION", { to: ["kimi"] })); // title "write file": prose, stays in the title
  await until(() => said.length === 2);
  expect(tools).toEqual(["Bash", undefined]);
});

test("a dead child goes offline", async () => {
  await setup();
  await peer!.stop();
  await until(() => peer!.state === "offline");
});

test("a command that cannot be spawned rejects start instead of crashing the process", async () => {
  peer = new AcpPeer("kimi", { cmd: ["/nonexistent/agent-hub-no-such-binary"], cwd: process.cwd() });
  await expect(peer.start()).rejects.toThrow(/spawn failed/);
  expect(peer.state).toBe("offline");
});

test("ACP child drops recovery authority while retaining account and state environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-acp-env-"));
  const record = join(dir, "env.json");
  const env = { ...process.env, FAKE_ACP_ENV_RECORD: record, AGENTHUB_RECOVERY_OPERATION: "operation-secret", CODEX_HOME: "/account/codex", CLAUDE_CONFIG_DIR: "/account/claude", AGENTHUB_STATE_DIR: "/project/state" };
  const child = new AcpPeer("kimi", { cmd: FAKE, cwd: process.cwd(), env });
  try {
    await child.start();
    for (let i = 0; i < 100 && !existsSync(record); i++) await Bun.sleep(10);
    const observed = JSON.parse(readFileSync(record, "utf8"));
    expect(observed.recovery).toBeUndefined();
    expect(observed.codex).toBe("/account/codex");
    expect(observed.claude).toBe("/account/claude");
    expect(observed.state).toBe("/project/state");
  } finally {
    await child.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdog: the cancelled prompt reports late and must not disturb the turn that followed it", async () => {
  const { bus, said } = await setup({ watchdogMs: 60 });
  bus.publish(newEnvelope("user", "SLOW", { to: ["kimi"] }));
  bus.publish(newEnvelope("user", "after", { to: ["kimi"] }));
  await until(() => said.length === 1);
  await new Promise((r) => setTimeout(r, 80));
  expect(said.map((e) => e.body)).toEqual(["echo: after"]); // nothing attributed to SLOW
  expect(peer!.state).toBe("idle");
});

test("a prompt the agent rejects is retried, then reported undeliverable instead of blocking the queue", async () => {
  const bus = new Bus({ retryMs: 10, batchMs: 0 });
  const events: string[] = [];
  bus.tap((e) => events.push(e.t === "envelope" ? `msg:${e.env.from}:${e.env.body}` : e.t));
  peer = new AcpPeer("kimi", { cmd: FAKE, cwd: process.cwd() });
  bus.add(peer);
  await peer.start();
  bus.publish(newEnvelope("user", "BROKEN", { to: ["kimi"] }));
  bus.publish(newEnvelope("user", "fine", { to: ["kimi"] }));
  await until(() => events.includes("msg:kimi:echo: fine"));
  expect(events.filter((e) => e === "undeliverable")).toHaveLength(1);
});

// issue #115: an ACP agent CLI may be a launcher with a native child, as Codex's is (#113): the adapter spawns it in a
// process group of its own and stops that group as one; without the group, a launcher ignoring SIGTERM is never signalled.
test("the adapter stops a launcher that ignores SIGTERM together with the agent it waits for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-acp-launcher-"));
  const pidFile = join(dir, "agent.pid"), launcherFile = join(dir, "launcher.pid"), bin = join(dir, "kimi");
  writeFileSync(bin, `#!/bin/sh\necho $$ > ${launcherFile}\ntrap "" TERM\nexec 3<&0\n${FAKE.join(" ")} <&3 &\necho $! > ${pidFile}\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
  const launched = new AcpPeer("kimi", { cmd: [bin], cwd: dir });
  try {
    await launched.start();
    const agent = Number(readFileSync(pidFile, "utf8")), launcher = Number(readFileSync(launcherFile, "utf8"));
    await launched.stop();
    expect(processTable()!.some((r) => r.pid === agent || r.pid === launcher)).toBe(false);
  } finally {
    for (const f of [pidFile, launcherFile]) {
      const pid = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
      if (pid && processTable()?.some((r) => r.pid === pid && /kimi|acp-server/.test(r.command))) process.kill(pid, "SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("#161 native cumulative usage preserves zero and projects only checked counters", async () => {
  const { normalizeACPUsage } = await import('../src/adapters/acp.ts');
  expect(normalizeACPUsage({ totalTokens: 0, prompt: 'private' })).toEqual({ source: 'usage_update', availability: 'known', shape: 'total', total: 0 });
  expect(normalizeACPUsage({ used: 42, size: 1000 })).toEqual({ source: 'usage_update', availability: 'unsupported', shape: 'context-used', contextUsed: 42, contextCapacity: 1000 });
  expect(normalizeACPUsage({ usage: { input_tokens: 2, output_tokens: 3 } })).toMatchObject({ total: 5, shape: 'input-output' });
  for (const value of [{ totalTokens: -1 }, { totalTokens: Infinity }, { totalTokens: '0' }, { inputTokens: 2 }]) expect(normalizeACPUsage(value).availability).toBe('invalid');
  expect(normalizeACPUsage({ unrelated: 'private' }, 'prompt_result')).toEqual({ source: 'prompt_result', availability: 'unsupported', shape: 'none' });
});

// #240/#242: opt-in native modes are negotiated before any prompt, on new and recovered sessions.
for (const resume of [false, true]) for (const [mode, modeId] of [["ask-when-needed", "yolo"], ["never-ask", "auto"]] as const) {
  test(`ACP ${resume ? "load" : "new"} applies ${mode} before prompting`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ahub-acp-mode-"));
    const record = join(dir, "protocol.jsonl");
    try {
      const { bus, said } = await setup({ cmd: [...FAKE, "--record-protocol", record], permissionMode: mode, ...(resume ? { resumeSessionId: "s1" } : {}) });
      expect(peer!.getPermissionMode()).toBe(mode);
      bus.publish(newEnvelope("user", "ping", { to: ["kimi"] }));
      await until(() => said.length === 1);
      expect(said[0]!.body).toBe("echo: ping"); // fake rejects a prompt while set_mode's reply is pending
      const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.map((m) => m.method)).toEqual(["initialize", resume ? "session/load" : "session/new", "session/set_mode", "session/prompt"]);
      expect(calls[2].params).toEqual({ sessionId: "s1", modeId });
      await peer!.setPermissionMode("ask");
      expect(peer!.getPermissionMode()).toBe("ask");
      const reset = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
      expect(reset.params.modeId).toBe("default");
    } finally { await peer?.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("ACP ask leaves the initial session default untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-acp-default-"));
  try {
    const record = join(dir, "protocol.jsonl");
    await setup({ cmd: [...FAKE, "--record-protocol", record], permissionMode: "ask" });
    expect(readFileSync(record, "utf8")).not.toContain("session/set_mode");
    expect(peer!.getPermissionMode()).toBe("ask");
  } finally { await peer?.stop(); rmSync(dir, { recursive: true, force: true }); }
});

for (const args of [["--modes", "default"], ["--refuse-mode"]]) {
  test(`ACP startup fails offline naming the unavailable/refused mode: ${args.join(" ")}`, async () => {
    peer = new AcpPeer("kimi", { cmd: [...FAKE, ...args], cwd: process.cwd(), permissionMode: "never-ask" });
    await expect(peer.start()).rejects.toThrow("never-ask");
    expect(peer.state).toBe("offline");
  });
}

test("ACP runtime refusal preserves the previously applied mode", async () => {
  await setup({ cmd: [...FAKE, "--refuse-mode"] });
  await expect(peer!.setPermissionMode("never-ask")).rejects.toThrow("never-ask");
  expect(peer!.getPermissionMode()).toBe("ask");
  expect(peer!.state).toBe("idle");
});

for (const loaded of ["yolo", "auto"]) {
  test(`ACP resumed ask resets a retained ${loaded} mode before its first prompt`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ahub-acp-resumed-mode-"));
    const record = join(dir, "protocol.jsonl");
    try {
      const { bus, said } = await setup({ cmd: [...FAKE, "--loaded-mode", loaded, "--record-protocol", record], resumeSessionId: "s1" });
      bus.publish(newEnvelope("user", "ping", { to: ["kimi"] }));
      await until(() => said.length === 1);
      expect(said[0]!.body).toBe("echo: ping");
      const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.map((m) => m.method)).toEqual(["initialize", "session/load", "session/set_mode", "session/prompt"]);
      expect(calls[2].params.modeId).toBe("default");
      expect(peer!.getPermissionMode()).toBe("ask");
    } finally { await peer?.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("ACP resumed ask refuses a retained mode when default cannot be negotiated", async () => {
  peer = new AcpPeer("kimi", { cmd: [...FAKE, "--loaded-mode", "auto", "--modes", "auto"], cwd: process.cwd(), resumeSessionId: "s1" });
  await expect(peer.start()).rejects.toThrow("permission mode ask unavailable");
  expect(peer.state).toBe("offline");
});

for (const mode of ["ask", "ask-when-needed", "never-ask"] as const) {
  test(`Qwen's advertised yolo/auto-edit modes cannot use the Kimi ${mode} mapping even under peer id kimi`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ahub-acp-vendor-"));
    const record = join(dir, "protocol.jsonl");
    try {
      await setup({ cmd: [...FAKE, "--agent-name", "Qwen Code", "--modes", "default,auto-edit,yolo,auto", "--record-protocol", record] });
      expect(peer!.state).toBe("idle"); // the ordinary vendor-default startup remains compatible
      await expect(peer!.setPermissionMode(mode)).rejects.toThrow("no verified mode mapping");
      expect(readFileSync(record, "utf8")).not.toContain("session/set_mode");
      expect(peer!.getPermissionMode()).toBe("ask");
    } finally { await peer?.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const vendorArgs of [["--agent-name", "Qwen Code"], ["--agent-name", "Not Kimi Code CLI"], ["--no-agent-info"]]) {
  test(`an unverified ACP vendor refuses a non-ask startup: ${vendorArgs.join(" ")}`, async () => {
    peer = new AcpPeer("kimi", { cmd: [...FAKE, ...vendorArgs], cwd: process.cwd(), permissionMode: "ask-when-needed" });
    await expect(peer.start()).rejects.toThrow("no verified mode mapping");
    expect(peer.state).toBe("offline");
  });
}

test("resuming a non-Kimi agent never sends a Kimi default reset", async () => {
  peer = new AcpPeer("kimi", { cmd: [...FAKE, "--agent-name", "Qwen Code", "--loaded-mode", "yolo"], cwd: process.cwd(), resumeSessionId: "s1" });
  await expect(peer.start()).rejects.toThrow("no verified mode mapping");
  expect(peer.state).toBe("offline");
});

for (const startup of [false, true]) {
  test(`ACP ${startup ? "startup" : "runtime"} mode timeout becomes unknown/offline and a late ack cannot resurrect it`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ahub-acp-mode-timeout-"));
    const record = join(dir, "protocol.jsonl"), ack = join(dir, "ack.txt"), pidFile = join(dir, "pid.txt");
    const states: string[] = [];
    peer = new AcpPeer("kimi", {
      cmd: [...FAKE, "--record-protocol", record, "--mode-delay-ms", "200", "--mode-ack-record", ack, "--ignore-term", "--record-pid", pidFile],
      cwd: process.cwd(), permissionModeTimeoutMs: 40, ...(startup ? { permissionMode: "never-ask" as const } : {}),
    });
    peer.onState = (state) => states.push(state);
    try {
      if (startup) await expect(peer.start()).rejects.toThrow("never-ask unknown");
      else {
        await peer.start();
        await expect(peer.setPermissionMode("never-ask")).rejects.toThrow("never-ask unknown");
        expect(peer.getPermissionMode()).toBe("ask");
      }
      expect(peer.permissionModeState).toBe("unknown");
      expect(peer.state).toBe("offline");
      expect(states.slice(states.indexOf("offline"))).not.toContain("idle");
      // Fake ignores TERM, so the ack actually arrived during the owned-group stop's grace period.
      expect(readFileSync(ack, "utf8")).toBe("auto\n");
      const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.filter((call) => call.method === "session/set_mode")).toHaveLength(1);
      expect(calls.some((call) => call.method === "session/prompt")).toBe(false);
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(processTable()!.some((row) => row.pid === pid || row.pgid === pid)).toBe(false);
      await expect(peer.setPermissionMode("ask")).rejects.toThrow("unknown");
      await expect(peer.deliver([newEnvelope("user", "must not run")])).rejects.toThrow("offline");
    } finally { await peer?.stop(); rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
}
