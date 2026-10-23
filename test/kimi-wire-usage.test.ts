import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiWireReader, kimiCountedTokens, kimiRowTotal } from "../src/adapters/kimi-wire-usage.ts";
import { KimiUsage, kimiSeedRows } from "../src/hub/kimi-usage.ts";
import { TokenWindow } from "../src/hub/token-window.ts";

// Fixture format: Kimi Code wire protocol_version 1.5 (read from the logs of Kimi 2.3.0 on this machine; the issue read 2.1.1).
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const MARKER = "SECRET-PROMPT-MARKER-7731";

function home() {
  const root = mkdtempSync(join(tmpdir(), "ahub-kimi-wire-")); dirs.push(root);
  const sessions = join(root, "sessions", "wd_proj_abc123");
  mkdirSync(sessions, { recursive: true });
  return { root, sessions };
}
function session(h: ReturnType<typeof home>, id = "session_aaaa-1111", agents: string[] = ["main"]) {
  const dir = join(h.sessions, id);
  for (const agent of agents) { mkdirSync(join(dir, "agents", agent), { recursive: true }); writeFileSync(join(dir, "agents", agent, "wire.jsonl"), meta()); }
  appendFileSync(join(h.root, "session_index.jsonl"), `${JSON.stringify({ sessionId: id, sessionDir: dir, workDir: "/w" })}\n`);
  return { id, dir, wire: (agent = "main") => join(dir, "agents", agent, "wire.jsonl") };
}
const meta = (protocol = "1.5") => `${JSON.stringify({ type: "metadata", protocol_version: protocol, created_at: 1 })}\n`;
const row = (inputOther: number, output: number, inputCacheRead = 0, inputCacheCreation = 0, time = 1_790_000_000_000, extra: object = {}) =>
  `${JSON.stringify({ type: "usage.record", agentId: "main", model: "kimi-code/k3", usage: { inputOther, output, inputCacheRead, inputCacheCreation }, usageScope: "turn", time, ...extra })}\n`;
const other = (type: string, text = MARKER) => `${JSON.stringify({ type, agentId: "main", text })}\n`;

test("AC2: two reads return exactly the new rows of the owned session, sub-agents included", () => {
  const h = home(), s = session(h, "session_aaaa-1111", ["main", "agent-0"]);
  const reader = new KimiWireReader({ home: h.root, sessionId: s.id });
  expect(reader.read()).toEqual({ status: "ok", rows: [], more: false });
  appendFileSync(s.wire(), other("prompt") + row(10, 2, 100, 5) + other("message") + row(20, 4));
  appendFileSync(s.wire("agent-0"), row(7, 1, 3, 0));
  const first = reader.read();
  expect(first.status).toBe("ok");
  if (first.status !== "ok") return;
  expect(first.rows.map(r => [r.inputOther, r.output, r.inputCacheRead, r.inputCacheCreation, r.model])).toEqual([[7, 1, 3, 0, "kimi-code/k3"], [10, 2, 100, 5, "kimi-code/k3"], [20, 4, 0, 0, "kimi-code/k3"]]); // agents read in name order
  expect(new Set(first.rows.map(r => r.id)).size).toBe(3);
  appendFileSync(s.wire(), row(1, 1));
  const second = reader.read();
  expect(second.status === "ok" && second.rows.map(r => r.inputOther)).toEqual([1]);
  expect(reader.read()).toEqual({ status: "ok", rows: [], more: false });
});

test("AC2: another session's rows are never read, and a row id is stable across readers", () => {
  const h = home(), a = session(h, "session_aaaa-1111"), b = session(h, "session_bbbb-2222");
  appendFileSync(a.wire(), row(1, 1)); appendFileSync(b.wire(), row(500, 500));
  const one = new KimiWireReader({ home: h.root, sessionId: a.id }).read(), two = new KimiWireReader({ home: h.root, sessionId: a.id }).read();
  expect(one.status === "ok" && one.rows.map(r => r.inputOther)).toEqual([1]);
  expect(one).toEqual(two);
});

