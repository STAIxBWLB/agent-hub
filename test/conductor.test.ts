import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conductor, ConductorHolds, conductorPeer, conductorStart, publicConductorStatus, publicConductorTask, requireConductor, type ConductEvent, type ConductorHooks } from "../src/hub/conductor.ts";
import { CONDUCTOR_TOOL_NAMES, DEFAULT_ROLES, TASK_TOOL_NAMES } from "../src/hub/hub-tools.ts";
import type { Task } from "../src/hub/board.ts";

describe("conductor authority", () => {
  test("only an explicit unique role grants authority", () => {
    expect(conductorPeer(DEFAULT_ROLES)).toBeNull();
    expect(conductorPeer(undefined)).toBeNull();
    expect(() => conductorPeer({ claude: ["conductor"], codex: ["conductor"] })).toThrow("at most one");
    expect(() => conductorPeer({ claude: "conductor" })).toThrow("list");
    expect(() => conductorPeer({ "claude\n": ["conductor"] })).toThrow("valid agent");
    for (const peer of ["codex", "kimi", "pi", "local", "unlisted", "user"]) {
      expect(() => requireConductor(peer, { claude: ["conductor"] })).toThrow("explicit conductor");
    }
    requireConductor("claude", { claude: ["conductor"] }, {}, true);
    expect(() => requireConductor("claude", { claude: ["conductor"] }, { claude: [] }, true)).toThrow("assign capability");
    requireConductor("claude", { claude: ["conductor"] }, { claude: ["assign"] }, true);
    expect(() => requireConductor("claude", { claude: [] })).toThrow();
    expect(TASK_TOOL_NAMES.has("hub_status")).toBe(false);
    expect(CONDUCTOR_TOOL_NAMES.has("hub_status")).toBe(true);
  });

  test("headless starts have a closed allowlist; TUIs only preview", () => {
    for (const peer of ["local", "kimi", "pi"] as const) expect(conductorStart(peer, undefined, () => "unused")).toEqual({ peer, mode: "headless" });
    for (const peer of ["claude", "codex", "pi"] as const) expect(conductorStart(peer, "tui", (id) => `ahub ${id}`)).toEqual({ peer, mode: "tui", command: `ahub ${peer}` });
    expect(conductorStart("codex", "headless", () => "ahub codex").mode).toBe("tui");
    expect(() => conductorStart("kimi", "tui", () => "no")).toThrow();
    expect(() => conductorStart("other", undefined, () => "no")).toThrow();
  });
});

test("conductor holds survive restart and never transfer ownership", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-conductor-"));
  const path = join(dir, "hub.db");
  let holds = new ConductorHolds(path, () => 123);
  try {
    expect(holds.hold("pi", "claude")).toEqual({ peer: "pi", actor: "claude", since: 123 });
    holds.close();
    holds = new ConductorHolds(path);
    expect(holds.has("pi")).toBe(true);
    expect(() => holds.release("pi", "codex")).toThrow("only");
    expect(() => holds.hold("pi", "codex")).toThrow("another conductor");
    // A manual/budget hold has no conductor-owned row and cannot be released here.
    expect(() => holds.release("kimi", "claude")).toThrow("only");
    holds.release("pi", "claude");
    expect(holds.list()).toEqual([]);
  } finally { holds.close(); rmSync(dir, { recursive: true, force: true }); }
});

const task = (): Task => ({ id: 12, title: "secret title", detail: "secret body", class: "implement", owner: "pi", reviewer: "codex", state: "in_progress", refs: { paths: ["secret-path"] }, plan: { paths: ["secret-plan"] }, signals: [], rejections: 0, history: [{ at: 1, by: "claude", event: "proposed", note: "secret history" }], created: 1, updated: 1 });

test("public status strips request text, queues, budget summaries and preserves unknown", () => {
  const raw = {
    peers: [{ peer: "pi", budgetPause: { since: 1, resetsAt: 200, summary: "SECRET" }, queue: [{ body: "SECRET" }] }],
    taskCounts: { in_progress: 1 }, approvals: [{ peer: "pi", tool: "bash", at: 10, title: "SECRET", body: "SECRET" }],
  };
  const result = publicConductorStatus(raw, 110);
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(result.approvals).toEqual([{ peer: "pi", tool: "bash", ageMs: 100 }]);
  const peers = result.peers as Record<string, unknown>[];
  expect(peers[0]!.queued).toBeNull();
  expect(peers[0]!.windows).toBeNull();
});

test("task show delegates PII policy and removes all private history/refs", () => {
  const result = publicConductorTask(task(), () => ({ title: "[pii]", detail: "[pii]" }));
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(result.history).toEqual([]);
  expect(publicConductorTask(task(), (t) => ({ ...t, history: [] })).history).toEqual(task().history);
});

test("controller binds mutations to actor, public results and ids-only audit", async () => {
  const holds = new ConductorHolds(":memory:");
  const events: ConductEvent[] = [];
  const started: string[] = [];
  const resumed: string[] = [];
  let roles = { claude: ["conductor"] };
  const hooks: ConductorHooks = {
    roles: () => roles, capabilities: () => ({}), status: () => ({ peers: [], taskCounts: {}, approvals: [] }),
    task: () => task(), publicView: () => ({ title: "[pii]" }),
    assign: async (actor, id, peer) => { expect([actor, id, peer]).toEqual(["claude", 12, "pi"]); return task(); },
    escalate: async () => task(), preview: (peer) => `ahub ${peer}`,
    start: async (peer) => { started.push(peer); }, known: () => true, pause: () => {},
    release: (peer) => { resumed.push(peer); }, audit: (event) => { events.push(event); },
  };
  const conductor = new Conductor(holds, hooks);
  try {
    for (const peer of ["codex", "kimi", "pi", "local", "unlisted"]) for (const name of CONDUCTOR_TOOL_NAMES) {
      await expect(conductor.execute(peer, name, {})).rejects.toThrow("explicit conductor");
    }
    const result = await conductor.execute("claude", "hub_task_assign", { id: 12, peer: "pi" });
    expect(JSON.stringify(result)).not.toContain("secret");
    await conductor.execute("claude", "hub_peer_start", { peer: "codex" });
    expect(started).toEqual([]);
    await conductor.execute("claude", "hub_peer_start", { peer: "pi" });
    expect(started).toEqual(["pi"]);
    await expect(conductor.execute("claude", "hub_peer_release", { peer: "local" })).rejects.toThrow("only");
    expect(resumed).toEqual([]);
    await conductor.execute("claude", "hub_peer_hold", { peer: "local" });
    await conductor.execute("claude", "hub_peer_release", { peer: "local" });
    expect(resumed).toEqual(["local"]);
    expect(events[0]).toEqual({ kind: "conduct", actor: "claude", action: "task_assign", task: 12, peer: "pi" });
    expect(JSON.stringify(events)).not.toContain("secret");
    roles = { claude: [] };
    await expect(conductor.execute("claude", "hub_status", {})).rejects.toThrow("explicit conductor");
  } finally { holds.close(); }
});
