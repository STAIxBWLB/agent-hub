import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { parseRole, parseRoleDocument } from "../src/hub/roles.ts";
import { guidanceVariantKey, parseGuidancePageResult, parseGuidanceDiffResult, type GuidanceVariantPayloadV1 } from "../src/hub/guidance-variants.ts";
import vectors from "./fixtures/guidance-variant-v1.json";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver() {} }
async function fixture(baseline = vectors.baseline) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-guidance-pages-")), file = join(cwd, "hub.db"), board = new Board(file), sql = new Database(file), bus = new Bus({ batchMs: 0 });
  clean.push(() => { bus.closeJournal(); sql.close(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  for (const id of ["codex", "claude"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const task = board.propose(USER, { title: "Guidance page fixture", class: "implement", role: "test-engineer" });
  board.update(task.id, USER, "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
  const role = parseRole(baseline, "test-engineer", "project"), routing = loadRouting(cwd);
  const policy = { private: false, review: false, patterns: [] as string[], deny: [] as string[] };
  const binding = { projectKey: "guidance-pagination-fixture", cursorKey: "guidance-pagination-private-cursor-000001" };
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", catalog: { roles: new Map([[role.id, role]]), errors: [] },
    roles: { codex: ["implementer"], claude: ["reviewer"] }, deny: policy.deny, notify: () => {},
    privateTurn: () => policy.private, reviewObserverInput: () => policy.review,
    routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: "off", pii_patterns: policy.patterns } }), executionLineage: binding });
  const query = () => ({ taskId: task.id, taskCreated: task.created });
  const make = (experimentId: string, after?: string) => {
    const { id: _id, ...golden } = vectors.golden.record, current = board.get(task.id)!;
    const scope = parseRoleDocument(baseline, role.id, "project").sections.find(section => section.name === "Scope")!;
    const bytes = after === undefined ? golden.candidate.bytes : baseline.slice(0, scope.contentStartUtf16) + "\n" + after + "\n\n" + baseline.slice(scope.endUtf16);
    const value: GuidanceVariantPayloadV1 = { ...golden, v: 1, projectKey: binding.projectKey, experimentId, author: "codex", taskId: current.id, taskCreated: current.created,
      flowRevision: current.history.length, baseline: { ...golden.baseline, bytes: baseline, sha256: role.hash, layer: "project" }, candidate: { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }, evidenceRefs: [] };
    return { ...value, id: guidanceVariantKey(value) };
  };
  const seed = async (count: number) => { const records = Array.from({ length: count }, (_, index) => make(`experiment-${index}`)); for (const value of records) await tasks.guidanceVariantCreate("codex", value); return records; };
  return { cwd, board, sql, bus, task, tasks, policy, binding, query, make, seed };
}

test("an admitted baseline inline tab remains an available safe editable diff", async () => {
  const baseline = vectors.baseline.replace("Check behavior.", "Check\tbehavior.");
  const f = await fixture(baseline), input = f.make("experiment-tab", "Check observable behavior.");
  await f.tasks.guidanceVariantCreate("codex", input);
  const result = f.tasks.guidanceVariantDiff("codex", { ...f.query(), id: input.id });
  if (result.state !== "available") throw new Error("admitted baseline formatting must not deny the whole view");
  expect(result.sections[0]!.before).toContain("Check\tbehavior.");
  expect(result.sections[0]!.after).toContain("Check observable behavior.");
  expect(result.record.applicable).toBe(true);
  expect(() => parseGuidanceDiffResult(result)).not.toThrow();
});

