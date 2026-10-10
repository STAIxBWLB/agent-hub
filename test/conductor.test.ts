import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conductor, ConductorHolds, conductorPeer, conductorProgressSink, conductorStart, publicConductorStatus, publicConductorTask, publicPeerBudget, requireConductor, type ConductEvent, type ConductorHooks } from "../src/hub/conductor.ts";
import { ProgressObserver } from "../src/hub/progress.ts";
import { SupervisionFeed, type SupervisionNotice } from "../src/hub/supervision.ts";
import type { HubEvent } from "../src/hub/events.ts";
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

  test("starts have a closed allowlist and take the peer's own start mode; a caller cannot choose one (#269)", () => {
    // What a person set: Pi and Codex headless here; Claude has only a TUI, Kimi and local only a headless form.
    const headless = (peer: string) => (peer === "claude" ? "tui" : "headless") as "tui" | "headless";
    const defaults = (peer: string) => (["claude", "codex", "pi"].includes(peer) ? "tui" : "headless") as "tui" | "headless";
    for (const peer of ["local", "kimi", "pi", "codex"] as const) expect(conductorStart(peer, undefined, () => "unused", false, headless)).toEqual({ peer, mode: "headless" });
    for (const peer of ["claude", "codex", "pi"] as const) expect(conductorStart(peer, "tui", (id) => `ahub ${id}`, false, defaults)).toEqual({ peer, mode: "tui", command: `ahub ${peer}` });
    for (const peer of ["claude", "codex", "pi"] as const) expect(conductorStart(peer, undefined, (id) => `ahub ${id}`, false, defaults).mode).toBe("tui");
    // A mode that is not the peer's own is refused, not followed and not silently replaced.
    expect(() => conductorStart("codex", "headless", () => "ahub codex", false, defaults)).toThrow("the conductor cannot choose one");
    expect(() => conductorStart("pi", "headless", () => "ahub pi", false, defaults)).toThrow("pi starts tui here");
    expect(() => conductorStart("pi", "tui", () => "ahub pi", false, headless)).toThrow("pi starts headless here");
    expect(() => conductorStart("kimi", "tui", () => "no", false, defaults)).toThrow();
    expect(() => conductorStart("other", undefined, () => "no", false, defaults)).toThrow("only claude, codex, kimi, pi and local");
    expect(() => conductorStart("pi", "window", () => "no", true, defaults)).toThrow("mode must be headless or tui");
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
  expect(publicConductorTask(task(), (t) => ({ ...t, history: t.history })).history).toEqual(task().history);
  expect(publicConductorTask(task(), (t) => ({ ...t, history: [] })).history).toEqual([]);
});

test("production progress sink forwards actual structured stuck verdicts to the supervision feed", async () => {
  const current = { ...task(), title: "ordinary parser task", owner: "codex", history: [] };
  const notices: SupervisionNotice[] = [], events: HubEvent[] = [];
  const feed = new SupervisionFeed({ conductor: () => "claude", scope: () => "all", tasks: () => [current], publicTitle: t => `#${t.id} ${t.title}`, isPrivate: () => false, emit: notice => { notices.push(notice); } });
  const observer = new ProgressObserver({ tasks: () => [current], isPrivate: () => false, inference: { escalate: async () => ({ escalate: true, category: "repetition", newEvidence: true, reason: "PRIVATE-REASON" }) }, emit: conductorProgressSink(event => events.push(event), feed), notify: () => {} });
  for (const turn of ["one", "two", "three"]) {
    observer.observe("codex", current.id, { name: "exec_command", command: "bun test", resultText: "AssertionError: PRIVATE-OUTPUT", isError: true, turn });
    await Bun.sleep(0);
  }
  expect(events.some(event => event.type === "stuck")).toBe(true);
  expect(notices.some(notice => notice.key.endsWith(":stuck") && notice.body.includes("reason repetition"))).toBe(true);
  expect(JSON.stringify(notices)).not.toContain("PRIVATE-");
});

