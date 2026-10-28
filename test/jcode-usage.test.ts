import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpTurnUsage, normalizeACPUsage } from "../src/adapters/acp.ts";
import { jcodeContextValue } from "../src/adapters/definitions/native-context.ts";
import { codexWindows, claudeWindows } from "../src/adapters/definitions/native-quota.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { configureJcodeMcp } from "../src/cli/jcode-mcp.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { ContextWindows } from "../src/hub/context-window.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { readEvents } from "../src/hub/events.ts";
import { realPath } from "../src/hub/project.ts";
import { operationalView } from "../src/hub/operational-view.ts";

// agent-hub#801: Jcode 0.99.1's structured usage. The shapes below are the ones a live run produced (docs/verification/2026-10-28-jcode-0.99.1-usage.md),
// counters only. Occupancy is a context reading; a prompt's usage is per-turn consumption; neither is a quota window, and everything else stays unknown.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const SESSION = "jcode-s1", NOW = 1_700_000_000_000;

// What 0.99.1 sent for one two-call turn (a tool call, then the answer), as probed.
const LIVE_UPDATE_1 = { sessionUpdate: "usage_update", used: 1000, size: 200000 };
const LIVE_UPDATE_2 = { sessionUpdate: "usage_update", used: 1100, size: 200000 };
const LIVE_RESULT = { stopReason: "end_turn", usage: { cachedReadTokens: 100, inputTokens: 2100, outputTokens: 40, totalTokens: 2240 } };

test("the context reader maps the live {used, size} to a source-labelled, session-bound reading", () => {
  expect(jcodeContextValue({ used: LIVE_UPDATE_2.used, size: LIVE_UPDATE_2.size }, SESSION, NOW)).toEqual({ source: "jcode_usage_update", sessionId: SESSION, measuredAt: NOW, tokens: 1100, window: 200000, used: 1100 / 200000 });
  // The registry declares it for Jcode and for nobody it does not belong to.
  const reader = definitionOf("jcode")!.budget!.context!;
  expect(reader.source).toBe("jcode_usage_update");
  expect(reader.read({ used: 50, size: 100 }, SESSION, NOW)).toMatchObject({ source: "jcode_usage_update", used: 0.5 });
  expect(definitionOf("kimi")!.budget!.context!.source).toBe("acp_usage_update");
});

test("malformed occupancy is unknown, never zero: the fields are null and nothing is clamped to look healthy", () => {
  const unknown = { tokens: null, window: null, used: null };
  for (const value of [undefined, null, "42", [], {}, { used: 5 }, { size: 100 }, { used: -1, size: 100 }, { used: 5, size: 0 }, { used: 5, size: -9 }, { used: 5.5, size: 100 }, { used: 5, size: 1.5 },
    { used: "5", size: 100 }, { used: NaN, size: 100 }, { used: Infinity, size: 100 }, { used: 5, size: Infinity }, { used: Number.MAX_SAFE_INTEGER + 1, size: 100 }]) {
    expect(jcodeContextValue(value, SESSION, NOW), JSON.stringify(value)).toMatchObject(unknown);
  }
  // Above the limit: the fraction clamps so a bar renders, the reported tokens stay as reported.
  expect(jcodeContextValue({ used: 300, size: 200 }, SESSION, NOW)).toMatchObject({ tokens: 300, window: 200, used: 1 });
});

test("a usage_update's {used, size} is occupancy and never consumption: ACP normalisation reports it as context, not as tokens", () => {
  expect(normalizeACPUsage({ used: 1100, size: 200000 })).toEqual({ source: "usage_update", availability: "unsupported", shape: "context-used", contextUsed: 1100, contextCapacity: 200000 });
  // No total comes out of it, so nothing downstream can mistake it for a running total.
  expect(normalizeACPUsage({ used: 1100, size: 200000 })).not.toHaveProperty("total");
});

