import { afterEach, expect, test } from "bun:test";
import { Conductor, ConductorHolds, conductorStart, type ConductorHooks } from "../src/hub/conductor.ts";
import type { KindMap } from "../src/adapters/registry.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const instances: KindMap = { "codex-a": { kind: "codex" }, "codex-b": { kind: "codex" } };
function fixture(overrides: Partial<ConductorHooks & { instances: () => KindMap }> = {}) {
  const holds = new ConductorHolds(":memory:"); cleanup.push(() => holds.close());
  const started: string[] = [], previews: string[] = [], audits: unknown[] = [];
  const hooks: ConductorHooks & { instances: () => KindMap } = {
    instances: () => instances, roles: () => ({ claude: ["conductor"] }), capabilities: () => ({}), status: () => ({ peers: [], taskCounts: {}, approvals: [] }),
    task: () => undefined, publicView: () => ({}), assign: async () => {}, escalate: async () => {},
    preview: peer => { previews.push(peer); return `ahub ${peer}`; }, startMode: () => "headless", start: async peer => { started.push(peer); return { ok: true }; },
    known: peer => peer === "codex-a" || peer === "codex-b", pause: () => {}, release: () => {}, audit: event => { audits.push(event); }, ...overrides,
  };
  return { conductor: new Conductor(holds, hooks), started, previews, audits };
}

test("I2 conductor starts only the exact declared headless instance and audits its instance id", async () => {
  const f = fixture();
  expect(await f.conductor.execute("claude", "hub_peer_start", { peer: "codex-b" })).toEqual({ peer: "codex-b", mode: "headless" });
  expect(f.started).toEqual(["codex-b"]); expect(f.previews).toEqual([]);
  expect(f.audits).toEqual([{ kind: "conduct", actor: "claude", action: "peer_start", peer: "codex-b" }]);
});

test("I2 instance start retains role-first authority and forbids choosing a TUI or new-session mode", async () => {
  const f = fixture();
  await expect(f.conductor.execute("codex-a", "hub_peer_start", { peer: "codex-b" })).rejects.toThrow("explicit conductor role");
  await expect(f.conductor.execute("claude", "hub_peer_start", { peer: "codex-b", mode: "tui" })).rejects.toThrow("starts headless here");
  await expect(f.conductor.execute("claude", "hub_peer_start", { peer: "codex-b", mode: "new-session" })).rejects.toThrow("mode must be headless or tui");
  expect(f.started).toEqual([]); expect(f.previews).toEqual([]); expect(f.audits).toEqual([]);
  const configuredTui = fixture({ startMode: () => "tui" });
  await expect(configuredTui.conductor.execute("claude", "hub_peer_start", { peer: "codex-a" })).rejects.toThrow("headless");
  expect(configuredTui.started).toEqual([]); expect(configuredTui.previews).toEqual([]);
});

test("I2 conductor does not infer suffixes, bypass known admission or start unsupported channel-only instances", async () => {
  const f = fixture();
  await expect(f.conductor.execute("claude", "hub_peer_start", { peer: "codex-ghost" })).rejects.toThrow();
  const unknown = fixture({ known: () => false });
  await expect(unknown.conductor.execute("claude", "hub_peer_start", { peer: "codex-a" })).rejects.toThrow("unknown peer");
  const channel = fixture({ instances: () => ({ "claude-a": { kind: "claude" } }), known: () => true });
  await expect(channel.conductor.execute("claude", "hub_peer_start", { peer: "claude-a" })).rejects.toThrow();
  expect(f.started).toEqual([]); expect(unknown.started).toEqual([]); expect(channel.started).toEqual([]);
});

test("I2 conductor without an instance map preserves legacy start output and mode refusal", () => {
  expect(conductorStart("codex", undefined, () => "unused", true, () => "headless")).toEqual({ peer: "codex", mode: "headless" });
  expect(conductorStart("codex", "tui", () => "ahub codex", true, () => "tui")).toEqual({ peer: "codex", mode: "tui", command: "ahub codex" });
  expect(() => conductorStart("codex", "headless", () => "unused", true, () => "tui")).toThrow("codex starts tui here; a person sets a start mode (ahub settings), the conductor cannot choose one");
});