test("readonly peer budget projection keeps quota measurements and excludes private pause data", () => {
  const projected = publicPeerBudget({ pi: { windows: [{ id: "5h", used: 0.25, at: 10, stale: false, source: "PRIVATE-SOURCE" }], paused: { since: 1, resetsAt: 200, reason: "PRIVATE-REASON", summary: "PRIVATE-SUMMARY", moved: ["PRIVATE-MOVED"] } as any } }, text => !text.includes("PRIVATE-"));
  expect(JSON.stringify(projected)).not.toContain("PRIVATE-");
  expect((projected.pi as any).windows[0].used).toBe(0.25);
  expect((projected.pi as any).paused).toEqual({ since: 1, resetsAt: 200, reason: "quota" });
});

test("a proposer's redirect needs assign capability to hand its task to another peer, and writes no conduct audit (#207)", async () => {
  const holds = new ConductorHolds(":memory:");
  const assigned: string[] = [];
  const events: ConductEvent[] = [];
  let caps: Record<string, unknown> = { claude: [] };
  const proposed = (): Task => ({ ...task(), state: "proposed" });
  const conductor = new Conductor(holds, {
    roles: () => ({ codex: ["conductor"] }), capabilities: () => caps, status: () => ({ peers: [], taskCounts: {}, approvals: [] }),
    task: proposed, publicView: (t) => ({ ...t }), assign: async (actor, id, peer) => { assigned.push(`${actor}:${id}:${peer}`); },
    escalate: async () => task(), preview: (peer) => `ahub ${peer}`, startMode: () => "headless", start: async () => {}, known: () => true, pause: () => {}, release: () => {},
    audit: (event) => { events.push(event); },
  });
  try {
    await expect(conductor.execute("claude", "hub_task_assign", { id: 12, peer: "kimi" })).rejects.toThrow("assign capability");
    await conductor.execute("claude", "hub_task_assign", { id: 12, peer: "claude" });
    caps = { claude: ["assign"] };
    await conductor.execute("claude", "hub_task_assign", { id: 12, peer: "kimi" });
    await expect(conductor.execute("kimi", "hub_task_assign", { id: 12, peer: "kimi" })).rejects.toThrow("explicit conductor");
    expect(assigned).toEqual(["claude:12:claude", "claude:12:kimi"]);
    expect(events).toEqual([]);
  } finally { holds.close(); }
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
    // #269: Codex keeps its TUI default here and Pi was set headless; the hook opens the terminal or starts the peer.
    startMode: (peer) => (peer === "codex" || peer === "claude" ? "tui" : "headless"),
    start: async (peer) => { started.push(peer); return peer === "codex" ? { ok: true, opened: "fake" } : { ok: true }; }, known: () => true, pause: () => {},
    release: (peer) => { resumed.push(peer); }, audit: (event) => { events.push(event); },
  };
  const conductor = new Conductor(holds, hooks);
  try {
    for (const peer of ["codex", "kimi", "pi", "local", "unlisted"]) for (const name of CONDUCTOR_TOOL_NAMES) {
      await expect(conductor.execute(peer, name, {})).rejects.toThrow("explicit conductor");
    }
    const result = await conductor.execute("claude", "hub_task_assign", { id: 12, peer: "pi" });
    expect(JSON.stringify(result)).not.toContain("secret");
    // A TUI peer: the hub opens its fixed command in a terminal and the answer names both.
    expect(await conductor.execute("claude", "hub_peer_start", { peer: "codex" })).toEqual({ peer: "codex", mode: "tui", command: "ahub codex", opened: "fake" });
    expect(started).toEqual(["codex"]);
    expect(await conductor.execute("claude", "hub_peer_start", { peer: "pi" })).toEqual({ peer: "pi", mode: "headless" });
    expect(started).toEqual(["codex", "pi"]);
    // The mode is a person's setting: asking for another one starts nothing.
    await expect(conductor.execute("claude", "hub_peer_start", { peer: "pi", mode: "tui" })).rejects.toThrow("the conductor cannot choose one");
    await expect(conductor.execute("claude", "hub_peer_start", { peer: "codex", mode: "headless" })).rejects.toThrow("the conductor cannot choose one");
    expect(started).toEqual(["codex", "pi"]);
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