test("an occupancy update with only one half of the pair is a malformed context reading, not an unrelated update (review of #936)", () => {
  for (const half of [{ size: 200000 }, { used: 1100 }, { size: 200000, note: "x" }]) {
    expect(normalizeACPUsage(half), JSON.stringify(half)).toEqual({ source: "usage_update", availability: "invalid", shape: "context-used" });
  }
  // An update that names neither half is still unrelated, so a stray usage_update never invalidates a good reading.
  expect(normalizeACPUsage({ unrelated: "x" })).toEqual({ source: "usage_update", availability: "unsupported", shape: "none" });
  expect(normalizeACPUsage({})).toEqual({ source: "usage_update", availability: "unsupported", shape: "none" });
});

test("a prompt result's usage is read as per-turn buckets, never from totalTokens", () => {
  expect(acpTurnUsage(LIVE_RESULT)).toEqual({ inputTokens: 2100, outputTokens: 40, cacheReadTokens: 100 });
  // Jcode's totalTokens adds the cached read on top of an input that already contains it for OpenAI-style providers (input 1234 + cached 100 + output 56 = 1390), so it is never used.
  expect(acpTurnUsage({ usage: { inputTokens: 1234, outputTokens: 56, cachedReadTokens: 100, totalTokens: 1390 } })).toEqual({ inputTokens: 1234, outputTokens: 56, cacheReadTokens: 100 });
  expect(acpTurnUsage({ usage: { inputTokens: 1, outputTokens: 2, cachedWriteTokens: 7 } })).toEqual({ inputTokens: 1, outputTokens: 2, cacheWriteTokens: 7 });
  // The probe's third turn answered with no usage member at all: unknown, not a zero record.
  expect(acpTurnUsage({ stopReason: "end_turn" })).toBeUndefined();
  for (const value of [undefined, null, 3, "x", [], { usage: null }, { usage: [] }, { usage: {} }, { usage: { inputTokens: 1 } }, { usage: { outputTokens: 1 } }, { usage: { inputTokens: -1, outputTokens: 1 } },
    { usage: { inputTokens: 1.5, outputTokens: 1 } }, { usage: { inputTokens: "1", outputTokens: 1 } }, { usage: { inputTokens: NaN, outputTokens: 1 } }, { usage: { totalTokens: 10 } }]) {
    expect(acpTurnUsage(value), JSON.stringify(value)).toBeUndefined();
  }
  // A malformed optional bucket is dropped alone: the record keeps what it can prove and invents nothing.
  expect(acpTurnUsage({ usage: { inputTokens: 1, outputTokens: 2, cachedReadTokens: -5, cachedWriteTokens: "x" } })).toEqual({ inputTokens: 1, outputTokens: 2 });
  // Nothing but counters escapes: a prompt, a path or a model name in the payload never appears in the projection.
  expect(JSON.stringify(acpTurnUsage({ usage: { inputTokens: 1, outputTokens: 2, prompt: "secret", model: "m", path: "/x" }, text: "private" }))).not.toMatch(/secret|private|\/x/);
});

test("no quota window is inferred from tokens or occupancy: Jcode declares no quota reader, and the existing readers return nothing for its shapes", () => {
  expect(definitionOf("jcode")!.budget!.reader).toBeUndefined();
  for (const shape of [LIVE_UPDATE_2, LIVE_RESULT, LIVE_RESULT.usage, { used: 1100, size: 200000 }, { limits: [{ name: "5h", usage_percent: 40, resets_at: "2026-10-28T12:00:00Z" }] }]) {
    expect(codexWindows(shape), JSON.stringify(shape)).toEqual([]);
    expect(claudeWindows(shape), JSON.stringify(shape)).toEqual([]);
  }
});