test("forty experiments page by content id with thirty-two rows plus one SQL sentinel and explicit continuation", async () => {
  const f = await fixture(), inputs = await f.seed(40), expected = inputs.map(value => value.id).sort(), calls: { after: string; rows: number }[] = [];
  const read = f.board.guidanceVariantPage.bind(f.board);
  f.board.guidanceVariantPage = (project, task, created, after = "") => { const rows = read(project, task, created, after); calls.push({ after, rows: rows.length }); return rows; };
  const firstQuery = f.query(), firstStarted = performance.now();
  const firstRaw = f.tasks.guidanceVariantList("codex", firstQuery);
  const firstReadMs = performance.now() - firstStarted;
  const first = parseGuidancePageResult(firstRaw);
  if (first.state !== "available") throw new Error("first page must be available");
  expect(first.records.map(record => record.id)).toEqual(expected.slice(0, 32)); expect(first.truncated).toBe(true); expect(first.cursor).toBeDefined();
  expect(calls.every(call => call.rows <= 33)).toBe(true); expect(calls.some(call => call.rows === 33)).toBe(true);
  expect(first.current).toEqual({ ...f.query(), flowRevision: f.board.get(f.task.id)!.history.length });
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(262144);
  expect(first.cursor!.length).toBeLessThanOrEqual(512);
  const cursor = JSON.parse(Buffer.from(first.cursor!, "base64url").toString("utf8"));
  expect(Object.keys(cursor).sort()).toEqual(["after", "signature", "v"]); expect(cursor.after).toBe(expected[31]);
  expect(JSON.stringify(cursor)).not.toContain("experiment-");
  const secondQuery = { ...f.query(), cursor: first.cursor }, secondStarted = performance.now();
  const secondRaw = f.tasks.guidanceVariantList("codex", secondQuery);
  const secondReadMs = performance.now() - secondStarted;
  const second = parseGuidancePageResult(secondRaw);
  if (second.state !== "available") throw new Error("continuation must be available");
  expect(second.records.map(record => record.id)).toEqual(expected.slice(32)); expect(second.truncated).toBe(false); expect(second.cursor).toBeUndefined();
  expect(calls.some(call => call.after === expected[31])).toBe(true);
  expect(new Set([...first.records, ...second.records].map(record => record.id)).size).toBe(40);
  // These are actual fixture observations when the authorized test run happens,
  // not a synthetic latency budget or native/model-consumption acceptance.
  const canonicalVariantBytes = inputs.map(input => Buffer.byteLength(JSON.stringify(input)));
  console.info("guidance source fixture metrics", JSON.stringify({ variants: 40, experiments: 40, firstReplyBytes: Buffer.byteLength(JSON.stringify(first)), secondReplyBytes: Buffer.byteLength(JSON.stringify(second)), storedVariantBytes: canonicalVariantBytes.reduce((sum, bytes) => sum + bytes, 0), minVariantBytes: Math.min(...canonicalVariantBytes), maxVariantBytes: Math.max(...canonicalVariantBytes), firstReadMs, secondReadMs }));
});

test("actual page and location queries use the task-id index, bounded LIMIT and keyset comparison", async () => {
  const f = await fixture(), inputs = await f.seed(34), seen: string[] = [];
  const executed: { sql: string; parameters: unknown[] }[] = [];
  const db = (f.board as unknown as { db: { query(sql: string): unknown } }).db, query = db.query.bind(db);
  db.query = sql => {
    seen.push(sql);
    const statement = query(sql) as { all(...parameters: unknown[]): unknown };
    if (sql.includes("FROM guidance_variants INDEXED BY guidance_variant_task_id")) {
      const all = statement.all.bind(statement);
      statement.all = (...parameters) => {
        try { executed.push({ sql, parameters }); return all(...parameters); }
        finally { statement.all = all; }
      };
    }
    return statement;
  };
  try {
    const first = f.board.guidanceVariantPage(f.binding.projectKey, f.task.id, f.task.created);
    expect(first).toHaveLength(33);
    const second = f.board.guidanceVariantPage(f.binding.projectKey, f.task.id, f.task.created, first.at(-1)!.variant.id);
    expect(second).toHaveLength(1);
    expect(f.board.guidanceVariantLocation(f.binding.projectKey, f.task.id, f.task.created, inputs[0]!.id)).toBe(inputs[0]!.experimentId);
  } finally { db.query = query; }
  const pages = seen.filter(sql => /ORDER\s+BY\s+guidance_variants\.id\s+LIMIT/i.test(sql));
  expect(pages).toHaveLength(2);
  for (const sql of pages) { expect(sql).toContain("INDEXED BY guidance_variant_task_id"); expect(sql).toMatch(/guidance_variants\.id\s*>\s*\?/); expect(sql).not.toMatch(/\bOFFSET\b/i); expect(sql).toContain("CASE WHEN typeof(body)='text'"); }
  expect(seen.some(sql => sql.includes("id=? LIMIT 2") && sql.includes("INDEXED BY guidance_variant_task_id"))).toBe(true);
  const pageQueries = executed.filter(entry => /ORDER\s+BY\s+guidance_variants\.id\s+LIMIT/i.test(entry.sql));
  expect(pageQueries).toHaveLength(2);
  for (const entry of pageQueries) {
    expect(entry.parameters.at(-1)).toBe(33);
    expect(entry.parameters.every(value => typeof value === "string" || typeof value === "number")).toBe(true);
    // Explain the exact SQL and bindings the product executed, not a hand-copied
    // approximation that could keep passing after its actual query regressed.
    const plan = f.sql.query("EXPLAIN QUERY PLAN " + entry.sql).all(...entry.parameters as (string | number)[]) as { detail: string }[];
    expect(plan.some(row => row.detail.includes("guidance_variant_task_id"))).toBe(true);
    expect(plan.some(row => /TEMP B-TREE/i.test(row.detail))).toBe(false);
  }
});

