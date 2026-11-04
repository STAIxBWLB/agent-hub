import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectChain } from "@staix/agent-mem";
import { Board, taskClaimIdentity, type Task } from "../src/hub/board.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { EVIDENCE_RECORD_TOOL, IMPLEMENTER_HUB_TOOL_NAMES, STUDY_TOOLS, TASK_TOOLS, TASK_TOOL_NAMES, profileTaskTools, projectToolList } from "../src/hub/hub-tools.ts";
import { SourceRegistry } from "../src/hub/sources.ts";
import { readRestartSnapshot } from "../src/hub/restart.ts";
import { realPath } from "../src/hub/project.ts";
import { Capture } from "../src/memory/capture.ts";
import type { MemoryClient } from "../src/memory/client.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function rig() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-evidence-daemon-"))), stateDir = join(root, "state"); mkdirSync(stateDir);
  const sources = new SourceRegistry(stateDir);
  const registered = [false, false, true].map((privateSource, i) => {
    const text = `공개 fixture passage ${i}`;
    const added = sources.add({ bytes: Buffer.from(text), text, kind: "file", origin: `source-${i}.txt`, private: privateSource });
    return { id: added.id, meta: sources.get(added.id)!, text };
  });
  const board = new Board(join(stateDir, "hub.db"));
  const research = board.propose("user", { title: "Standalone public evidence task", class: "test", profile: "research", profileClass: "fact_check", plan: { claims: ["bounded-claim-a", "bounded-claim-b"] } });
  const active = board.update(research.id, "user", "fixture accepted", { owner: "codex", state: "in_progress" });
  const dev = board.propose("user", { title: "Development task", class: "test", plan: { claims: ["dev-claim"] } });
  const devActive = board.update(dev.id, "user", "fixture accepted", { owner: "codex", state: "in_progress" });
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "evidence-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, profile: "research", roles: { codex: ["implementer"], claude: ["planner"], kimi: ["implementer"] }, roster: { ...DEFAULT_CONFIG.roster, kimi: true }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  const clients: ControlClient[] = [];
  const connect = async (role: "console" | "tools", peer?: string) => { const client = await ControlClient.connect(stateDir, { role, projectRoot: root, ...(peer ? { peer } : {}) }); clients.push(client); return client; };
  const person = await connect("console"), owner = await connect("tools", "codex"), other = await connect("tools", "kimi");
  const record = (client: ControlClient, input: unknown) => client.request({ t: "task", op: "hub_evidence_record", args: input });
  const payload = (task: Task = active, source = registered[0]!) => {
    const identity = taskClaimIdentity(task, 1);
    return { taskId: task.id, claimId: identity.claimId, claimRevision: identity.claimRevision, sourceId: source.id, rawSha256: source.meta.sha256,
      projectionSha256: hash(source.text), projectionVersion: "fixture-v1", locator: { start: 0, end: 2 }, relation: "supports" };
  };
  return { root, stateDir, daemon, board, sources, registered, active, devActive, person, owner, other, record, payload,
    project: projectChain(root).at(-1)!, close: async () => { for (const client of clients) client.close(); board.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); } };
}

function receipt(response: { ok?: boolean; error?: string; text?: string }) { expect(response.ok, response.error).toBe(true); const result = JSON.parse(response.text ?? ""); expect(Object.keys(result).sort()).toEqual(["id", "revision", "taskId"]); return result; }

test("evidence recording is research-only publication, recognized for dispatch/capture and absent from readonly/dev tools", () => {
  expect(profileTaskTools("dev")).toBe(TASK_TOOLS);
  expect(TASK_TOOLS.some(tool => tool.name === "hub_evidence_record")).toBe(false);
  expect(profileTaskTools("dev", ["custom"], true).some(tool => tool.name === "hub_evidence_record")).toBe(false);
  expect(profileTaskTools("research").some(tool => tool.name === "hub_evidence_record")).toBe(true);
  expect(projectToolList(profileTaskTools("research"), true).some(tool => tool.name === "hub_evidence_record")).toBe(false);
  expect(TASK_TOOL_NAMES.has("hub_evidence_record")).toBe(true); expect(STUDY_TOOLS.has("hub_evidence_record")).toBe(false);
  expect(IMPLEMENTER_HUB_TOOL_NAMES).toContain("hub_evidence_record");
  expect(EVIDENCE_RECORD_TOOL.inputSchema.properties).not.toHaveProperty("recordedBy");
  expect(EVIDENCE_RECORD_TOOL.inputSchema.additionalProperties).toBe(false);
  expect(EVIDENCE_RECORD_TOOL.description).toContain("declared");
  expect(profileTaskTools("research").some(tool => tool.name === "hub_evidence_read")).toBe(false);
});