test("a reading for another session, a stale one and an unattached peer are unknown, not zero and not healthy", () => {
  const windows = new ContextWindows({ gate: 0.8, stale_min: 30 }, () => true, () => NOW);
  windows.report("jcode", jcodeContextValue({ used: 1100, size: 200000 }, SESSION, NOW), SESSION);
  expect(windows.view("jcode", SESSION, true)).toMatchObject({ source: "jcode_usage_update", tokens: 1100, window: 200000, freshness: "fresh" });
  // wrong session: the daemon's current session is not the reading's
  expect(windows.view("jcode", "another-session", true)).toMatchObject({ tokens: null, used: null, freshness: "unknown" });
  expect(windows.view("jcode", undefined, true)).toMatchObject({ tokens: null, used: null });
  expect(windows.view("jcode", SESSION, false)).toMatchObject({ tokens: null, used: null });
  // a report that names another session than the current one is dropped, so nothing is stored for it
  const other = new ContextWindows({ gate: 0.8, stale_min: 30 }, () => true, () => NOW);
  other.report("jcode", jcodeContextValue({ used: 9, size: 10 }, "foreign", NOW), SESSION);
  expect(other.view("jcode", SESSION, true)).toMatchObject({ source: null, tokens: null, freshness: "unknown" });
  // stale: older than stale_min hides the value and says so
  const later = new ContextWindows({ gate: 0.8, stale_min: 30 }, () => true, () => NOW + 31 * 60_000);
  later.report("jcode", jcodeContextValue({ used: 1100, size: 200000 }, SESSION, NOW), SESSION);
  expect(later.view("jcode", SESSION, true)).toMatchObject({ tokens: null, used: null, freshness: "stale" });
  // an invalid update after a good one is unknown, not the previous value
  const next = new ContextWindows({ gate: 0.8, stale_min: 30 }, () => true, () => NOW + 1000);
  next.report("jcode", jcodeContextValue({ used: 1100, size: 200000 }, SESSION, NOW), SESSION);
  next.report("jcode", jcodeContextValue({ used: -1, size: 200000 }, SESSION, NOW + 500), SESSION);
  expect(next.view("jcode", SESSION, true)).toMatchObject({ tokens: null, used: null });
});

test("the new usage source is accepted by the operational projection and carries only counters", () => {
  const view = operationalView({ tasks: [], isPii: () => false, publicView: () => ({}), publicMetadataText: () => true, redact: record => record });
  const record = { v: 1, at: new Date().toISOString(), type: "usage", peer: "jcode", source: "jcode_acp", id: "jcode:run:jcode:1", inputTokens: 2100, outputTokens: 40, cacheReadTokens: 100 };
  expect(view.event(record)).toMatchObject({ type: "usage", source: "jcode_acp", inputTokens: 2100, outputTokens: 40, cacheReadTokens: 100 });
  expect(view.event({ ...record, source: "jcode_unknown" })).toEqual({ type: "withheld" });   // a source nobody registered is still withheld
  expect(view.event({ ...record, prompt: "private" })).toEqual({ type: "withheld" });
});

// ---- the adapter, against the fake Jcode replaying the probed shapes: what each callback is, and is not, given ----

async function adapter(script: unknown) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-jcode-adapter-"))), home = join(dir, "home"), scriptFile = join(dir, "usage.json");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}"); writeFileSync(scriptFile, JSON.stringify(script));
  const seen = { diagnostics: [] as unknown[], tokens: [] as number[], turns: [] as { usage: unknown; sessionId: string }[] };
  const { JcodePeer } = await import("../src/adapters/jcode.ts");
  const peer = new JcodePeer({ command: [...fake, "--usage-script", scriptFile], cwd: dir, home,
    onUsageDiagnostic: (observation: unknown) => { seen.diagnostics.push(observation); },
    onTokens: (total: number) => { seen.tokens.push(total); },
    onTurnUsage: (usage: unknown, sessionId: string) => { seen.turns.push({ usage, sessionId }); } });
  cleanups.push(() => peer.stop());
  await peer.start();
  const { newEnvelope } = await import("../src/hub/envelope.ts");
  const turn = async (n: number) => { await peer.deliver([newEnvelope("user", `work ${n}`, { to: ["jcode"] })]); await until(() => seen.turns.length >= n || peer.state === "idle", `turn ${n}`); await Bun.sleep(50); };
  return { peer, seen, turn };
}

test("the adapter hands a prompt's counters to onTurnUsage with its own session id, and never to the running-total callback", async () => {
  const a = await adapter({ updates: [{ used: 1100, size: 200000 }], usage: LIVE_RESULT.usage });
  await a.turn(1);
  expect(a.seen.turns).toEqual([{ usage: { inputTokens: 2100, outputTokens: 40, cacheReadTokens: 100 }, sessionId: SESSION }]);
  // The adapter's existing running-total callback still sees the provider's own total once (unchanged behaviour: the daemon wires no such callback for Jcode, see the daemon test below),
  // and the new per-turn path adds nothing to it: the per-turn counters never become a second "total".
  expect(a.seen.tokens).toEqual([2240]);
  expect(a.seen.diagnostics).toHaveLength(2);                          // the occupancy update, and the prompt result's own diagnostic
});

