import { expect, test } from "bun:test";
import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { Conductor, ConductorHolds, conductorStart, type ConductorHooks } from "../src/hub/conductor.ts";

const catalog = () => createProjectAdapterCatalog({ fixture: { transport: "acp", command: "fixture-agent", args: ["stdio"], displayName: "Fixture ACP", roles: ["implementer"], identity: { name: "Fixture", version: "1" } } });
const instances = { "fixture-second": { kind: "fixture", start_mode: "headless" as const } };

test("configured conductor starts resolve only their captured project catalog", () => {
  const project = catalog();
  for (const id of ["fixture", "fixture-second"]) {
    expect(conductorStart(id, undefined, () => "unused", true, () => "headless", instances, project)).toEqual({ peer: id, mode: "headless" });
    expect(() => conductorStart(id, undefined, () => "unused", true, () => "headless", instances)).toThrow();
    expect(() => conductorStart(id, "tui", () => "unused", true, () => "headless", instances, project)).toThrow("conductor cannot choose");
  }
});

test("configured conductor dispatch preserves explicit role authority and exact instance membership", async () => {
  const project = catalog(), holds = new ConductorHolds(":memory:"), started: string[] = [];
  const hooks: ConductorHooks = {
    adapterCatalog: project, instances: () => instances,
    roles: () => ({ planner: ["conductor"] }), capabilities: () => ({}), status: () => ({ peers: [], taskCounts: {}, approvals: [] }),
    task: () => undefined, publicView: task => ({ ...task }), assign: async () => undefined, escalate: async () => undefined,
    preview: () => "unused", startMode: () => "headless", start: async peer => { started.push(peer); },
    known: peer => project.isSupportedPeer(peer, instances), pause: () => undefined, release: () => undefined, audit: () => undefined,
  };
  const conductor = new Conductor(holds, hooks);
  try {
    await expect(conductor.execute("outsider", "hub_peer_start", { peer: "fixture" })).rejects.toThrow("explicit conductor");
    expect(started).toEqual([]);
    await expect(conductor.execute("planner", "hub_peer_start", { peer: "fixture-third" })).rejects.toThrow();
    expect(started).toEqual([]);
    await conductor.execute("planner", "hub_peer_start", { peer: "fixture" });
    await conductor.execute("planner", "hub_peer_start", { peer: "fixture-second" });
    expect(started).toEqual(["fixture", "fixture-second"]);
  } finally { holds.close(); }
});
