import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpPeer, type AcpOptions } from "../src/adapters/acp.ts";
import { Bus } from "../src/hub/bus.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";

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
