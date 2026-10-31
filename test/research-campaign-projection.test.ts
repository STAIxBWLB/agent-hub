import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Board, type ResearchCampaignRecord } from "../src/hub/board.ts";
import { USER } from "../src/hub/envelope.ts";
import { campaignHash, parseResearchHandoff, studyProjection, type ResearchCampaignContract, type ResearchHandoffV1, type ResearchProjectionInput } from "../src/hub/research-campaign.ts";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
const NOW = Date.UTC(2026, 10, 1), SOURCE = "src:0123456789abcdef", SOURCE2 = "src:fedcba9876543210";
const contract = (): ResearchCampaignContract => ({ question: "Synthetic question", scope: "Fixture only", exclusions: [], sourceIds: [SOURCE, SOURCE2],
  units: [
    { id: "discover", round: 0, question: "Inspect both sources", perspective: "measurement", requiredOutput: "Handoff", sourceIds: [SOURCE, SOURCE2], dependsOn: [], purpose: "discovery" },
    { id: "duplicate", round: 0, question: "Inspect one source", perspective: "measurement", requiredOutput: "Handoff", sourceIds: [SOURCE], dependsOn: [], purpose: "discovery" },
    { id: "independent", round: 0, question: "Check source independently", perspective: "independent", requiredOutput: "Handoff", sourceIds: [SOURCE], dependsOn: [], purpose: "independent_check" },
  ], deliverableSections: [], stopPolicy: { maxUnits: 4, maxFollowUpRounds: 1, deadline: new Date(NOW + 86400000).toISOString() } });
const handoff = (unitId = "discover", taskId = 2): ResearchHandoffV1 => ({ campaignId: "rc-0123456789ab", revision: 1, unitId, taskId,
  evidence: [{ sourceId: SOURCE, locator: "section 1" }], unresolved: [], contradictions: [], limitations: [] });
const projection = (): ResearchProjectionInput => ({ campaign: { id: "rc-0123456789ab", revision: 1, status: "approved", contract: contract() },
  bindings: [{ unitId: "discover", taskId: 2, round: 0 }, { unitId: "duplicate", taskId: 3, round: 0 }, { unitId: "independent", taskId: 4, round: 0 }],
  tasks: [{ id: 2, state: "approved", owner: "local" }, { id: 3, state: "in_progress", owner: "local" }, { id: 4, state: "in_progress", owner: "local" }], handoffs: [], now: NOW });

function fixture(hardCap = false) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-campaign-projection-"));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db");
  let board = new Board(file); clean.push(() => board.close());
  const parent = board.propose(USER, { title: "Synthetic parent", class: "implement" });
  const body = contract(); if (hardCap) body.budget = { id: "fixture-budget", hardCap: ["tool_calls"] };
  const draft: ResearchCampaignRecord = { id: "rc-0123456789ab", project: "fixture-project", parentTaskId: parent.id, revision: 1, status: "draft", contract: body,
    hash: campaignHash(body), private: false, createdBy: USER, createdAt: NOW };
  board.saveResearchCampaignDraft(draft, undefined, parent.history.length);
  const prepare = () => body.units.map(unit => ({ unitId: unit.id, create: { title: unit.question, class: "implement" as const, signals: [] } }));
  return { file, body, parent, draft, prepare, get board() { return board; }, restart() { board.close(); board = new Board(file); } };
}

test("handoff parsing reports every missing required field and refuses inert-data violations", () => {
  expect(() => parseResearchHandoff({ campaignId: "rc-0123456789ab" })).toThrow("revision, unitId, taskId, evidence, unresolved, contradictions, limitations");
  let read = false;
  const raw = { ...handoff(), get evidence() { read = true; return []; } };
  expect(() => parseResearchHandoff(raw)).toThrow("plain data object"); expect(read).toBe(false);
  expect(() => parseResearchHandoff({ ...handoff(), evidence: Array(1) })).toThrow("dense data list");
  expect(() => parseResearchHandoff({ ...handoff(), limitations: ["a".repeat(513)] })).toThrow("512");
  expect(() => parseResearchHandoff({ ...handoff(), taskId: 0 })).toThrow("integer");
});

