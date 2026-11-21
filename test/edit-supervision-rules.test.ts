import { expect, test } from "bun:test";
import { evaluateSupervision, ShadowSupervisor } from "../src/hub/supervision-rules.ts";

test("edit supervision reads only evidence for the current owner revision", () => {
  const tasks = [{ id: 1, state: "in_progress" as const, history: [{ at: 1, event: "accepted" }] }];
  const stale = { tasks, edits: [{ task: 1, revision: "0:none", unverified: 3, cascading: 3 }] };
  expect(evaluateSupervision(stale).observations).toEqual([]);
  const current = { tasks, edits: [{ task: 1, revision: "1:none", unverified: 2, cascading: 2 }] };
  const shadow = new ShadowSupervisor();
  expect(shadow.observe(current).map(item => item.rule)).toEqual(["cascading_edit_after_failed_check", "unverified_shell_write"]);
  expect(shadow.observe(current)).toEqual([]);
  expect(shadow.counts()).toMatchObject({ workerTurns: 0, actionWrites: 0, notifications: 0 });
});

test("failed-check evidence counts distinct later writes until a diagnostic read", async () => {
  const { EditEvidence } = await import("../src/hub/edit-guard.ts");
  const e = new EditEvidence(); e.check(1, "1:none", "failed");
  e.write(1, "1:none", "a", true); e.write(1, "1:none", "a", true);
  expect(e.snapshot(1, "1:none")).toEqual({ task: 1, revision: "1:none", unverified: 2, unknownShell: 0, cascading: 1 });
  e.write(1, "1:none", "b", false);
  expect(e.snapshot(1, "1:none")?.cascading).toBe(2);
  e.diagnosticRead(1, "1:none"); expect(e.snapshot(1, "1:none")?.cascading).toBe(0);
  expect(e.snapshot(1, "2:none")).toBeUndefined();
  e.close(1); expect(e.snapshot(1, "1:none")).toBeUndefined();
});

test("observed shell evidence counts only an actual changed target", async () => {
  const { Facts } = await import("../src/hub/facts.ts");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "edit-facts-"));
  try {
    const file = join(root, "a.txt"); writeFileSync(file, "before");
    const seen: string[] = [];
    const facts = new Facts({ root, tmp: join(root, "tmp"), instance: "fixture", scope: () => ({ paths: ["a.txt"], plans: [], task: { id: 1, title: "test" } }), peers: () => [], nameable: () => true,
      onEdit: (_peer, path, route) => seen.push(`${route}:${path}`) });
    const input = { command: "echo after > a.txt" };
    facts.preTool("local", "one", "Bash", input); facts.postTool("local", "one", "Bash", input);
    expect(seen).toEqual([]);
    facts.preTool("local", "two", "Bash", input); writeFileSync(file, "after"); facts.postTool("local", "two", "Bash", input);
    expect(seen).toEqual(["shell:a.txt"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("edit observations become advisory proposals without running a worker or an action", async () => {
  const { ProposalStore, SupervisionProposals } = await import("../src/hub/supervision-proposals.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "edit-proposals-"));
  const store = new ProposalStore(join(root, "hub.db")); let runs = 0;
  try {
    const facts = { tasks: [{ id: 1, state: "in_progress" as const, history: [{ at: 1, event: "accepted" }] }], edits: [{ task: 1, revision: "1:none", unverified: 2, cascading: 2 }] };
    const proposals = new SupervisionProposals(store, { facts: () => facts, isPrivate: () => false, generation: () => "local@one", mayDecide: () => true, mayRun: () => true, held: () => false, run: async () => { runs++; return { outcome: "ran" }; }, now: () => 1 });
    const added = await proposals.observe(1); expect(added.map(row => row.rule).sort()).toEqual(["cascading_edit_after_failed_check", "unverified_shell_write"]);
    expect((await proposals.read("local", 1)).length).toBe(2); expect(runs).toBe(0);
    expect((await proposals.observe(1)).length).toBe(0); expect(runs).toBe(0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("lost in-memory edit evidence does not falsely clear a pending proposal", async () => {
  const { ProposalStore, SupervisionProposals } = await import("../src/hub/supervision-proposals.ts");
  const { mkdtempSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "edit-unknown-")), store = new ProposalStore(join(root, "hub.db"));
  try {
    const tasks = [{ id: 1, state: "in_progress" as const, history: [{ at: 1, event: "accepted" }] }];
    let edits: { task: number; revision: string; unverified: number; cascading: number }[] | undefined = [{ task: 1, revision: "1:none", unverified: 2, cascading: 0 }];
    const proposals = new SupervisionProposals(store, { facts: () => ({ tasks, ...(edits ? { edits } : {}) }), isPrivate: () => false, generation: () => "local@one", mayDecide: () => true, mayRun: () => true, held: () => false, run: async () => ({ outcome: "ran" }), now: () => 1 });
    expect(await proposals.observe(1)).toHaveLength(1);
    edits = undefined; await proposals.observe(1); const pending = (await proposals.read("local", 1)).filter(row => row.state === "pending"); expect(pending).toHaveLength(1);
    expect((await proposals.decide("local", pending[0]!.id, "accept"))).toMatchObject({ ok: false, error: "edit evidence unavailable; the proposal stays pending" });
    edits = [{ task: 1, revision: "1:none", unverified: 0, cascading: 0 }]; await proposals.observe(1);
    expect((await proposals.read("local", 1)).find(row => row.rule === "unverified_shell_write")?.state).toBe("expired");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("clipped task history never certifies edit supervision coverage", () => {
  const history = [{ at: 1, event: "accepted" }, ...Array.from({ length: 70 }, (_, i) => ({ at: i + 2, event: "note" }))];
  const result = evaluateSupervision({ tasks: [{ id: 1, state: "in_progress", history }], edits: [{ task: 1, revision: "1:none", unverified: 2, cascading: 2 }] });
  expect(result.observations.filter(row => row.rule === "unverified_shell_write" || row.rule === "cascading_edit_after_failed_check")).toEqual([]);
  expect(result.gap.filter(row => row.rule === "unverified_shell_write" || row.rule === "cascading_edit_after_failed_check")).toHaveLength(2);
});

test("privacy becoming private during evidence read prevents edit proposals", async () => {
  const { ProposalStore, SupervisionProposals } = await import("../src/hub/supervision-proposals.ts");
  const { mkdtempSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "edit-private-")), store = new ProposalStore(join(root, "hub.db"));
  try {
    let privateTask = false;
    const proposals = new SupervisionProposals(store, { facts: async () => { privateTask = true; return { tasks: [{ id: 1, state: "in_progress" as const, history: [{ at: 1, event: "accepted" }] }], edits: [{ task: 1, revision: "1:none", unverified: 2, cascading: 0 }] }; }, isPrivate: () => privateTask, generation: () => "local@one", mayDecide: () => true, mayRun: () => true, held: () => false, run: async () => ({ outcome: "ran" }), now: () => 1 });
    expect(await proposals.observe(1)).toEqual([]); expect(store.pendingCount()).toBe(0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
