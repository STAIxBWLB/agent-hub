import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { parseRole, parseRoleDocument } from "../src/hub/roles.ts";
import { SHIPPED_ROLES } from "../src/hub/shipped-roles.ts";
import { guidanceVariantKey, type GuidanceVariantPayloadV1, type GuidanceVariantV1 } from "../src/hub/guidance-variants.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { taskExecutionReference, executionReferenceDigest } from "../src/hub/execution-links.ts";
import type { ExecutionReferenceV1 } from "../src/hub/execution-reference.ts";
import vectors from "./fixtures/guidance-variant-v1.json";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver() {} }
async function fixture(shipped = false) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-guidance-privacy-")), board = new Board(join(cwd, "hub.db"));
  const roster = new Set(["codex", "claude", "kimi"]), bus = new Bus({ batchMs: 0, rostered: peer => roster.has(peer) });
  clean.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  for (const id of roster) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const baselineBytes = shipped ? SHIPPED_ROLES["test-engineer"]! : vectors.baseline;
  const layer = shipped ? "shipped" as const : "project" as const;
  const role = parseRole(baselineBytes, "test-engineer", layer), catalog = { roles: new Map([[role.id, role]]), errors: [] };
  const task = board.propose(USER, { title: "Task privacy fixture", class: shipped ? "test" : "implement", role: role.id });
  board.update(task.id, USER, "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
  const roles: Record<string, string[]> = { codex: ["implementer"], claude: ["reviewer"], kimi: ["implementer"] };
  const policy: { private: boolean; review: boolean; patterns: string[]; piiPaths: string[]; deny: string[]; screening: boolean; screenCalls: number; resolverCalls: number; screen?: () => Promise<void> } = {
    private: false, review: false, patterns: [], piiPaths: [], deny: [], screening: false, screenCalls: 0, resolverCalls: 0,
  };
  const routing = loadRouting(cwd), projectKey = "guidance-privacy-fixture", messages: string[] = [], published: Envelope[] = [];
  const publish = bus.publish.bind(bus); bus.publish = env => { published.push(env); return publish(env); };
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles, catalog,
    notify: text => messages.push(text), share: (_peer, text) => messages.push(text), tell: (_peer, text) => messages.push(text),
    piiPaths: policy.piiPaths, deny: policy.deny,
    routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: policy.screening ? "local" : "off", pii_patterns: policy.patterns }, constraints: { ...routing.constraints, pii: "local_only" } }),
    privateTurn: () => policy.private, reviewObserverInput: () => policy.review,
    piiScreen: async () => { policy.screenCalls++; await policy.screen?.(); return { label: "clear", ms: 0 }; },
    executionLineage: { projectKey, cursorKey: "guidance-privacy-cursor-key-000001", readDelivery: () => { policy.resolverCalls++; return undefined; } },
  });
  const input = (author = "codex", evidenceRefs?: readonly ExecutionReferenceV1[]): GuidanceVariantV1 => {
    const current = board.get(task.id)!, { id: _id, ...golden } = vectors.golden.record;
    const scope = parseRoleDocument(baselineBytes, role.id, layer).sections.find(section => section.name === "Scope")!;
    const candidateBytes = baselineBytes.slice(0, scope.contentStartUtf16) + "\nCheck observable behavior.\n\n" + baselineBytes.slice(scope.endUtf16);
    const value: GuidanceVariantPayloadV1 = {
      ...golden, v: 1, baseline: { roleId: role.id, layer, sha256: role.hash, bytes: baselineBytes },
      candidate: { sha256: createHash("sha256").update(candidateBytes).digest("hex"), bytes: candidateBytes },
      projectKey, experimentId: "experiment-a",
      taskId: current.id, taskCreated: current.created, flowRevision: current.history.length, author,
      rationale: { problemHypothesis: "Private canary evidence names private/canary.", expectedObservableDifference: "Reports name the result." },
      evidenceRefs: evidenceRefs ?? [taskExecutionReference(projectKey, current.id, current.created)],
    };
    return { ...value, id: guidanceVariantKey(value) };
  };
  const selector = (value: GuidanceVariantV1) => ({ taskId: value.taskId, taskCreated: value.taskCreated, experimentId: value.experimentId, id: value.id });
  const withdraw = (value: GuidanceVariantV1) => ({ ...selector(value), flowRevision: board.get(task.id)!.history.length });
  return { cwd, board, bus, tasks, task, roles, roster, policy, projectKey, input, selector, withdraw, messages, published };
}