test("AC2: a truncated last line is unknown, then readable once Kimi finishes it", () => {
  const h = home(), s = session(h);
  const reader = new KimiWireReader({ home: h.root, sessionId: s.id });
  appendFileSync(s.wire(), row(10, 2).trimEnd().slice(0, 60));
  expect(reader.read()).toEqual({ status: "unknown", reason: "partial-line" });
  writeFileSync(s.wire(), meta() + row(10, 2));
  const again = reader.read();
  expect(again.status === "ok" && again.rows.map(r => r.inputOther)).toEqual([10]);
});

test("AC2: a shrunk file, a replaced file and a vanished agent are unknown for good, never a count", () => {
  for (const [change, reason] of [
    [(s: ReturnType<typeof session>) => truncateSync(s.wire(), 10), "shrunk"],
    [(s: ReturnType<typeof session>) => { rmSync(s.wire()); writeFileSync(s.wire(), meta() + row(1, 1).repeat(40)); }, "rotated"],
    [(s: ReturnType<typeof session>) => rmSync(s.wire()), "missing"],
  ] as const) {
    const h = home(), s = session(h);
    appendFileSync(s.wire(), row(10, 2) + row(10, 2));
    const reader = new KimiWireReader({ home: h.root, sessionId: s.id });
    expect(reader.read().status).toBe("ok");
    change(s);
    expect(reader.read()).toEqual({ status: "unknown", reason });
    appendFileSync(join(s.dir, "agents", "main", "wire.jsonl"), meta() + row(1, 1), { flag: "a" });
    expect(reader.read()).toEqual({ status: "unknown", reason }); // it does not heal into a short count
  }
});

test("AC2: an unknown row shape, an unknown protocol, malformed JSON and a missing index each give unknown", () => {
  const cases: [import("../src/adapters/kimi-wire-usage.ts").KimiWireReason, string][] = [
    ["unknown-row-shape", row(1, 1).replace('"inputOther":1', '"inputOther":"1"')],
    ["unknown-row-shape", row(1, 1).replace('"inputOther":1', '"inputOther":-1')],
    ["unknown-row-shape", `${JSON.stringify({ type: "usage.record", usage: { inputOther: 1, output: 1 }, time: 1 })}\n`],
    ["unknown-row-shape", row(1, 1, 0, 0, 1_790_000_000_000, { usageScope: "galaxy" })],
    ["malformed-row", '{"type":"usage.record","usage":{broken\n'],
  ];
  for (const [reason, line] of cases) {
    const h = home(), s = session(h);
    appendFileSync(s.wire(), row(5, 5) + line);
    expect(new KimiWireReader({ home: h.root, sessionId: s.id }).read()).toEqual({ status: "unknown", reason });
  }
  const h = home(), s = session(h);
  writeFileSync(s.wire(), meta("9.9") + row(1, 1));
  expect(new KimiWireReader({ home: h.root, sessionId: s.id }).read()).toEqual({ status: "unknown", reason: "untested-protocol" });
  writeFileSync(s.wire(), row(1, 1));
  expect(new KimiWireReader({ home: h.root, sessionId: s.id }).read()).toEqual({ status: "unknown", reason: "no-metadata" });
  expect(new KimiWireReader({ home: home().root, sessionId: "session_nobody" }).read()).toEqual({ status: "unknown", reason: "no-index" });
  expect(new KimiWireReader({ home: h.root, sessionId: "../../etc" }).read()).toEqual({ status: "unknown", reason: "no-index" });
});