for (const change of ["actor", "epoch", "flow", "signing-key", "private", "review", "pii"] as const)
  test(`cursor refuses changed ${change} instead of exposing an empty successful page`, async () => {
    const f = await fixture(); await f.seed(33);
    const page = f.tasks.guidanceVariantList("codex", f.query()); if (page.state !== "available" || !page.cursor) throw new Error("fixture must paginate");
    let actor = "codex", query = { ...f.query(), cursor: page.cursor };
    if (change === "actor") actor = "claude";
    else if (change === "epoch") query.taskCreated++;
    else if (change === "flow") f.board.update(f.task.id, USER, "note", {}, "New revision");
    else if (change === "signing-key") f.binding.cursorKey = "replacement-private-signing-generation";
    else if (change === "private") f.policy.private = true;
    else if (change === "review") f.policy.review = true;
    else f.board.update(f.task.id, USER, "note", { signals: ["pii"] });
    expect(f.tasks.guidanceVariantList(actor, query)).toEqual({ state: "unavailable" });
  });

test("withheld experiment labels never become selectors; id-only show and current-flow withdrawal remain exact", async () => {
  const f = await fixture(), input = f.make("Sensitive experiment label"); await f.tasks.guidanceVariantCreate("codex", input);
  f.policy.patterns.push("Sensitive experiment");
  const query = { ...f.query(), id: input.id }, shown = parseGuidanceDiffResult(f.tasks.guidanceVariantDiff("codex", query));
  if (shown.state !== "available") throw new Error("id-only detail should not require the public experiment label");
  expect(shown.record.experimentId).toBe("withheld"); expect(shown.record.id).toBe(input.id);
  expect(shown.record.applicable).toBe(true);
  f.board.update(f.task.id, USER, "note", {}, "New wrapper revision");
  const historical = f.tasks.guidanceVariantDiff("codex", query);
  if (historical.state !== "available") throw new Error("historical detail remains readable");
  expect(historical.record.flowRevision).toBe(input.flowRevision); expect(historical.current.flowRevision).toBe(input.flowRevision + 1); expect(historical.record.applicable).toBe(false);
  const receipt = await f.tasks.guidanceVariantWithdraw("codex", { ...query, flowRevision: historical.current.flowRevision });
  expect(receipt.status).toBe("withdrawn"); expect(receipt.experimentId).toBe("withheld");
  expect(f.board.guidanceVariants(f.binding.projectKey, f.task.id, f.task.created, input.experimentId)[0]!.variant).toEqual(input);
});

test("editable diff fields are screened whole and protected source/header/address bytes never cross the DTO", async () => {
  const f = await fixture(), input = f.make("experiment-a", "Check public behavior.\nCheck private/canary behavior.");
  await f.tasks.guidanceVariantCreate("codex", input); f.policy.patterns.push("private/canary");
  const result = f.tasks.guidanceVariantDiff("codex", { ...f.query(), id: input.id });
  if (result.state !== "available") throw new Error("safe diff metadata remains available");
  expect(result.sections.map(section => section.section)).toEqual(["Scope", "Deliverables", "Evidence"]);
  expect(result.sections[0]!.before).toContain("Check behavior."); expect(result.sections[0]!.after).toBe("withheld");
  expect(result.sections[0]!.after).not.toContain("Check public behavior.");
  expect(result.sections[1]!.after).toContain("Report observations.");
  expect(result.protectedSections).toEqual(["Not in scope", "Hub use", "Review duties"]);
  const json = JSON.stringify(result);
  for (const value of [input.baseline.bytes, input.candidate.bytes]) expect(json).not.toContain(JSON.stringify(value).slice(1, -1));
  for (const value of ["source: Independent local conformance fixture.", "Use hub_task_done for handoff.", "Review the evidence.", "Change permissions."]) expect(json).not.toContain(value);
  expect(result.record.applicable).toBe(true);
  f.policy.patterns.length = 0; f.policy.deny.push("secrets/**");
  const pathUnknown = f.tasks.guidanceVariantDiff("codex", { ...f.query(), id: input.id });
  if (pathUnknown.state !== "available") throw new Error("unknown path proof only withholds one field");
  expect(pathUnknown.sections[0]!.after).toBe("withheld"); expect(pathUnknown.record.applicable).toBe(true);
});