test("coverage depends on handoff evidence, includes duplicate discoveries and labels independent checks distinctly", () => {
  const input = projection();
  expect(studyProjection(input).units[0]!.handoff).toMatchObject({ present: false, complete: false });
  input.handoffs = [{ handoff: handoff(), seq: 1, by: "local", at: NOW, private: false }];
  const result = studyProjection(input);
  expect(result.units[0]!.state).toBe("approved");
  expect(result.units[0]!.handoff).toMatchObject({ present: true, complete: false, coveredSourceIds: [SOURCE] });
  expect(result.units[0]!.duplicateSourceIds).toEqual([SOURCE]);
  expect(result.units[1]!.duplicateSourceIds).toEqual([SOURCE]);
  expect(result.units[2]!).toMatchObject({ intentionalIndependentCheck: true, duplicateSourceIds: [] });
  expect(result.discoveryRounds).toEqual([{ round: 0, complete: false }]);
  input.handoffs = [{ handoff: { ...handoff(), evidence: [...handoff().evidence, { sourceId: SOURCE2, locator: "section 2" }] }, seq: 2, by: "local", at: NOW, private: false },
    { handoff: { ...handoff("duplicate", 3), evidence: [], insufficientEvidence: "The fixture lacks evidence" }, seq: 1, by: "local", at: NOW, private: false }];
  expect(studyProjection(input).discoveryRounds).toEqual([{ round: 0, complete: true }]);
});

test("the stop projection uses supplied host time and stored binding rounds without changing the input", () => {
  const input = projection(), before = JSON.stringify(input);
  expect(studyProjection(input).held).toBe(false); expect(JSON.stringify(input)).toBe(before);
  input.now += 86400000; expect(studyProjection(input).reasons).toContain("campaign deadline has passed or is unknown");
  input.now = NOW; input.bindings = [{ unitId: "discover", taskId: 2, round: 2 }];
  expect(studyProjection(input).reasons).toContain("campaign follow-up limit exceeded");
  input.campaign.status = "draft"; expect(studyProjection(input).reasons).toContain("campaign approval is not current");
});

test("budget projection requires the named ledger, owner instrumentation, scope and configured limit", () => {
  const input = projection(); input.campaign.contract.budget = { id: "run-budget", hardCap: [] };
  input.instrumentedPeers = ["local"];
  input.budget = { id: "run-budget", kind: "run", peers: ["local"], limits: { tool_calls: 10 }, used: { tool_calls: 3 }, coveredTaskIds: [2, 3, 4] };
  let result = studyProjection(input);
  expect(result.sharedPeerLedger).toBe(true);
  expect(result.units[0]!.budget.tool_calls).toEqual({ support: "enforceable", used: 3, limit: 10 });
  expect(result.units[0]!.budget.model_calls.support).toBe("advisory");
  expect(result.units[0]!.budget.tokens.support).toBe("unavailable");
  input.budget.id = "another-budget"; expect(studyProjection(input).units[0]!.budget.tool_calls.support).toBe("unknown");
  input.budget.id = "run-budget"; input.budget.coveredTaskIds = [3]; expect(studyProjection(input).units[0]!.budget.tool_calls.support).toBe("advisory");
  input.budget.coveredTaskIds = [2]; input.budget.kind = "task"; input.budget.taskId = 3; expect(studyProjection(input).units[0]!.budget.tool_calls.support).toBe("advisory");
  input.tasks[0]!.owner = "codex"; expect(studyProjection(input).units[0]!.budget.tool_calls.support).toBe("unavailable");
  input.tasks[0]!.owner = null; result = studyProjection(input); expect(result.units[0]!.budget.tool_calls.support).toBe("unknown");
});

test("dispatch activation persists eligible owners and rejects malformed or absent hard-cap owners atomically", () => {
  const f = fixture(true), before = f.board.researchIntegrity(), flow = f.board.get(f.parent.id)!.history.length;
  expect(() => f.board.activateCampaign(f.draft.id, 1, "fixture-project", USER, NOW, f.prepare(), flow, false, {})).toThrow();
  expect(f.board.researchIntegrity()).toEqual(before);
  const approved = f.board.activateCampaign(f.draft.id, 1, "fixture-project", USER, NOW, f.prepare(), flow, false, { eligibleOwners: ["local"] });
  expect(approved.campaign).toMatchObject({ dispatchVersion: 1, eligibleOwners: ["local"] });
  const integrity = f.board.researchDispatchIntegrity(); expect(integrity.activations).toBe(1); expect(integrity.handoffs).toBe(0);
  f.restart(); expect(f.board.researchCampaign(f.draft.id)).toMatchObject({ dispatchVersion: 1, eligibleOwners: ["local"] });
  expect(f.board.researchDispatchIntegrity()).toEqual(integrity);
  const db = new Database(f.file); db.query("UPDATE research_dispatch SET eligible_owners=?").run('["local","local"]'); db.close();
  expect(() => f.board.researchCampaign(f.draft.id)).toThrow();
  expect(() => f.board.researchDispatchIntegrity()).toThrow();
});