test("AC2: an index row pointing outside the sessions directory, or through a symlink out of it, is refused", () => {
  const h = home(), outside = mkdtempSync(join(tmpdir(), "ahub-kimi-out-")); dirs.push(outside);
  mkdirSync(join(outside, "agents", "main"), { recursive: true }); writeFileSync(join(outside, "agents", "main", "wire.jsonl"), meta() + row(9, 9));
  appendFileSync(join(h.root, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session_evil", sessionDir: outside })}\n`);
  expect(new KimiWireReader({ home: h.root, sessionId: "session_evil" }).read()).toEqual({ status: "unknown", reason: "outside-home" });
  symlinkSync(outside, join(h.sessions, "session_link"));
  appendFileSync(join(h.root, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session_link", sessionDir: join(h.sessions, "session_link") })}\n`);
  expect(new KimiWireReader({ home: h.root, sessionId: "session_link" }).read()).toEqual({ status: "unknown", reason: "outside-home" });
  const s = session(h); symlinkSync(join(outside, "agents", "main", "wire.jsonl"), join(s.dir, "agents", "main", "linked.jsonl"));
  mkdirSync(join(s.dir, "agents", "sneaky")); symlinkSync(join(outside, "agents", "main", "wire.jsonl"), join(s.dir, "agents", "sneaky", "wire.jsonl"));
  expect(new KimiWireReader({ home: h.root, sessionId: s.id }).read()).toEqual({ status: "unknown", reason: "outside-home" });
});

test("AC2: a long prompt line is skipped unread, a long usage-looking line is refused, and the per-call bound resumes", () => {
  const h = home(), s = session(h);
  appendFileSync(s.wire(), other("prompt", "x".repeat(300_000)) + row(3, 3) + other("tool", `${"y".repeat(100_000)}`) + row(4, 4));
  const reader = new KimiWireReader({ home: h.root, sessionId: s.id, maxBytes: 131_072 });
  const seen: number[] = [];
  for (let n = 0; n < 20; n++) { const r = reader.read(); expect(r.status).toBe("ok"); if (r.status !== "ok") return; seen.push(...r.rows.map(x => x.inputOther)); if (!r.more) break; }
  expect(seen).toEqual([3, 4]);
  const h2 = home(), s2 = session(h2);
  appendFileSync(s2.wire(), `{"type":"usage.record","pad":"${"z".repeat(100_000)}"}\n`);
  expect(new KimiWireReader({ home: h2.root, sessionId: s2.id }).read()).toEqual({ status: "unknown", reason: "oversized-row" });
});

test("AC2: a message that merely quotes usage.record is not a row", () => {
  const h = home(), s = session(h);
  appendFileSync(s.wire(), other("message", 'discussing "usage.record" rows') + row(2, 2));
  const r = new KimiWireReader({ home: h.root, sessionId: s.id }).read();
  expect(r.status === "ok" && r.rows.map(x => x.inputOther)).toEqual([2]);
});

test("AC5: cache reads are recorded and excluded from the ceiling by one function", () => {
  const r = { inputOther: 10, inputCacheCreation: 5, inputCacheRead: 1_000_000, output: 2 };
  expect(kimiCountedTokens(r)).toBe(17);
  expect(kimiRowTotal(r)).toBe(1_000_017);
});

test("TokenWindow ages rows by when they were used, and reset empties it", () => {
  const w = new TokenWindow(100);
  w.add(50, 5); w.add(10, 3); w.add(60, 0); w.add(60, -4); w.add(NaN, 9);
  expect(w.sum(100)).toBe(8);
  expect(w.oldest(100)).toBe(10);
  expect(w.sum(120)).toBe(5);
  expect(w.oldest(120)).toBe(50);
  expect(w.sum(200)).toBe(0);
  w.add(1, 1); w.reset(); expect(w.sum(2)).toBe(0);
});

function usageRig(h: ReturnType<typeof home>, ceiling = 1000) {
  let now = 1_790_000_100_000, current: string | undefined;
  const log = { recorded: [] as { peer: string; counted: number; id: string }[], reports: [] as { used: number; resetsAt: number }[], forgot: 0, notices: [] as string[] };
  const usage = new KimiUsage({ home: h.root, now: () => now, ceiling: () => ceiling, session: () => current,
    record: (peer, r, counted) => log.recorded.push({ peer, counted, id: r.id }), report: (_p, w) => log.reports.push({ used: w.used, resetsAt: w.resetsAt }),
    forget: () => { log.forgot++; }, notice: line => log.notices.push(line) });
  return { usage, log, clock: (to: number) => { now = to; }, now: () => now, bind: (id: string | undefined) => { current = id; } };
}

test("AC4: collected rows count input + cache writes + output into the 5 h window; a restart seeded from the events counts none twice", () => {
  const h = home(), s = session(h), rig = usageRig(h);
  rig.bind(s.id); rig.usage.turnStarted("kimi");
  const t = rig.now();
  appendFileSync(s.wire(), row(100, 20, 50_000, 30, t) + row(200, 10, 40_000, 0, t + 5));
  rig.usage.collect("kimi");
  expect(rig.log.recorded.map(r => r.counted)).toEqual([150, 210]);
  expect(rig.log.reports.at(-1)).toMatchObject({ used: 0.36, resetsAt: t + 5 * 3_600_000 });
  rig.usage.collect("kimi");
  expect(rig.log.recorded).toHaveLength(2);
  rig.clock(t + 6 * 3_600_000);
  appendFileSync(s.wire(), row(10, 0, 0, 0, t + 6 * 3_600_000));
  rig.usage.collect("kimi");
  expect(rig.log.reports.at(-1)?.used).toBe(0.01); // the first two aged out of the window
  // a restart: a fresh KimiUsage seeded from the events it wrote
  const events = rig.log.recorded.map((r, i) => ({ type: "usage", source: "kimi_wire", id: r.id, measuredAt: new Date(t + [0, 5, 6 * 3_600_000][i]!).toISOString(), inputTokens: [100, 200, 10][i], cacheWriteTokens: [30, 0, 0][i], outputTokens: [20, 10, 0][i] }));
  const again = usageRig(h); again.clock(t + 6 * 3_600_000 + 10); again.bind(s.id);
  again.usage.seed(kimiSeedRows(events as never)); again.usage.turnStarted("kimi");
  again.usage.collect("kimi");
  expect(again.log.recorded).toHaveLength(0);
});

test("history a resumed session already holds is not counted: the floor is the hub's first sight of the session", () => {
  const h = home(), s = session(h), rig = usageRig(h);
  const t = rig.now();
  appendFileSync(s.wire(), row(999, 999, 0, 0, t - 3_600_000));
  rig.bind(s.id); rig.usage.turnStarted("kimi");
  appendFileSync(s.wire(), row(5, 5, 0, 0, t + 1));
  rig.usage.collect("kimi");
  expect(rig.log.recorded.map(r => r.counted)).toEqual([10]);
});

test("AC2: an unreadable log reports unknown once, drops the reading, and holds every figure unknown until the window clears; no count is reported", () => {
  const h = home(), s = session(h), rig = usageRig(h);
  rig.bind(s.id); rig.usage.turnStarted("kimi");
  const t = rig.now();
  appendFileSync(s.wire(), row(10, 10, 0, 0, t + 1));
  rig.usage.collect("kimi");
  expect(rig.log.reports).toHaveLength(1);
  truncateSync(s.wire(), 5);
  rig.usage.collect("kimi"); rig.usage.collect("kimi");
  expect(rig.log.forgot).toBe(2);
  expect(rig.log.notices).toHaveLength(1);
  appendFileSync(s.wire(), meta() + row(50, 50, 0, 0, t + 2));
  rig.usage.collect("kimi");
  expect(rig.log.recorded).toHaveLength(1);
  expect(rig.log.reports).toHaveLength(1);
  rig.usage.reset(); // a budget resume starts a clean window, but the log still does not read
  rig.usage.collect("kimi");
  expect(rig.log.reports).toHaveLength(1);
});

test("AC3: no marker from a prompt, message or tool output, no path and no session id reaches an event, notice or report", () => {
  const h = home(), s = session(h), rig = usageRig(h);
  rig.bind(s.id); rig.usage.turnStarted("kimi");
  const t = rig.now();
  appendFileSync(s.wire(), other("prompt") + other("message") + other("tool.result") + row(10, 10, 5, 0, t + 1, { prompt: MARKER, note: MARKER }) + other("prompt"));
  rig.usage.collect("kimi");
  appendFileSync(s.wire(), `{"type":"usage.record","usage":${MARKER}}\n`);
  rig.usage.collect("kimi");
  const seen = JSON.stringify(rig.log) + JSON.stringify(rig.log.recorded);
  for (const secret of [MARKER, h.root, s.dir, s.id, "session_aaaa"]) expect(seen).not.toContain(secret);
  expect(rig.log.recorded).toHaveLength(1);
  expect(rig.log.notices).toHaveLength(1);
});