for (const gate of ["private", "review", "pii", "pii_path"] as const) test(`every actor is refused in ${gate} context, without declaration or withdrawal changes`, async () => {
  const f = await fixture(), existing = f.input(); await f.tasks.guidanceVariantCreate("codex", existing);
  const integrity = f.board.guidanceVariantsIntegrity();
  if (gate === "private" || gate === "review") f.policy[gate] = true;
  else f.board.update(f.task.id, USER, "note", { signals: [gate] });
  for (const actor of ["codex", USER]) {
    await expect(f.tasks.guidanceVariantCreate(actor, f.input(actor))).rejects.toBeInstanceOf(PreEffectToolRefusal);
    await expect(f.tasks.guidanceVariantWithdraw(actor, f.withdraw(existing))).rejects.toBeInstanceOf(PreEffectToolRefusal);
    expect(f.tasks.guidanceVariantRead(actor, f.selector(existing))).toEqual({ state: "unavailable" });
    expect(f.tasks.guidanceVariantApplicable(actor, f.selector(existing))).toBe(false);
  }
  expect(f.board.guidanceVariantsIntegrity()).toEqual(integrity);
});

test("missing, denied and hidden reads have one neutral shape and reveal no record ids or counts", async () => {
  const f = await fixture(), input = f.input(); await f.tasks.guidanceVariantCreate("codex", input);
  const selector = f.selector(input);
  for (const actor of ["kimi", "hub", "admin", "", "peer@room", "invalid actor"]) {
    for (const taskId of [input.taskId, 999999]) {
      const result = f.tasks.guidanceVariantRead(actor, { ...selector, taskId });
      expect(result).toEqual({ state: "unavailable" }); expect(JSON.stringify(result)).not.toContain(input.id);
    }
  }
  expect(f.tasks.guidanceVariantRead("codex", { ...selector, taskCreated: input.taskCreated + 1 })).toEqual({ state: "unavailable" });
  let taskReads = 0, storageReads = 0;
  const get = f.board.get.bind(f.board), variants = f.board.guidanceVariants.bind(f.board);
  f.board.get = id => { taskReads++; return get(id); };
  f.board.guidanceVariants = (...args) => { storageReads++; return variants(...args); };
  expect(f.tasks.guidanceVariantRead("admin", selector)).toEqual({ state: "unavailable" });
  expect(taskReads).toBe(0); expect(storageReads).toBe(0);
  f.policy.private = true;
  expect(f.tasks.guidanceVariantRead(USER, selector)).toEqual({ state: "unavailable" });
  expect(taskReads).toBe(0); expect(storageReads).toBe(0);
});

for (const change of ["pattern", "path-policy", "deny-policy", "task-pii"] as const) test(`stored public declaration screens current rationale after ${change}`, async () => {
  const f = await fixture(), input = f.input(); await f.tasks.guidanceVariantCreate("codex", input);
  const before = f.board.guidanceVariantsIntegrity();
  expect(f.tasks.guidanceVariantRead("codex", f.selector(input)).state).toBe("available");
  // The stored rationale contains a path-shaped string. Once a path policy is
  // active, a pure read cannot prove its alias without filesystem discovery;
  // conservatively withhold only the rationale field with unknown path proof.
  if (change === "pattern") f.policy.patterns.push("Private canary");
  else if (change === "path-policy") f.policy.piiPaths.push("private/**");
  else if (change === "deny-policy") f.policy.deny.push("secrets");
  else f.board.update(f.task.id, USER, "note", { signals: ["pii"] });
  for (const actor of ["codex", USER]) {
    const read = f.tasks.guidanceVariantRead(actor, f.selector(input));
    if (change === "task-pii") {
      expect(read).toEqual({ state: "unavailable" });
      expect(f.tasks.guidanceVariantApplicable(actor, f.selector(input))).toBe(false);
    } else {
      if (read.state !== "available") throw new Error("safe declaration metadata must remain available");
      expect(read.records[0]!.rationale.problemHypothesis).toBe("withheld");
      expect(read.records[0]!.rationale.expectedObservableDifference).toBe(input.rationale.expectedObservableDifference);
      expect(read.records[0]!.applicable).toBe(true);
      expect(f.tasks.guidanceVariantApplicable(actor, f.selector(input))).toBe(true);
    }
  }
  expect(f.board.guidanceVariantsIntegrity()).toEqual(before);
  expect(f.messages).toEqual([]); expect(f.published).toEqual([]);
});