test("the adapter reports a half-pair occupancy update as an invalid context reading, so the daemon can invalidate the previous value", async () => {
  const a = await adapter({ updates: [{ used: 1100, size: 200000 }, { size: 200000 }], usage: null });
  await a.turn(1);
  const context = a.seen.diagnostics.filter(d => (d as { shape: string }).shape === "context-used") as { availability: string; contextUsed?: number }[];
  expect(context.map(d => d.availability)).toEqual(["unsupported", "invalid"]);   // the good one, then the malformed one
  expect(context[1]!.contextUsed).toBeUndefined();
});

test("an idle adapter reports a half-pair occupancy update for the current session too, and ignores one that names another session", async () => {
  const a = await adapter({ updates: [], usage: null });
  const feed = (sessionId: string | undefined, update: object) => (a.peer as unknown as { onLine: (line: string) => void }).onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { ...(sessionId ? { sessionId } : {}), update: { sessionUpdate: "usage_update", ...update } } }));
  expect(a.peer.state).toBe("idle");
  feed(SESSION, { used: 1100, size: 200000 });
  feed(SESSION, { size: 200000 });                 // the half pair, arriving after the turn settled (Jcode writes occupancy per provider call)
  feed("some-other-session", { size: 200000 });    // another session: dropped before anything is reported
  const shapes = a.seen.diagnostics.map(d => `${(d as { shape: string }).shape}:${(d as { availability: string }).availability}`);
  expect(shapes).toEqual(["context-used:unsupported", "context-used:invalid"]);
});

test("the adapter ignores an occupancy update that names another session, and a throwing counter sink never costs the turn", async () => {
  const wrong = await adapter({ sessionId: "some-other-session", updates: [{ used: 1100, size: 200000 }], usage: null });
  await wrong.turn(1);
  expect(wrong.seen.diagnostics.filter(d => (d as { shape: string }).shape === "context-used")).toEqual([]);
  const { JcodePeer } = await import("../src/adapters/jcode.ts");
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-jcode-throw-"))), home = join(dir, "home"), scriptFile = join(dir, "usage.json");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}"); writeFileSync(scriptFile, JSON.stringify({ updates: [], usage: { inputTokens: 1, outputTokens: 2 } }));
  const peer = new JcodePeer({ command: [...fake, "--usage-script", scriptFile], cwd: dir, home, onTurnUsage: () => { throw new Error("sink failed"); } });
  cleanups.push(() => peer.stop());
  await peer.start();
  const { newEnvelope } = await import("../src/hub/envelope.ts");
  await peer.deliver([newEnvelope("user", "x", { to: ["jcode"] })]);
  await until(() => peer.state === "idle", "turn survives a throwing sink");
  expect(peer.state).toBe("idle");
});

// ---- the real daemon, against the fake Jcode replaying the probed shapes ----

const fake = [process.execPath, join(import.meta.dir, "fakes/jcode-agent.ts")];
const bundle = join(import.meta.dir, "../plugins/agent-hub/server.js");
const until = async (condition: () => boolean, what: string) => { for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(10); expect(condition(), what).toBe(true); };

async function hub(script: unknown) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-jcode-usage-"))), stateDir = join(dir, "state"), home = join(dir, "home"), scriptFile = join(dir, "usage.json");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}"); writeFileSync(scriptFile, JSON.stringify(script));
  configureJcodeMcp(dir, stateDir, bundle);
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, jcode_cmd: [...fake, "--usage-script", scriptFile], jcode_home: home, roster: { jcode: true }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  cleanups.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => console_.close());
  expect((await console_.request({ t: "start", peer: "jcode", args: { mode: "headless" } })).ok).toBe(true);
  const events = () => readEvents(join(stateDir, "events.jsonl"));
  const turn = async (n: number) => {
    expect((await console_.request({ t: "send", body: `work ${n}`, to: ["jcode"] })).ok).toBe(true);
    await until(() => events().filter(e => e.type === "turn_end" && e.peer === "jcode").length >= n, `turn ${n} end`);
  };
  // `status` carries a peer's context only when something was read; absent is the explicit unknown (an unread peer never shows a number).
  const context = async () => ((await console_.request({ t: "status" })).status.peers.jcode.context) as { source: string | null; tokens: number | null; window: number | null; used: number | null; freshness: string } | undefined;
  return { dir, console_, daemon, events, turn, context };
}