test("the real daemon forwards actor and the whole evidence envelope and returns only the Tasks receipt", async () => {
  const f = await rig();
  try {
    const input = f.payload(), first = receipt(await f.record(f.owner, input));
    expect(first).toMatchObject({ revision: 1, taskId: f.active.id });
    expect(receipt(await f.record(f.owner, input))).toEqual(first);
    const stored = f.board.evidenceLink(f.project, first.id)!;
    expect(stored).toMatchObject({ recordedBy: "codex", taskId: f.active.id, claimId: input.claimId, claimRevision: input.claimRevision, sourceId: input.sourceId });
    const second = receipt(await f.record(f.owner, { ...f.payload(f.active, f.registered[1]!), relation: "contradicts" }));
    expect(second.id).not.toBe(first.id);
    expect(f.board.researchEvidenceIntegrity()).toMatchObject({ links: 2, revisions: 2 });
    const before = f.board.researchEvidenceIntegrity(), taskBefore = f.board.get(f.active.id);
    const refused = await f.record(f.owner, { ...input, extra: "PRIVATE_EVIDENCE_ARGUMENT_CANARY" });
    expect(refused.ok).toBe(false); expect(JSON.stringify(refused)).not.toContain("PRIVATE_EVIDENCE_ARGUMENT_CANARY");
    expect(f.board.researchEvidenceIntegrity()).toEqual(before); expect(f.board.get(f.active.id)).toEqual(taskBefore);
  } finally { await f.close(); }
});

test("foreign actors, stale claims, unknown/private sources and development tasks refuse before evidence writes", async () => {
  const f = await rig();
  try {
    const input = f.payload(), before = f.board.researchEvidenceIntegrity();
    for (const [client, payload] of [[f.other, input], [f.person, input], [f.owner, { ...input, claimRevision: "0".repeat(16) }],
      [f.owner, { ...input, recordedBy: "user" }], [f.owner, { ...input, sourceId: "src:0000000000000000" }],
      [f.owner, f.payload(f.active, f.registered[2]!)], [f.owner, f.payload(f.devActive)]] as const) {
      expect((await f.record(client, payload)).ok).toBe(false);
      expect(f.board.researchEvidenceIntegrity()).toEqual(before);
    }
  } finally { await f.close(); }
});

test("PII task and PII reviewer turn contexts refuse the evidence writer without an on-prem exception", async () => {
  const f = await rig();
  try {
    const row = f.board.propose("user", { title: "Private research", class: "test", profile: "research", plan: { claims: ["private-claim"] }, signals: ["pii"] });
    const active = f.board.update(row.id, "user", "fixture accepted", { owner: "codex", state: "in_progress" });
    expect((await f.record(f.owner, f.payload(active))).ok).toBe(false);
    f.board.update(row.id, "user", "fixture reviewer", { owner: "local", reviewer: "codex", state: "in_review" });
    expect((await f.record(f.owner, f.payload())).ok).toBe(false);
    expect(f.board.researchEvidenceIntegrity()).toMatchObject({ links: 0, revisions: 0 });
  } finally { await f.close(); }
});

test("native and namespaced evidence calls never send arguments or results to capture", async () => {
  const writes: Record<string, unknown>[] = [];
  const client = { appendCapture: async (record: Record<string, unknown>) => { writes.push(record); } } as unknown as MemoryClient;
  const capture = new Capture(client, { project: "evidence-fixture", cwd: import.meta.dir }); capture.init("evidence-session", "public session prompt");
  for (const tool of ["hub_evidence_record", "mcp__agent-hub__hub_evidence_record"]) capture.observe({ tool, args: "EVIDENCE_ARGS_CANARY", output: "EVIDENCE_RESULT_CANARY", id: tool, paths: [] });
  capture.observe({ tool: "read", args: "public.txt", output: "public control", id: "public-read", paths: ["public.txt"] });
  await Promise.resolve();
  expect(writes.filter(record => record.event === "PostToolUse")).toHaveLength(1);
  expect(JSON.stringify(writes)).not.toContain("EVIDENCE_ARGS_CANARY"); expect(JSON.stringify(writes)).not.toContain("EVIDENCE_RESULT_CANARY");
});