test("evidence status is a scoped declaration lookup and foreign opaque addresses remain unavailable", async () => {
  const f = await fixture();
  const known = taskExecutionReference(f.projectKey, f.task.id, f.task.created);
  const foreign: ExecutionReferenceV1 = { v: 1, tool: "ares", projectKey: "foreign-project", kind: "claim", id: "/never/resolve/this", revision: "1" };
  const input = f.input("codex", [known, foreign]); await f.tasks.guidanceVariantCreate("codex", input);
  f.policy.screening = true;
  f.policy.screen = async () => { throw new Error("read must not call a model screen"); };
  f.tasks.publicMetadataText = () => { throw new Error("read must not discover paths"); };
  const read = f.tasks.guidanceVariantRead("codex", f.selector(input));
  if (read.state !== "available") throw new Error("public opaque addresses should remain readable metadata");
  expect(read.records[0]!.evidence).toEqual([{ key: executionReferenceDigest(known), status: "declared" }, { key: executionReferenceDigest(foreign), status: "unavailable" }]);
  expect(JSON.stringify(read)).not.toContain(foreign.id);
  expect(JSON.stringify(read)).not.toContain(input.baseline.bytes);
  expect(JSON.stringify(read)).not.toContain(input.candidate.bytes);
  expect(f.tasks.guidanceVariantApplicable("codex", f.selector(input))).toBe(true);
  expect(f.policy.screenCalls).toBe(0); expect(f.policy.resolverCalls).toBe(0);
});

test("declaration bodies stay out of task views, history, bus messages and observer notices", async () => {
  const f = await fixture(), input = f.input(), original = f.board.get(f.task.id)!;
  const before = f.tasks.publicView(original), plan = original.plan, refs = original.refs, history = original.history;
  await f.tasks.guidanceVariantCreate("codex", input);
  await f.tasks.guidanceVariantWithdraw("codex", f.withdraw(input));
  const after = f.board.get(f.task.id)!;
  expect(after).toEqual(original); expect(after.plan).toEqual(plan); expect(after.refs).toEqual(refs); expect(after.history).toEqual(history);
  expect(f.tasks.publicView(after)).toEqual(before);
  expect(JSON.stringify(f.tasks.publicView(after))).not.toContain(input.rationale.problemHypothesis);
  expect(f.messages).toEqual([]); expect(f.published).toEqual([]);
});

test("current admission is checked on replay and former owners lose access to stored declarations", async () => {
  const f = await fixture(), input = f.input(); await f.tasks.guidanceVariantCreate("codex", input);
  const before = f.board.guidanceVariantsIntegrity();
  f.board.update(f.task.id, USER, "assigned", { owner: "kimi" });
  await expect(f.tasks.guidanceVariantCreate("codex", input)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.tasks.guidanceVariantRead("codex", f.selector(input))).toEqual({ state: "unavailable" });
  const currentOwner = f.tasks.guidanceVariantRead("kimi", f.selector(input));
  expect(currentOwner.state).toBe("available");
  expect(f.tasks.guidanceVariantApplicable("kimi", f.selector(input))).toBe(false);
  f.policy.private = true;
  await expect(f.tasks.guidanceVariantWithdraw("kimi", f.withdraw(input))).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.guidanceVariantsIntegrity()).toEqual(before);
});

