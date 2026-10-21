import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_PLAN_KEYS, Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { profileTaskTools } from "../src/hub/hub-tools.ts";
import { PROFILE_NAMES, resolveProfile, type ProfileSelection } from "../src/hub/profiles.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver() {}
}
async function rig(profile: ProfileSelection = "dev") {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-plan-fields-"));
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  for (const id of ["claude", "codex"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", profile: typeof profile === "string" ? profile : "dev",
    ...(typeof profile === "object" ? { profileData: profile } : {}), roles: { claude: ["planner", "reviewer"], codex: ["implementer"] }, routing: () => loadRouting(cwd), notify: () => {} });
  return { tasks, board };
}
const custom = () => resolveProfile("dev", { plan_keys: ["paths", "symbols"] });
for (const profile of [...PROFILE_NAMES, custom()] as ProfileSelection[]) {
  const label = typeof profile === "string" ? profile : "custom";
  test(`#481 S2 proof and risks survive propose/accept normalization in ${label}`, async () => {
    const { tasks, board } = await rig(profile);
    const task = await tasks.propose("codex", { title: "bounded plan", class: "implement", owner: "codex",
      plan: { paths: ["src/example.ts"], proof: ["  test/example.test.ts\n focused-check  "], risks: ["  compatibility\n risk  "] } as any });
    expect(task.plan).toMatchObject({ paths: ["src/example.ts"], proof: ["test/example.test.ts focused-check"], risks: ["compatibility risk"] });
    tasks.accept("codex", task.id, { proof: ["x".repeat(512)], risks: ["y".repeat(512)] } as any);
    expect(board.get(task.id)?.plan).toMatchObject({ proof: ["x".repeat(512)], risks: ["y".repeat(512)] });
  });
  test(`#481 S2 every ${label} enabled plan schema advertises bounded proof and risks`, () => {
    const tools = profileTaskTools(profile, undefined, true);
    for (const name of ["hub_task_propose", "hub_task_accept", "hub_backlog_split"]) {
      const properties = tools.find(tool => tool.name === name)!.inputSchema.properties as any;
      const plan = name === "hub_backlog_split" ? properties.parts.items.properties.plan : properties.plan;
      for (const field of ["proof", "risks"]) expect(plan.properties[field]).toMatchObject({ type: "array", maxItems: 32, items: { type: "string", maxLength: 512 } });
    }
  });
}
for (const field of ["proof", "risks"] as const) {
  for (const [label, value] of [["too many", Array.from({ length: 33 }, () => "item")], ["too long", ["x".repeat(513)]]] as const) {
    test(`#481 S2 ${field} ${label} refuses propose and accept before writes`, async () => {
      const { tasks, board } = await rig();
      await expect(tasks.propose("codex", { title: "oversized plan", class: "implement", owner: "codex", plan: { [field]: value } as any })).rejects.toThrow();
      expect(board.list()).toEqual([]);
      const task = await tasks.propose("codex", { title: "valid plan", class: "implement", owner: "codex", plan: { [field]: Array.from({ length: 32 }, () => "item") } as any });
      expect((task.plan as Record<string, unknown>)[field]).toEqual(Array.from({ length: 32 }, () => "item"));
      const before = board.get(task.id);
      expect(() => tasks.accept("codex", task.id, { [field]: value } as any)).toThrow();
      expect(board.get(task.id)).toEqual(before);
    });
  }
}
test("#481 S2 plan text key projection includes proof and risks without removing legacy keys", () => {
  expect(ALL_PLAN_KEYS).toEqual(["paths", "symbols", "signatures", "insertion_points", "sections", "sources", "claims", "proof", "risks"]);
});