test("handoff writes are append-only, flow- and owner-fenced, and retained task membership resolves the latest revision", () => {
  const f = fixture(), flow = f.board.get(f.parent.id)!.history.length;
  const approved = f.board.activateCampaign(f.draft.id, 1, "fixture-project", USER, NOW, f.prepare(), flow, false, {});
  const binding = approved.bindings.find(unit => unit.unitId === "discover")!;
  let task = f.board.update(binding.taskId, USER, "backlog pulled", { state: "proposed", owner: "local" });
  task = f.board.update(task.id, "local", "accepted", { state: "in_progress" });
  const input = { ...handoff("discover", task.id) };
  expect(() => f.board.recordResearchHandoff(input, "fixture-project", "codex", NOW, task.history.length)).toThrow();
  expect(() => f.board.recordResearchHandoff(input, "fixture-project", "local", NOW, task.history.length - 1)).toThrow();
  expect(f.board.researchDispatchIntegrity().handoffs).toBe(0);
  const first = f.board.recordResearchHandoff(input, "fixture-project", "local", NOW, task.history.length);
  const current = f.board.get(task.id)!;
  const second = f.board.recordResearchHandoff({ ...input, insufficientEvidence: "Additional data required" }, "fixture-project", "local", NOW + 1, current.history.length);
  expect(first.seq).toBe(1); expect(second.seq).toBe(2); expect(f.board.researchHandoffs(f.draft.id, 1)).toEqual([second]);
  expect(f.board.researchDispatchIntegrity().handoffs).toBe(2);
  const parent = f.board.get(f.parent.id)!;
  f.board.saveResearchCampaignDraft({ ...f.draft, revision: 2, createdAt: NOW + 2 }, 1, parent.history.length);
  expect(f.board.researchDispatchBinding(task.id)!.campaign.status).toBe("draft");
  expect(f.board.researchDispatchBinding(task.id)!.binding).toBeUndefined();
  expect(() => f.board.recordResearchHandoff(input, "fixture-project", "local", NOW + 3, f.board.get(task.id)!.history.length)).toThrow();
  const prepared = f.body.units.map(unit => ({ unitId: unit.id, reuse: { taskId: approved.bindings.find(value => value.unitId === unit.id)!.taskId,
    flowRevision: f.board.get(approved.bindings.find(value => value.unitId === unit.id)!.taskId)!.history.length } }));
  f.board.activateCampaign(f.draft.id, 2, "fixture-project", USER, NOW + 4, prepared, f.board.get(f.parent.id)!.history.length, false, {});
  expect(f.board.researchDispatchBinding(task.id)!.binding!.revision).toBe(2);
  expect(f.board.researchHandoffs(f.draft.id, 2)).toEqual([second]);
});

test("dispatch floor covers legacy campaigns too while base integrity remains stable for advisory dispatch metadata", () => {
  const f = fixture();
  expect(f.board.hasResearchDispatchState()).toBe(true);
  f.board.activateCampaign(f.draft.id, 1, "fixture-project", USER, NOW, f.prepare(), f.board.get(f.parent.id)!.history.length);
  expect(f.board.researchCampaign(f.draft.id)!.dispatchVersion).toBeUndefined();
  const db = new Database(f.file), before = f.board.researchIntegrity();
  db.query("INSERT INTO research_dispatch(campaign_id,revision,version,eligible_owners) VALUES(?,?,1,NULL)").run(f.draft.id, 1); db.close();
  expect(f.board.researchIntegrity()).toEqual(before);
  expect(f.board.researchCampaign(f.draft.id)!.dispatchVersion).toBe(1);
});
