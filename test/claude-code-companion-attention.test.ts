import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { needs } from "../src/ui/needs.ts";

/** Execute the shipped closed producer with synthetic port facts, not a daemon/account. */
function emittedPaused(record: unknown, manual = false, state = "idle") {
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const begin = source.indexOf("  const pausedNote = (id: PeerId) => {");
  const end = source.indexOf("\n  };", begin) + "\n  };".length;
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(begin, end));
  return new Function("budget", "manualPaused", "bus", `${compiled}; return pausedNote('claude');`)(
    { record: () => record }, new Set(manual ? ["claude"] : []), { stateOf: () => state },
  );
}

test("current pausedNote producer distinguishes budget, manual and unavailable fields", () => {
  expect(emittedPaused({ reason: "PRIVATE_REASON", resetsAt: 10000 }).paused.startsWith("budget: ")).toBe(true);
  expect(emittedPaused(undefined, true, "offline")).toEqual({ paused: "manual" });
  expect(emittedPaused(undefined)).toEqual({});
});

test("current needs producer exposes one unexpired approval first, not a permission inventory", () => {
  const value = needs({ approvals: [{ id: "perm-1", peer: "claude", expiresAt: 2000 }, { id: "perm-2", expiresAt: 3000 }], peers: { codex: { needsReview: 1 } } }, 1000);
  expect(value.items[0]).toEqual({ kind: "approval", level: "act", peer: "claude", id: "perm-1", until: 2000 });
  expect(needs({ approvals: [{ id: "expired", expiresAt: 999 }] }, 1000).items).toEqual([]);
});

test("offline need is broader than in_progress and cannot supply the required assigned-state proof", () => {
  for (const state of ["proposed", "in_progress", "changes_requested"]) {
    expect(needs({ peers: { codex: { state: "offline" } }, tasks: [{ id: 1, state, owner: "codex" }] }, 1000).items[0]?.kind).toBe("offline");
  }
});

import { attentionLines } from "../integrations/claude-code/hooks/attention.ts";
import { consoleCommand, projectReading, type Reading } from "../integrations/claude-code/hooks/status.ts";
const root = "/fixture/a b'; $(touch never-run)";
const binding = { root, projectId: "p_fixture" };
const rawStatus = { cwd: root, projectId: binding.projectId, version: "0.35.0", peers: {}, tasks: {} };
const positive = () => projectReading({ ...rawStatus,
  peers: { claude: { state: "paused", queued: 0, attached: true, needsReview: 2, ...emittedPaused({ reason: "PRIVATE_REASON", resetsAt: 9999 }) } },
  needs: { first: { kind: "approval", level: "act", peer: "claude", id: "PRIVATE_TICKET", until: 2000, note: "PRIVATE_NOTE" } },
}, binding, 1000);

test("fresh partial snapshots show only independently proven kinds and literal terminal guidance", () => {
  const reading = positive(), lines = attentionLines(reading, root, 1000);
  expect(reading.state).toBe("partial"); expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("2 held deliveries"); expect(lines[1]).toContain("budget pause"); expect(lines[2]).toContain("Permission request");
  expect(lines.every(line => line.endsWith(consoleCommand(root)))).toBe(true);
  expect(reading.peers?.[0]?.budgetPaused).toBe(true);
  expect(reading.permission).toEqual({ peer: "claude", until: 2000 });
  expect(JSON.stringify(reading)).not.toContain("PRIVATE"); expect(lines.join("\n")).not.toContain("PRIVATE");
  expect(reading.missing).toContain("full permission inventory"); expect(reading.missing).toContain("offline assigned in_progress");
});

test("stale, unrecognized, unknown, failed or identity-refused readings never show a waiting band", () => {
  const reading = positive();
  for (const state of ["stale", "unknown", "unrecognized", "binding", "offline", "unavailable_version", "missing_cli", "timeout", "nonzero", "oversized"] as const) {
    expect(attentionLines({ ...reading, state }, root, 1000)).toEqual([]);
  }
  expect(attentionLines(reading, root, 61001)).toEqual([]);
  expect(attentionLines({ ...reading, fetchedAt: undefined }, root, 1000)).toEqual([]);
  expect(attentionLines(reading, root, 999)).toEqual([]);
  expect(attentionLines(reading, root, NaN)).toEqual([]);
  expect(attentionLines(reading, "", 1000)).toEqual([]);
  expect(attentionLines({ ...reading, state: "running" }, root, 1000)).toHaveLength(3);
});

test("permission evidence expires independently, without turning missing or aggregate needs into a band", () => {
  expect(attentionLines(positive(), root, 2000)).toHaveLength(2);
  for (const first of [undefined, { kind: "approval", level: "watch", until: 2000 }, { kind: "approval", level: "act", until: 999 }, { kind: "approval", level: "act", until: 2000, peer: "bad\npeer" }, { kind: "unknown", level: "act", until: 2000 }]) {
    const reading = projectReading({ ...rawStatus, needs: { act: 100, state: "waiting", first } }, binding, 1000);
    expect(reading.permission).toBeUndefined(); expect(attentionLines(reading, root, 1000)).toEqual([]);
    expect(reading.missing).toContain("full permission inventory");
  }
});

test("manual pause, arbitrary paused state and active WIP never imply budget or offline in_progress needs", () => {
  for (const paused of [undefined, "manual", "budgetary: unavailable", { reason: "budget" }]) {
    const reading = projectReading({ ...rawStatus, peers: { codex: { state: "offline", queued: 0, paused, budgetPaused: true } },
      taskWip: { codex: { active: 7 } }, needs: { first: { kind: "offline", level: "watch", peer: "codex", id: 1 } },
    }, binding, 1000);
    expect(reading.peers?.[0]?.budgetPaused).toBeUndefined(); expect(attentionLines(reading, root, 1000)).toEqual([]);
    expect(reading.missing).toContain("offline assigned in_progress");
  }
});

test("attention is bounded by closed peer projections and validates cached positive metadata", () => {
  const reading: Reading = { state: "partial", fetchedAt: 1000, peers: [{ id: "bad\npeer", state: "idle", needsReview: 2, budgetPaused: true }], permission: { until: 2000, peer: "bad\npeer" } };
  expect(attentionLines(reading, root, 1000)).toEqual([]);
});