test("only stored evidence requires the recovery feature and contributes its conditional integrity section", async () => {
  expect(DAEMON_FEATURES).toContain("research_evidence");
  for (const stored of [false, true]) {
    const f = await rig();
    try {
      if (stored) receipt(await f.record(f.owner, f.payload()));
      const status = (await f.person.request({ t: "status" })).status, without = status.features.filter((name: string) => name !== "research_evidence");
      const request = (op: string, features: readonly string[]) => f.person.request({ t: "recovery", op, operationId: "evidence-recovery", expectedInstanceId: status.instanceId, targetFeatures: features });
      if (stored) {
        for (const op of ["prepare", "commit", "inspect"]) expect(await request(op, without)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks research_evidence") });
      }
      expect(await request("prepare", stored ? status.features : without)).toMatchObject({ ok: true });
      expect(await request("commit", stored ? status.features : without)).toMatchObject({ ok: true, committed: true });
      const snapshot = readRestartSnapshot(f.stateDir, { projectRoot: f.root, projectId: "evidence-fixture", operationId: "evidence-recovery" })!;
      expect(snapshot).toBeDefined();
      if (stored) expect(snapshot.integrity!.researchEvidence).toEqual(f.board.researchEvidenceIntegrity());
      else expect(snapshot.integrity).not.toHaveProperty("researchEvidence");
    } finally { await f.close(); }
  }
}, 20_000);

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { conductorPeer } from "../src/hub/conductor.ts";
import { ownerToolEffect } from "../src/hub/no-writes.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

test("in-process evidence receipts stay JSON when the peer has held-delivery metadata", async () => {
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("  const conductedMutations ="), end = source.indexOf("  const deliveryRetryAllowed =", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const readOnly = source.split("\n").find(line => line.startsWith("  const readOnlyPeer ="))!, readTools = source.split("\n").find(line => line.startsWith("const READ_ONLY_HUB_TOOLS ="))!;
  const result = { id: "ev:" + "a".repeat(32), revision: 1, taskId: 7 };
  const unexpected = () => { throw new Error("unrelated authority path reached"); };
  let hints = 0;
  const context = { Error, PreEffectToolRefusal, conductorPeer, ownerToolEffect, declarations: {}, config: { roles: {} }, turns: new Map(), reviewerToolObservers: new Map(),
    sourceReadCurrent: unexpected, runningReviewAuthority: unexpected, auditConduct: unexpected,
    ownHeldHint: () => { hints++; return "held-delivery control metadata"; }, taskOpBody: async () => JSON.stringify(result), extracted: undefined as unknown };
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`${readOnly}\n${readTools}\nlet taskOpsInFlight=0;\n${source.slice(start, end)}\nglobalThis.extracted=taskOp;`);
  runInNewContext(script, context);
  const run = context.extracted as (by: string, op: string, input: unknown, inProcess: boolean) => Promise<string>;
  expect(JSON.parse(await run("codex", "hub_evidence_record", { taskId: 7 }, true))).toEqual(result); expect(hints).toBe(0);
  expect(await run("codex", "hub_task_list", {}, true)).toContain("held-delivery control metadata"); expect(hints).toBe(1);
});

test("an owner reads canonical claim bindings over RPC and a legal plan edit stales the old evidence input", async () => {
  const f = await rig();
  const show = async (id: number) => {
    const response = await f.owner.request({ t: "task", op: "hub_task_show", args: { id } });
    expect(response.ok, response.error).toBe(true);
    return JSON.parse(response.text);
  };
  try {
    const shown = await show(f.active.id), binding = shown.claims.find((claim: { slot: number }) => claim.slot === 1);
    expect(binding).toBeDefined(); expect(Object.keys(binding).sort()).toEqual(["claimId", "claimRevision", "slot"]);
    const consoleRead = await f.person.request({ t: "task", op: "task_show", args: { id: f.active.id } });
    expect(consoleRead.ok, consoleRead.error).toBe(true); expect(JSON.parse(consoleRead.text).claims).toEqual(shown.claims);
    expect(JSON.stringify(shown.claims)).not.toContain("bounded-claim-a"); expect(JSON.stringify(shown.claims)).not.toContain("bounded-claim-b");
    const source = f.registered[0]!;
    // Use the public RPC values directly. The client neither reconstructs identity nor hashes the claim list.
    const input = { taskId: f.active.id, claimId: binding.claimId, claimRevision: binding.claimRevision, sourceId: source.id, rawSha256: source.meta.sha256,
      projectionSha256: hash(source.text), projectionVersion: "fixture-v1", locator: { start: 0, end: 2 }, relation: "supports" };
    const first = receipt(await f.record(f.owner, input));
    const edited = await f.owner.request({ t: "task", op: "hub_task_accept", args: { id: f.active.id, plan: { claims: ["revised-claim-a", "bounded-claim-b"] } } });
    expect(edited.ok, edited.error).toBe(true);
    expect(f.board.get(f.active.id)!.plan!.claims).toEqual(["revised-claim-a", "bounded-claim-b"]);
    const refreshed = await show(f.active.id), fresh = refreshed.claims.find((claim: { slot: number }) => claim.slot === 1);
    const consoleRefreshed = await f.person.request({ t: "task", op: "task_show", args: { id: f.active.id } });
    expect(consoleRefreshed.ok, consoleRefreshed.error).toBe(true); expect(JSON.parse(consoleRefreshed.text).claims).toEqual(refreshed.claims);
    expect(fresh.claimId).toBe(binding.claimId); expect(fresh.claimRevision).not.toBe(binding.claimRevision);
    const before = f.board.researchEvidenceIntegrity();
    const stale = await f.record(f.owner, input);
    expect(stale.ok).toBe(false); expect(stale.error).toContain("claim");
    expect(f.board.researchEvidenceIntegrity()).toEqual(before);
    expect(f.board.evidenceLink(f.project, first.id, 1)).toMatchObject({ claimId: binding.claimId, claimRevision: binding.claimRevision });
    receipt(await f.record(f.owner, { ...input, claimId: fresh.claimId, claimRevision: fresh.claimRevision }));
    expect(f.board.researchEvidenceIntegrity()).toMatchObject({ links: 2, revisions: 2 });
  } finally { await f.close(); }
});

test("owner task reads omit evidence claim bindings for development and private tasks", async () => {
  const f = await rig();
  try {
    const dev = await f.owner.request({ t: "task", op: "hub_task_show", args: { id: f.devActive.id } });
    expect(dev.ok, dev.error).toBe(true); expect(JSON.parse(dev.text)).not.toHaveProperty("claims");
    const consoleDev = await f.person.request({ t: "task", op: "task_show", args: { id: f.devActive.id } });
    expect(consoleDev.ok, consoleDev.error).toBe(true); expect(JSON.parse(consoleDev.text)).not.toHaveProperty("claims");
    const row = f.board.propose("user", { title: "PII evidence fixture", class: "test", profile: "research", plan: { claims: ["PRIVATE_CLAIM_TEXT_CANARY"] }, signals: ["pii"] });
    f.board.update(row.id, "user", "fixture accepted", { owner: "codex", state: "in_progress" });
    const hidden = await f.owner.request({ t: "task", op: "hub_task_show", args: { id: row.id } });
    expect(hidden.ok, hidden.error).toBe(true); expect(JSON.parse(hidden.text)).toMatchObject({ title: "[pii]" });
    expect(JSON.parse(hidden.text)).not.toHaveProperty("claims"); expect(hidden.text).not.toContain("PRIVATE_CLAIM_TEXT_CANARY");
    const consolePrivate = await f.person.request({ t: "task", op: "task_show", args: { id: row.id } });
    expect(consolePrivate.ok, consolePrivate.error).toBe(true); expect(JSON.parse(consolePrivate.text)).not.toHaveProperty("claims");
  } finally { await f.close(); }
});