test("SQL byte bounds reject oversized stored JSON before parsing and duplicate task-scope ids are ambiguous", async () => {
  const f = await fixture(), input = f.make("experiment-a"); await f.tasks.guidanceVariantCreate("codex", input);
  f.sql.query("UPDATE guidance_variants SET body=? WHERE id=?").run("x".repeat(32769), input.id);
  const parse = JSON.parse; let oversized = false;
  JSON.parse = (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => { if (text.length > 32768) oversized = true; return parse(text, reviver); };
  try { expect(f.tasks.guidanceVariantList("codex", f.query())).toEqual({ state: "unavailable" }); }
  finally { JSON.parse = parse; }
  expect(oversized).toBe(false);
  const body = JSON.stringify(input); f.sql.query("UPDATE guidance_variants SET body=?,body_sha256=? WHERE id=?").run(body, createHash("sha256").update(body).digest("hex"), input.id);
  f.sql.query(`INSERT INTO guidance_experiments(project_id,task_id,task_created,experiment_id,baseline_json)
    SELECT project_id,task_id,task_created,'synthetic-ambiguous',baseline_json FROM guidance_experiments WHERE experiment_id=?`).run(input.experimentId);
  f.sql.query(`INSERT INTO guidance_variants(project_id,task_id,task_created,experiment_id,id,body,body_sha256,created_by,created_at)
    SELECT project_id,task_id,task_created,'synthetic-ambiguous',id,body,body_sha256,created_by,created_at FROM guidance_variants WHERE id=?`).run(input.id);
  expect(() => f.board.guidanceVariantLocation(f.binding.projectKey, f.task.id, f.task.created, input.id)).toThrow();
  expect(f.tasks.guidanceVariantDiff("codex", { ...f.query(), id: input.id })).toEqual({ state: "unavailable" });
  expect(f.tasks.guidanceVariantList("codex", f.query())).toEqual({ state: "unavailable" });
});

test("whole-field privacy matches raw multiline prose before JSON escaping and withholds every line", async () => {
  const f = await fixture(), text = "Check private.\nCanary behavior.";
  const { id: _id, ...unsigned } = f.make("experiment-multiline", text);
  const payload: GuidanceVariantPayloadV1 = { ...unsigned, rationale: { ...unsigned.rationale, problemHypothesis: text } };
  const input = { ...payload, id: guidanceVariantKey(payload) };
  await f.tasks.guidanceVariantCreate("codex", input);
  const selector = { ...f.query(), id: input.id }, clear = f.tasks.guidanceVariantDiff("codex", selector);
  if (clear.state !== "available") throw new Error("clear multiline fixture should be available");
  expect(clear.sections[0]!.after).toContain(text); expect(clear.record.rationale.problemHypothesis).toBe(text);
  // Whitespace in the raw field crosses LF. Matching only the JSON string would
  // see a backslash plus n and miss this currently private whole-field pattern.
  f.policy.patterns.push("private[.]\\s+Canary");
  const rawPattern = new RegExp(f.policy.patterns.at(-1)!);
  expect(rawPattern.test(text)).toBe(true);
  expect(rawPattern.test(JSON.stringify(text))).toBe(false);
  const withheld = f.tasks.guidanceVariantDiff("codex", selector);
  if (withheld.state !== "available") throw new Error("field privacy must preserve safe metadata");
  expect(withheld.sections[0]!.after).toBe("withheld");
  expect(withheld.sections[0]!.after).not.toContain("Check private.");
  expect(withheld.record.rationale.problemHypothesis).toBe("withheld");
  expect(withheld.record.rationale.expectedObservableDifference).toBe(input.rationale.expectedObservableDifference);
  expect(withheld.record.applicable).toBe(true);
  expect(f.tasks.guidanceVariantApplicable("codex", selector)).toBe(true);
  expect(JSON.stringify(withheld)).not.toContain("Check private.");
  const historical = f.tasks.guidanceVariantRead("codex", { ...selector, experimentId: input.experimentId });
  if (historical.state !== "available") throw new Error("the inherited T2 read should retain safe metadata");
  expect(historical.records[0]!.rationale.problemHypothesis).toBe("withheld");
  expect(historical.records[0]!.applicable).toBe(true);
  expect(JSON.stringify(historical)).not.toContain("Check private.");
  expect(f.board.guidanceVariants(f.binding.projectKey, input.taskId, input.taskCreated, input.experimentId)[0]!.variant).toEqual(input);
});