for (const operation of ["read", "applicable"] as const) for (const change of ["withdrawal", "revision", "private", "pattern"] as const)
  test(`${operation} rechecks ${change} after a scoped lineage source callback`, async () => {
    const f = await fixture(), input = f.input(); await f.tasks.guidanceVariantCreate("codex", input);
    const links = f.board.executionReferences.bind(f.board); let changed = false, withdrawal: Promise<unknown> | undefined;
    f.board.executionReferences = (...args) => {
      const result = links(...args);
      if (!changed) {
        changed = true;
        if (change === "withdrawal") withdrawal = f.tasks.guidanceVariantWithdraw(USER, f.withdraw(input));
        else if (change === "revision") f.board.update(f.task.id, USER, "note", {}, "Concurrent task revision");
        else if (change === "private") f.policy.private = true;
        else f.policy.patterns.push("Private canary");
      }
      return result;
    };
    const result = operation === "read" ? f.tasks.guidanceVariantRead("codex", f.selector(input)) : f.tasks.guidanceVariantApplicable("codex", f.selector(input));
    await withdrawal;
    expect(changed).toBe(true); // The fixture must reach the real source-port read, not an earlier refusal.
    if (change === "pattern") {
      if (operation === "read") {
        const read = result as ReturnType<Tasks["guidanceVariantRead"]>;
        if (read.state !== "available") throw new Error("rationale privacy does not hide safe metadata");
        expect(read.records[0]!.rationale.problemHypothesis).toBe("withheld"); expect(read.records[0]!.applicable).toBe(true);
      } else expect(result).toBe(true);
    } else if (operation === "read") expect(result).toEqual({ state: "unavailable" }); else expect(result).toBe(false);
    if (change === "withdrawal") expect(f.board.guidanceVariants(f.projectKey, f.task.id, f.task.created, input.experimentId)[0]!.withdrawn?.by).toBe(USER);
    expect(f.messages).toEqual([]); expect(f.published).toEqual([]);
  });

test("real shipped attribution paths and unrelated deny policy preserve safe declaration metadata", async () => {
  const f = await fixture(true);
  f.policy.deny.push("secrets/**");
  const foreign: ExecutionReferenceV1 = { v: 1, tool: "ares", projectKey: "foreign-project", kind: "claim", id: "opaque-address-canary", revision: "1" };
  const known = taskExecutionReference(f.projectKey, f.task.id, f.task.created);
  const input = f.input("codex", [known, foreign]);
  expect(input.baseline.bytes).toBe(SHIPPED_ROLES["test-engineer"]!);
  const original = parseRoleDocument(input.baseline.bytes, input.baseline.roleId, input.baseline.layer);
  const candidate = parseRoleDocument(input.candidate.bytes, input.baseline.roleId, input.baseline.layer);
  expect(original.role.source).toContain("adapted from agency-agents ");
  expect(original.role.source).toContain("testing/testing-test-automation-engineer.md");
  expect(candidate.rawHeader).toBe(original.rawHeader);
  expect(candidate.bodyPrefix).toBe(original.bodyPrefix);
  for (let index = 0; index < original.sections.length; index++) {
    expect(candidate.sections[index]!.headingRaw).toBe(original.sections[index]!.headingRaw);
    if (original.sections[index]!.name !== "Scope") expect(candidate.sections[index]!.raw).toBe(original.sections[index]!.raw);
  }
  await f.tasks.guidanceVariantCreate("codex", input);
  const read = f.tasks.guidanceVariantRead("codex", f.selector(input));
  if (read.state !== "available") throw new Error("unrelated deny policy must not hide safe shipped-role metadata");
  expect(read.records[0]!.roleId).toBe("test-engineer"); expect(read.records[0]!.layer).toBe("shipped");
  expect(read.records[0]!.changedSections).toEqual(["Scope"]);
  expect(read.records[0]!.applicable).toBe(true); expect(f.tasks.guidanceVariantApplicable("codex", f.selector(input))).toBe(true);
  expect(read.records[0]!.rationale.problemHypothesis).toBe("withheld");
  expect(read.records[0]!.evidence).toEqual([{ key: executionReferenceDigest(known), status: "declared" }, { key: executionReferenceDigest(foreign), status: "unavailable" }]);
  const publicJson = JSON.stringify(read);
  for (const text of [input.baseline.bytes, input.candidate.bytes, original.rawHeader, original.role.body])
    expect(publicJson).not.toContain(JSON.stringify(text).slice(1, -1));
  expect(publicJson).not.toContain(original.role.source); expect(publicJson).not.toContain("agency-agents");
  expect(publicJson).not.toContain(foreign.id); expect(publicJson).not.toContain(known.id);
  for (const field of ["variant", "baseline", "candidate", "createdBy", "createdAt", "withdrawn"])
    expect(Object.hasOwn(read.records[0]!, field)).toBe(false);
  expect(f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)[0]!.variant).toEqual(input);
});