test("through the daemon: the live shapes become a source-labelled context reading and one per-turn usage record, and no tokens event or quota window", async () => {
  const h = await hub({ updates: [LIVE_UPDATE_1, LIVE_UPDATE_2].map(({ sessionUpdate: _, ...rest }) => rest), usage: LIVE_RESULT.usage });
  await h.turn(1);
  const context = (await h.context())!;
  expect(context).toMatchObject({ source: "jcode_usage_update", tokens: 1100, window: 200000, freshness: "fresh" });
  expect(context.used).toBeCloseTo(1100 / 200000, 10);
  const usage = h.events().filter(e => e.type === "usage" && e.peer === "jcode") as unknown as Record<string, unknown>[];
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ source: "jcode_acp", inputTokens: 2100, outputTokens: 40, cacheReadTokens: 100 });
  expect(usage[0]).not.toHaveProperty("totalTokens");                 // the provider's total double counts the cached read
  expect(typeof usage[0]!.id).toBe("string");
  // Consumption is not occupancy and not quota: no running-total event, and no window for the account.
  expect(h.events().some(e => e.type === "tokens" && e.peer === "jcode")).toBe(false);
  const budget = (await h.console_.request({ t: "budget" })) as { budget: { windows?: unknown[]; peers?: Record<string, { windows?: unknown[] }> } };
  const windows = JSON.stringify(budget.budget);
  expect(windows).not.toContain("jcode_acp");
  expect(windows).not.toContain("jcode_usage_update");
});

test("through the daemon: two turns write two usage records with distinct ids, and the event carries no text, path or session id", async () => {
  const h = await hub({ updates: [{ used: 1500, size: 200000 }], usage: { inputTokens: 1500, outputTokens: 20 } });
  await h.turn(1); await h.turn(2);
  const usage = h.events().filter(e => e.type === "usage" && e.peer === "jcode") as unknown as Record<string, unknown>[];
  expect(usage).toHaveLength(2);
  expect(new Set(usage.map(e => e.id)).size).toBe(2);
  for (const record of usage) { expect(Object.keys(record).sort()).not.toContain("sessionId"); expect(JSON.stringify(record)).not.toContain("JCODE_REPLY"); expect(JSON.stringify(record)).not.toContain(h.dir); }
});

test("through the daemon: a malformed occupancy update after a good one leaves the context unknown, not the previous percentage (review of #936)", async () => {
  const h = await hub({ updates: [{ used: 1100, size: 200000 }, { size: 200000 }], usage: null });
  await h.turn(1);
  const context = await h.context();
  expect(context === undefined || (context.tokens === null && context.used === null)).toBe(true);
  expect(context?.tokens).not.toBe(1100);
});

test("through the daemon: a turn whose prompt reports no usage writes no usage record and leaves occupancy as the last valid reading says", async () => {
  const h = await hub({ updates: [], usage: null });
  await h.turn(1);
  expect(h.events().some(e => e.type === "usage" && e.peer === "jcode")).toBe(false);
  expect(await h.context()).toBeUndefined();
});

test("through the daemon: an update for another session, and a malformed one, leave the context unknown", async () => {
  const wrong = await hub({ sessionId: "some-other-session", updates: [{ used: 1100, size: 200000 }], usage: null });
  await wrong.turn(1);
  expect(await wrong.context()).toBeUndefined();
  const bad = await hub({ updates: [{ used: -4, size: 200000 }, { used: 5, size: 0 }, { used: "7", size: 10 }], usage: { inputTokens: -1, outputTokens: 3 } });
  await bad.turn(1);
  const after = await bad.context();
  expect(after === undefined || (after.tokens === null && after.used === null)).toBe(true);   // never a number from a malformed update
  expect(bad.events().some(e => e.type === "usage" && e.peer === "jcode")).toBe(false);   // a malformed usage member is no record at all
});
