import { expect, test } from "bun:test";
import { backendLabel, backendLine, type PeerRow } from "../src/cli/status-lines.ts";

import { renderStatus } from "../src/cli/output.ts";
import { paint } from "../src/cli/console-state.ts";

// issue #32: the label read "dgx/dgx/coding", and a Pi turn's backend was only visible in status.json.

test("a namespaced alias is printed as it is, an unnamespaced one keeps its kind", () => {
  expect(backendLabel({ kind: "dgx", alias: "dgx/coding" })).toBe("dgx/coding");
  expect(backendLabel({ kind: "mlx", alias: "mlx/fast" })).toBe("mlx/fast");
  expect(backendLabel({ kind: "dgx", alias: "coding" })).toBe("dgx/coding");
  expect(backendLabel({})).toBe("unknown/unknown");
});

test("a backend line carries the requested and actual model", () => {
  expect(backendLine({ kind: "mlx", alias: "mlx/fast", state: "ready", active: 0, requestedModel: "mlx/fast", actualModel: "/models/qwen3-8b-mlx" }))
    .toBe("  model    mlx/fast ready active 0 requested mlx/fast actual /models/qwen3-8b-mlx");
});

test("#199 a cooling backend says until when and after how many failures", () => {
  expect(backendLine({ kind: "mlx", alias: "mlx/fast", state: "error", active: 0, coolingUntil: "2026-10-09T00:00:30.000Z", failures: 3 }))
    .toBe("  model    mlx/fast error active 0 cooling down until 2026-10-09T00:00:30.000Z after 3 failures");
  expect(backendLine({ kind: "dgx", alias: "dgx/fast", state: "error", active: 0, failingUntil: "2026-10-09T00:00:30.000Z" }))
    .toBe("  model    dgx/fast error active 0 last dispatch failed, no load moves until 2026-10-09T00:00:30.000Z");
  const rendered = renderStatus({ peers: {}, models: { backends: [{ kind: "mlx", alias: "mlx/fast", state: "error", coolingUntil: "2026-10-09T00:00:30.000Z", failures: 3 }, { kind: "dgx", alias: "dgx/fast", state: "error", failingUntil: "2026-10-09T00:00:30.000Z" }] } }, undefined, Date.parse("2026-10-09T00:00:00.000Z")).map(row => paint(row, false)).join("\n");
  expect(rendered).toContain("in 30s after 3 failures");
  expect(rendered).toContain("in 30s; no load moves until then");
  expect(rendered).not.toContain("2026-10-09T");
});

const statusRows = (peers: Record<string, PeerRow>, now = 60_000) => renderStatus({ peers }, undefined, now);
const text = (peers: Record<string, PeerRow>, now = 60_000) => statusRows(peers, now).map(row => paint(row, false)).join("\n");
function peerFields(id: string, peers: Record<string, PeerRow>): Record<string, string> {
  const rows = statusRows(peers);
  const header = rows.find(row => row[0]?.text.trim() === "PEER")!;
  const row = rows.find(row => row[0]?.text.trim() === id)!;
  return Object.fromEntries(header.map((span, i) => [span.text.trim(), row[i]?.text.trim() ?? ""]));
}
test("status rows name the requested or last served backend and move pause explanations to details", () => {
  expect(peerFields("pi", { pi: { state: "idle", queued: 0, requestedModel: "dgx/coding" } }).MODEL).toBe("dgx/coding");
  expect(peerFields("kimi", { kimi: { state: "idle", queued: 0 } })).toEqual({ PEER: "kimi", STATE: "idle", LINK: "attached", CONTEXT: "unknown" });
  expect(peerFields("local", { local: { state: "idle", servedBy: "switchyard sy/coding -> glm53" } }).MODEL).toBe("switchyard sy/coding -> glm53");
  expect(text({ pi: { state: "idle", requestedModel: "dgx/coding", servedBy: "dgx/backend" } })).toContain("requested model  dgx/coding");
  expect(peerFields("codex", { codex: { state: "paused", queued: 2, paused: "budget" } })).toMatchObject({ STATE: "paused", Q: "2", PAUSE: "budget" });
  expect(text({ codex: { state: "paused", queued: 2, paused: "budget" } })).toContain("paused  budget");
});
// #41: important queued envelopes must remain distinguishable from the whole queue.
test("status table distinguishes total and important queued messages, and omits an all-zero column", () => {
  for (const [queued, important] of [[1, 1], [3, 2], [2, 0]] as const) {
    const fields = peerFields("kimi", { kimi: { state: "idle", queued, queuedImportant: important } });
    expect(fields.Q).toBe(String(queued));
    if (important) expect(fields["!"]).toBe(String(important)); else expect(fields["!"]).toBeUndefined();
  }
  expect(peerFields("codex", { codex: { state: "paused", queued: 2, queuedImportant: 2, paused: "budget" } })).toMatchObject({ Q: "2", "!": "2", PAUSE: "budget" });
});
test("tools-only state and its next action remain visible in a labelled detail (#205)", () => {
  const peers = { claude: { state: "idle", queued: 2, toolsOnly: "tools-only: messages wait for hub_inbox; for pushes restart Claude with ahub claude" } };
  expect(peerFields("claude", peers)).toMatchObject({ LINK: "tools-only", Q: "2" });
  expect(text(peers)).toContain("messages wait for hub_inbox; for pushes restart Claude with ahub claude");
});
test("a disconnected recipient exposes pending age and uncertain work", () => {
  const peers = { codex: { state: "offline", queued: 2, queuedImportant: 1, needsReview: 1, attached: false, oldestQueuedAt: 0 } };
  expect(peerFields("codex", peers)).toMatchObject({ STATE: "offline", Q: "2", "!": "1", REVIEW: "1", LINK: "detached" });
  expect(text(peers)).toContain("codex oldest queued  1m ago");
});