test("withheld historical rationale cannot block an authorized withdrawal of the stored declaration", async () => {
  const f = await fixture(), input = f.input(); await f.tasks.guidanceVariantCreate("codex", input);
  const original = f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)[0]!;
  f.policy.patterns.push("Private canary");
  const read = f.tasks.guidanceVariantRead("codex", f.selector(input));
  if (read.state !== "available") throw new Error("rationale-only narrowing preserves safe metadata");
  expect(read.records[0]!.rationale.problemHypothesis).toBe("withheld");
  const receipt = await f.tasks.guidanceVariantWithdraw("codex", f.withdraw(input));
  expect(receipt).toEqual({ id: input.id, taskId: input.taskId, experimentId: input.experimentId, status: "withdrawn", already: false });
  expect(JSON.stringify(receipt)).not.toContain(input.rationale.problemHypothesis);
  expect(JSON.stringify(receipt)).not.toContain("baseline"); expect(JSON.stringify(receipt)).not.toContain("candidate");
  const stored = f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)[0]!;
  expect(stored.variant).toEqual(original.variant); expect(stored.createdBy).toBe(original.createdBy); expect(stored.createdAt).toBe(original.createdAt);
  expect(stored.withdrawn?.by).toBe("codex"); expect(stored.withdrawn!.at).toBeGreaterThanOrEqual(original.createdAt);
  const after = f.tasks.guidanceVariantRead("codex", f.selector(input));
  if (after.state !== "available") throw new Error("withdrawn safe metadata remains readable");
  expect(after.records[0]!.status).toBe("withdrawn"); expect(after.records[0]!.applicable).toBe(false);
  expect(after.records[0]!.rationale.problemHypothesis).toBe("withheld");
});

for (const narrowing of ["path-policy", "pattern"] as const) test(`an experiment id made private by ${narrowing} is field-withheld without rebasing or blocking withdrawal`, async () => {
  const f = await fixture(), { id: _id, ...original } = f.input();
  const payload = { ...original, experimentId: "private/client.csv" }, input = { ...payload, id: guidanceVariantKey(payload) };
  const first = await f.tasks.guidanceVariantCreate("codex", input);
  expect(first.experimentId).toBe(input.experimentId);
  const before = f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)[0]!;
  if (narrowing === "path-policy") f.policy.piiPaths.push("private/**"); else f.policy.patterns.push("private/client[.]csv");
  const read = f.tasks.guidanceVariantRead("codex", f.selector(input));
  if (read.state !== "available") throw new Error("experiment field privacy must not hide safe variant metadata");
  expect(read.records[0]!.experimentId).toBe("withheld"); expect(read.records[0]!.id).toBe(input.id);
  expect(read.records[0]!.applicable).toBe(true); expect(f.tasks.guidanceVariantApplicable("codex", f.selector(input))).toBe(true);
  expect(JSON.stringify(read)).not.toContain(input.experimentId);
  const receipt = await f.tasks.guidanceVariantWithdraw("codex", f.withdraw(input));
  expect(receipt.experimentId).toBe("withheld"); expect(receipt.status).toBe("withdrawn"); expect(receipt.already).toBe(false);
  expect(JSON.stringify(receipt)).not.toContain(input.experimentId);
  const stored = f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)[0]!;
  expect(stored.variant).toEqual(before.variant); expect(stored.variant.experimentId).toBe("private/client.csv"); expect(stored.withdrawn?.by).toBe("codex");
});

test("a create receipt also field-screens its opaque experiment id without exposing a new identity", async () => {
  const f = await fixture(), { id: _id, ...original } = f.input();
  const payload = { ...original, experimentId: "private/client.csv" }, input = { ...payload, id: guidanceVariantKey(payload) };
  f.policy.deny.push("secrets/**");
  const receipt = await f.tasks.guidanceVariantCreate("codex", input);
  expect(receipt.experimentId).toBe("withheld"); expect(receipt.id).toBe(input.id); expect(receipt.status).toBe("declared");
  expect(JSON.stringify(receipt)).not.toContain(input.experimentId);
  const stored = f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)[0]!;
  expect(stored.variant).toEqual(input);
  const read = f.tasks.guidanceVariantRead("codex", f.selector(input));
  if (read.state !== "available") throw new Error("unrelated deny does not hide safe variant metadata");
  expect(read.records[0]!.experimentId).toBe("withheld"); expect(read.records[0]!.applicable).toBe(true);
});
