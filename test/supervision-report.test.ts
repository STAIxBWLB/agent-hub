import { expect, test } from "bun:test";
import type { HubEvent, StampedEvent } from "../src/hub/events.ts";
import { formatReport, summarize } from "../src/hub/report.ts";

const ev = (e: HubEvent): StampedEvent => ({ v: 1, at: "2026-10-09T00:00:00.000Z", ...e });

test("supervision measures completed native turns once and separates owner work from conductor actions", () => {
  const r = summarize([
    ev({ type: "conduct", peer: "claude", action: "task_assign", task: 1, target: "kimi" }),
    ev({ type: "conduct", peer: "claude", action: "task_assign", task: 2, target: "pi" }),
    ev({ type: "turn_end", peer: "kimi", turn: "owner-1", ms: 100, tokens: 200 }),
    ev({ type: "tokens", peer: "kimi", n: 200 }),
    ev({ type: "supervision_turn", peer: "claude", turn: "supervisor-1", tokens: 50, ms: 100 }),
    ev({ type: "supervision_turn", peer: "claude", turn: "supervisor-1", tokens: 50, ms: 100 }),
    ev({ type: "supervision_turn", peer: "claude", turn: "supervisor-2" }),
  ]);
  expect(r.conduct).toEqual({ claude: { task_assign: 2 } });
  expect(r.supervision).toEqual({ claude: { turns: 2, tokens: null, measuredTokens: 50, knownTokenTurns: 1, unknownTokenTurns: 1 } });
  expect(r.peers.kimi?.tokens).toBe(200);
  const text = formatReport(r).join("\n");
  expect(text).toContain("supervision claude: 2 completed native turns; tokens unknown; 50 measured tokens");
  expect(text).toContain("1 completed turns with unknown tokens");
  expect(text).toContain("whole native turns containing supervision, including other work");
  expect(text).toContain("measured spend unknown");
});

test("unobserved supervision and invalid native counters remain unknown; measured zero stays zero", () => {
  const unknown = summarize([ev({ type: "conduct", peer: "codex", action: "peer_hold", target: "pi" })]);
  expect(unknown.supervision.codex?.turns).toBeNull();
  expect(unknown.supervision.codex?.tokens).toBeNull();
  expect(formatReport(unknown).join("\n")).toContain("supervision codex: turns unknown; tokens unknown");
  const zero = summarize([
    ev({ type: "supervision_turn", peer: "claude", turn: "one", tokens: 0 }),
    ev({ type: "supervision_turn", peer: "codex", turn: "one", tokens: NaN }),
    ev({ type: "supervision_turn", peer: "codex", turn: "two", tokens: -10 }),
  ]);
  expect(zero.supervision.claude?.tokens).toBe(0);
  expect(zero.supervision.codex?.tokens).toBeNull();
  expect(zero.supervision.codex?.unknownTokenTurns).toBe(2);
});

test("agent CLI telemetry carries identity/refusal without being a supervision turn", () => {
  const r = summarize([ev({ type: "agent_cli", peer: "codex", command: "permit", refused: true })]);
  expect(r.supervision).toEqual({});
  expect(r.conduct).toEqual({});
});

test("known usage after an unknown turn remains a measured subset, never a complete total", () => {
  const r = summarize([
    ev({ type: "supervision_turn", peer: "codex", turn: "missing" }),
    ev({ type: "supervision_turn", peer: "codex", turn: "known", tokens: 123 }),
  ]);
  expect(r.supervision.codex).toEqual({ turns: 2, tokens: null, measuredTokens: 123, knownTokenTurns: 1, unknownTokenTurns: 1 });
  expect(formatReport(r).join("\n")).toContain("tokens unknown; 123 measured tokens (1 known turns)");
});
