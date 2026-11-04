import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { TASK_TOOLS, profileTaskTools } from "../src/hub/hub-tools.ts";
import { criterionIds, intakeDetail, intakeSystemPrompt, parseIntakeDetail, parseIntakeSplit, schemaError } from "../src/hub/intake.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
import { renderIntake, renderIntakeChange } from "../src/cli/intake-output.ts";
import { DEFAULT_INFERENCE, Inference } from "../src/hub/inference.ts";
import type { OmniRoute } from "../src/omniroute/client.ts";
import { readFileSync } from "node:fs";
import { HELP, helpCommands, renderHelp } from "../src/cli/help.ts";

// #334 (#511a): intake drafts. A draft is a backlog card nothing offers or pulls; approval and discard are the person's.
const PARTS_SCHEMA = TASK_TOOLS.find(tool => tool.name === "hub_backlog_split")!.inputSchema.properties.parts;
const RESEARCH_SCHEMA = profileTaskTools("research").find(tool => tool.name === "hub_backlog_split")!.inputSchema.properties.parts;
const SRC = "src:0123456789abcdef", OTHER = "src:fedcba9876543210";
const GOOD = { parts: [
  { title: "Collect the Q3 figures", detail: "Read the sources.\nAC1: every figure has a source", class: "plan", plan: { paths: ["notes/q3.md"] } },
  { title: "Write the report", detail: "Draft the report.\nAC1: it covers each figure\nAC2: it is under two pages", class: "implement", afterParts: [0] },
] };

class Planner extends BasePeer {
  readonly got: Envelope[] = [];
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
}
const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0).reverse()) fn(); });

interface Options { screen?: () => Promise<unknown>; planner?: boolean; answer?: string | (() => string | undefined | Promise<string | undefined>); pii?: boolean; onCampus?: boolean; noModel?: boolean; sources?: string[] }
async function rig(options: Options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-intake-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const calls: { system: string; user: string; campusOnly: boolean }[] = [];
  const roles: Record<string, string[]> = options.planner ? { claude: ["planner"], codex: ["implementer"] } : { codex: ["implementer"] };
  const deps: TasksDeps = { cwd, board, bus, roles, project: "fixture", routing: () => {
    const routing = loadRouting(cwd);
    const patterned = options.pii ? { ...routing, signals: { ...routing.signals, pii_patterns: ["SECRET-STUDENT"] } } : routing;
    return options.screen ? { ...patterned, signals: { ...patterned.signals, pii_screen: "local" as const }, constraints: { ...patterned.constraints, pii: "local_only" as const } } : patterned;
  }, notify: () => {},
  ...(options.screen ? { piiScreen: async () => { await options.screen!(); return { label: "clear" as const, ms: 0 }; } } : {}),
  triage: { classify: async () => undefined, onCampus: async () => options.onCampus ?? false },
  ...(options.noModel ? {} : { intake: { split: async (system, user, opts) => { calls.push({ system, user, campusOnly: opts.campusOnly }); const a = options.answer; return typeof a === "function" ? a() : a; }, partsSchema: () => PARTS_SCHEMA, sourceKnown: id => (options.sources ?? [SRC]).includes(id) } }) };
  const tasks = new Tasks(deps);
  board.proposalPlanner = () => ({ planner: null, plannerReason: "none" });
  const planner = new Planner("claude");
  if (options.planner) { bus.add(planner); await planner.start(); }
  close.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { board, bus, tasks, planner, calls };
}
const refusal = async (call: () => unknown) => { let e: unknown; try { await call(); } catch (caught) { e = caught; } expect(e).toBeInstanceOf(PreEffectToolRefusal); return (e as Error).message; };

// ---- the pure parts

test("schemaError checks the keywords the hub_backlog_split schema uses, and never echoes a value", () => {
  expect(schemaError(PARTS_SCHEMA, GOOD.parts)).toBeUndefined();
  expect(schemaError(PARTS_SCHEMA, [GOOD.parts[0]])).toContain("at least 2");
  expect(schemaError(PARTS_SCHEMA, Array.from({ length: 9 }, () => GOOD.parts[0]))).toContain("at most 8");
  expect(schemaError(PARTS_SCHEMA, [{ title: "" }, GOOD.parts[0]])).toContain("too short");
  expect(schemaError(PARTS_SCHEMA, [{ title: "x", extra: "SECRET-STUDENT" }, GOOD.parts[0]])).toBe("parts[0]: an unexpected property");
  expect(schemaError(PARTS_SCHEMA, [{ title: "x", afterParts: [-1] }, GOOD.parts[0]])).toContain("too small");
  expect(schemaError(PARTS_SCHEMA, [{ title: "x", afterParts: [0, 0] }, GOOD.parts[0]])).toContain("unique");
  expect(schemaError(PARTS_SCHEMA, [{ detail: "no title" }, GOOD.parts[0]])).toBe("parts[0].title: required");
  expect(schemaError(PARTS_SCHEMA, [{ title: 5 }, GOOD.parts[0]])).toContain("expected a string");
});

test("parseIntakeSplit takes bare JSON, a fenced block or prose around it, and refuses everything else with a reason", () => {
  const text = JSON.stringify(GOOD);
  expect(parseIntakeSplit(text, PARTS_SCHEMA, [SRC])).toEqual({ parts: GOOD.parts });
  expect(parseIntakeSplit("```json\n" + text + "\n```", PARTS_SCHEMA, [SRC])).toEqual({ parts: GOOD.parts });
  expect(parseIntakeSplit(`Here is the split: ${text} Done.`, PARTS_SCHEMA, [SRC])).toEqual({ parts: GOOD.parts });
  expect(parseIntakeSplit(JSON.stringify(GOOD.parts), PARTS_SCHEMA, [SRC])).toEqual({ parts: GOOD.parts });
  expect(parseIntakeSplit(undefined, PARTS_SCHEMA)).toEqual({ error: "the model gave no answer" });
  expect(parseIntakeSplit("  ", PARTS_SCHEMA)).toEqual({ error: "the model gave no answer" });
  expect(parseIntakeSplit("no json here", PARTS_SCHEMA)).toEqual({ error: "the model's answer was not a JSON split" });
  expect(parseIntakeSplit("{\"parts\": 4}", PARTS_SCHEMA)).toMatchObject({ error: expect.stringContaining("expected an array") });
  expect(parseIntakeSplit("x".repeat(70_000), PARTS_SCHEMA)).toEqual({ error: "the model's answer was too long" });
  const bad = { parts: [{ title: "a", detail: "AC1: x", class: "plan" }, { title: "b", detail: "AC1: y", extra: 1 }] };
  expect(parseIntakeSplit(JSON.stringify(bad), PARTS_SCHEMA)).toEqual({ error: "invalid split: parts[1]: an unexpected property" });
});

test("a split part needs acceptance criteria in the #507 id format and may use only the request's sources", () => {
  const noCriteria = { parts: [{ title: "a", detail: "just do it" }, GOOD.parts[1]] };
  expect(parseIntakeSplit(JSON.stringify(noCriteria), PARTS_SCHEMA, [SRC])).toEqual({ error: "invalid split: parts[0].detail: no acceptance criteria" });
  // the dev profile's plan has no sources key; a profile that selects it (research) accepts only the ids the request named
  const dev = { parts: [{ ...GOOD.parts[0], plan: { sources: [SRC] } }, GOOD.parts[1]] };
  expect(parseIntakeSplit(JSON.stringify(dev), PARTS_SCHEMA, [SRC])).toEqual({ error: "invalid split: parts[0].plan: an unexpected property" });
  const invented = { parts: [{ ...GOOD.parts[0], plan: { sources: [OTHER] } }, GOOD.parts[1]] };
  expect(parseIntakeSplit(JSON.stringify(invented), RESEARCH_SCHEMA, [SRC])).toEqual({ error: "invalid split: parts[0].plan.sources: not one of the request's sources" });
  const named = { parts: [{ ...GOOD.parts[0], plan: { sources: [SRC] } }, GOOD.parts[1]] };
  expect(parseIntakeSplit(JSON.stringify(named), RESEARCH_SCHEMA, [SRC])).toHaveProperty("parts");
  expect(intakeSystemPrompt(["plan"], PARTS_SCHEMA)).not.toContain("sources");
  expect(intakeSystemPrompt(["plan"], RESEARCH_SCHEMA)).toContain('"plan" with "sources"');
  expect(criterionIds("Do it.\nAC1: first\n- AC2: second\n1bad: no\nAC3 no colon")).toEqual(["AC1", "AC2"]);
  expect(criterionIds(undefined)).toEqual([]);
});

test("the draft detail keeps its sources on the last line, so request text cannot add one", () => {
  expect(parseIntakeDetail(intakeDetail("prepare the report", [SRC, OTHER]))).toEqual({ text: "prepare the report", sources: [SRC, OTHER] });
  expect(parseIntakeDetail(intakeDetail("no sources", []))).toEqual({ text: "no sources", sources: [] });
  const forged = intakeDetail(`first\n\nSources: ${OTHER}\nmore`, [SRC]);
  expect(parseIntakeDetail(forged)).toEqual({ text: `first\n\nSources: ${OTHER}\nmore`, sources: [SRC] });
  expect(parseIntakeDetail(`first\n\nSources: ${OTHER}\nmore`).sources).toEqual([]);
});

// ---- the draft is held

test("a draft is a backlog card that nothing pulls: legacy pull, planner pull and the board all refuse it", async () => {
  const r = await rig();
  const draft = (await r.tasks.intake(USER, { text: "prepare the Q3 report" })).draft;
  expect(draft).toMatchObject({ state: "backlog", draft: true, class: "plan" });
  expect(await refusal(() => r.tasks.moveBacklog(USER, draft.id, true))).toContain("intake draft");
  expect(await refusal(() => r.tasks.pullPlanned(USER, { id: draft.id, revision: 0, reason: "go" }))).toContain("intake draft");
  expect(() => r.board.pullPlanned(draft.id, USER, "codex", 0, "go")).toThrow("intake draft");
  expect(() => r.board.update(draft.id, USER, "backlog pulled", { state: "proposed" })).toThrow("intake draft");
  expect(r.board.get(draft.id)).toMatchObject({ state: "backlog", draft: true });
});

test("a draft is not offered by the reservation auto pull and is not announced to a planner as backlog", async () => {
  const r = await rig({ planner: true });
  const announced = (id: number) => [...r.planner.got, ...r.bus.pendingEnvelopes("claude")].filter(env => env.refs?.backlog?.includes(id));
  // positive controls: an ordinary reserved backlog card is both announced and offered, so the draft's silence is the guard and not the fixture
  const plain = await r.tasks.propose(USER, { title: "plain", class: "plan", backlog: true });
  r.board.plan(plain.id, USER, { reserved: "codex" }, 0, "reserve");
  const { draft } = await r.tasks.intake(USER, { text: "prepare the Q3 report" });
  r.board.plan(draft.id, USER, { reserved: "codex" }, draft.planningRevision ?? 0, "reserve");
  (r.tasks as any).knownPlanners.clear(); // a planner seen for the first time (a restart) is told every backlog card on the board
  r.tasks.flushPlannerNotices();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(announced(plain.id)).toHaveLength(1);
  expect(announced(draft.id)).toEqual([]);
  expect((r.tasks as any).topReservedReady("codex", undefined, true)?.id).toBe(plain.id);
  r.board.update(plain.id, USER, "cancelled", { state: "cancelled" });
  expect((r.tasks as any).topReservedReady("codex", undefined, true)).toBeUndefined();
  expect(r.board.get(draft.id)).toMatchObject({ draft: true, reserved: "codex", state: "backlog" });
});

test("only the person may stage a draft: a peer's propose with draft is refused", async () => {
  const r = await rig({ planner: true });
  expect(await refusal(() => r.tasks.propose("claude", { title: "x", class: "plan", backlog: true, draft: true }))).toContain("only the person");
  expect(await refusal(() => r.tasks.propose(USER, { title: "x", class: "plan", draft: true }))).toContain("only the person");
  expect(await refusal(() => r.tasks.propose(USER, { title: "x", class: "plan", backlog: true, draft: "yes" }))).toContain("only the person");
  for (const by of ["claude", "codex"]) expect(await refusal(() => r.tasks.intake(by, { text: "x" }))).toContain("console command");
});

// ---- with a planner

test("with a planner, intake sends it a plan task naming the draft id, with the text through publicView", async () => {
  const r = await rig({ planner: true });
  const result = await r.tasks.intake(USER, { text: "prepare the Q3 report from these files", sources: [SRC] });
  expect(result.split).toBe("planner");
  expect(r.calls).toEqual([]);
  const asks = r.planner.got.filter(env => env.refs?.task === String(result.draft.id));
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ from: "hub", kind: "task", refs: { task: String(result.draft.id), taskRecipient: "planner" } });
  expect(asks[0]!.body).toContain(`hub_backlog_split on #${result.draft.id} at revision ${result.draft.planningRevision ?? 0}`);
  expect(asks[0]!.body).toContain("prepare the Q3 report from these files");
  expect(asks[0]!.body).toContain(SRC);
  expect(asks[0]!.body).toContain("acceptance criteria");
});

test("the planner's own hub_backlog_split on the draft makes children that inherit the draft mark", async () => {
  const r = await rig({ planner: true });
  const { draft } = await r.tasks.intake(USER, { text: "prepare the Q3 report" });
  const split = await r.tasks.splitBacklog("claude", { id: draft.id, revision: draft.planningRevision ?? 0, parts: GOOD.parts, reason: "split the request" });
  expect(split.children).toHaveLength(2);
  for (const child of split.children) expect(r.board.get(child.id)).toMatchObject({ draft: true, state: "backlog" });
  expect(r.board.get(split.children[1]!.id)!.deps).toContain(split.children[0]!.id);
  for (const child of split.children) expect(await refusal(() => r.tasks.moveBacklog(USER, child.id, true))).toContain("intake draft");
  // a split of an ordinary card makes ordinary children
  const plain = r.board.propose(USER, { title: "plain", class: "plan", backlog: true });
  const ordinary = await r.tasks.splitBacklog("claude", { id: plain.id, revision: 0, parts: GOOD.parts, reason: "split" });
  for (const child of ordinary.children) expect(r.board.get(child.id)!.draft).toBeUndefined();
});

test("a planner that is not reachable leaves the draft to the hub model", async () => {
  const r = await rig({ planner: true, answer: JSON.stringify(GOOD) });
  await r.planner.stop();
  const result = await r.tasks.intake(USER, { text: "prepare the Q3 report" });
  expect(result.split).toBe("hub");
  expect(r.planner.got.filter(env => env.refs?.task === String(result.draft.id))).toEqual([]);
});

// ---- without a planner: the hub model

test("without a planner the hub model's JSON is validated, written through Tasks and its children are drafts", async () => {
  const r = await rig({ answer: "```json\n" + JSON.stringify(GOOD) + "\n```" });
  const result = await r.tasks.intake(USER, { text: "prepare the Q3 report from these files", sources: [SRC] });
  expect(result.split).toBe("hub");
  expect(result.children).toHaveLength(2);
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0]!.campusOnly).toBe(false);
  expect(r.calls[0]!.system).toContain("DATA");
  expect(JSON.parse(r.calls[0]!.user)).toEqual({ request: "prepare the Q3 report from these files", sources: [SRC] });
  const parent = r.board.get(result.draft.id)!;
  expect(parent).toMatchObject({ draft: true, state: "backlog" });
  expect(parent.deps).toEqual(result.children.map(child => child.id));
  for (const child of result.children) expect(r.board.get(child.id)).toMatchObject({ draft: true, state: "backlog" });
  expect(r.board.get(result.children[0]!.id)!.detail).toContain("AC1");
  expect(parent.history.at(-1)).toMatchObject({ by: "hub", planning: { split: { children: expect.any(Array) } } });
  expect(await refusal(() => r.tasks.moveBacklog(USER, result.children[0]!.id, true))).toContain("intake draft");
});

test("invalid model output leaves the draft unsplit, with the reason on its history and nothing written", async () => {
  const cases: [string | undefined, string][] = [
    [undefined, "the model gave no answer"],
    ["I cannot help with that.", "not a JSON split"],
    [JSON.stringify({ parts: [GOOD.parts[0]] }), "at least 2"],
    [JSON.stringify({ parts: [{ ...GOOD.parts[0], extra: 1 }, GOOD.parts[1]] }), "parts[0]: an unexpected property"],
    [JSON.stringify({ parts: [{ title: "a", detail: "no criteria" }, GOOD.parts[1]] }), "no acceptance criteria"],
    [JSON.stringify({ parts: [{ ...GOOD.parts[0], class: "nonsense" }, GOOD.parts[1]] }), "refused"],
  ];
  for (const [answer, reason] of cases) {
    const r = await rig({ answer });
    const before = r.board.list().length;
    const result = await r.tasks.intake(USER, { text: "prepare the Q3 report" });
    expect(result.split, reason).toBe("unsplit");
    expect(result.reason, reason).toContain(reason);
    expect(result.children).toEqual([]);
    expect(r.board.list().length - before).toBe(1);
    const draft = r.board.get(result.draft.id)!;
    expect(draft).toMatchObject({ draft: true, state: "backlog" });
    expect(draft.deps ?? []).toEqual([]);
    expect(draft.history.at(-1)).toMatchObject({ by: "hub", event: "intake unsplit", note: expect.stringContaining(reason) });
  }
});

test("a reason never carries anything the model wrote: a secret property name, value, class or source is absent from the reason and from the draft's whole history", async () => {
  const SECRET = "PRIVATE_PAYLOAD_9f3c";
  const bad: [string, string][] = [
    ["a property NAME", JSON.stringify({ parts: [{ ...GOOD.parts[0], [SECRET]: "x" }, GOOD.parts[1]] })],
    ["a nested property name", JSON.stringify({ parts: [{ ...GOOD.parts[0], plan: { [SECRET]: ["x"] } }, GOOD.parts[1]] })],
    ["a property value", JSON.stringify({ parts: [{ ...GOOD.parts[0], title: 5, detail: SECRET }, GOOD.parts[1]] })],
    ["a class", JSON.stringify({ parts: [{ ...GOOD.parts[0], class: SECRET }, GOOD.parts[1]] })],
    ["a source id", JSON.stringify({ parts: [{ ...GOOD.parts[0], plan: { sources: [SECRET] } }, GOOD.parts[1]] })],
    ["prose around invalid JSON", `Sure! ${SECRET} {"parts": [`],
    ["a top-level key", JSON.stringify({ [SECRET]: [GOOD.parts[0]], parts: [GOOD.parts[0]] })],
    ["an array of bad parts", JSON.stringify([{ title: "", detail: SECRET }, SECRET])],
  ];
  for (const [what, answer] of bad) {
    const r = await rig({ answer });
    const result = await r.tasks.intake(USER, { text: "ordinary request" });
    expect(result.split, what).toBe("unsplit");
    expect(result.reason, what).toBeDefined();
    expect(result.reason, `${what}: reason`).not.toContain(SECRET);
    const draft = r.board.get(result.draft.id)!;
    expect(JSON.stringify(draft.history), `${what}: history`).not.toContain(SECRET);
    expect(JSON.stringify(r.tasks.publicView(draft, true)), `${what}: public view`).not.toContain(SECRET);
    expect(JSON.stringify(r.board.list()), `${what}: nothing on the board`).not.toContain(SECRET);
  }
});

test("an error thrown by the board while writing the split is reduced to fixed text in the reason and the history", async () => {
  const r = await rig({ answer: JSON.stringify(GOOD) });
  r.board.splitBacklog = () => { throw new Error("SQLITE_CONSTRAINT: PRIVATE_PAYLOAD_9f3c in table tasks"); };
  const result = await r.tasks.intake(USER, { text: "ordinary request" });
  expect(result).toMatchObject({ split: "unsplit", reason: "the split was refused: the board refused it" });
  expect(JSON.stringify(r.board.get(result.draft.id)!.history)).not.toContain("PRIVATE_PAYLOAD");
});

test("a schema-owned property keeps a useful path in the reason, and a refusal from the board carries only fixed text", async () => {
  expect(schemaError(PARTS_SCHEMA, [{ detail: "no title" }, GOOD.parts[0]])).toBe("parts[0].title: required");
  expect(schemaError(PARTS_SCHEMA, [{ title: "x", afterParts: [-1] }, GOOD.parts[0]])).toBe("parts[0].afterParts[0]: too small");
  expect(schemaError(PARTS_SCHEMA, [{ title: "x", plan: { paths: "a" } }, GOOD.parts[0]])).toBe("parts[0].plan.paths: expected an array");
  const r = await rig({ answer: JSON.stringify({ parts: [{ ...GOOD.parts[0], class: "nonsense" }, GOOD.parts[1]] }) });
  const result = await r.tasks.intake(USER, { text: "ordinary request" });
  expect(result.reason).toMatch(/^the split was refused: class must be one of /); // the profile's own class names, from config
  expect(result.reason).not.toContain("nonsense");
});

test("a throwing model or a missing model leaves the draft unsplit", async () => {
  const thrown = await rig({ answer: () => { throw new Error("gateway down"); } });
  expect((await thrown.tasks.intake(USER, { text: "x request" })).split).toBe("unsplit");
  const none = await rig({ noModel: true });
  const result = await none.tasks.intake(USER, { text: "x request" });
  expect(result).toMatchObject({ split: "unsplit", reason: expect.stringContaining("no model") });
  expect(none.board.get(result.draft.id)!.draft).toBe(true);
});

test("the hub's own split write is not a planner write: a HUB split outside intake is still refused", async () => {
  const r = await rig({ answer: JSON.stringify(GOOD) });
  const draft = (await r.tasks.intake(USER, { text: "x request" })).draft;
  const plain = r.board.propose(USER, { title: "plain", class: "plan", backlog: true });
  expect(await refusal(() => r.tasks.splitBacklog("hub", { id: plain.id, revision: 0, parts: GOOD.parts, reason: "x" }))).toContain("planner");
  expect(await refusal(() => r.tasks.splitBacklog("codex", { id: draft.id, revision: 1, parts: GOOD.parts, reason: "x" }, { intake: true }))).toContain("planner");
});

// ---- sources

test("--source ids are validated: unknown, malformed, duplicate and too many are refused before a draft is made", async () => {
  const r = await rig();
  const count = () => r.board.list().length;
  expect(await refusal(() => r.tasks.intake(USER, { text: "x request", sources: [OTHER] }))).toContain("unknown source");
  expect(await refusal(() => r.tasks.intake(USER, { text: "x request", sources: ["src:xyz"] }))).toContain("sources:");
  expect(await refusal(() => r.tasks.intake(USER, { text: "x request", sources: [SRC, SRC] }))).toContain("sources:");
  expect(await refusal(() => r.tasks.intake(USER, { text: "x request", sources: "src:0123456789abcdef" }))).toContain("sources:");
  expect(await refusal(() => r.tasks.intake(USER, { text: "x request", sources: Array.from({ length: 17 }, (_, i) => `src:${i.toString(16).padStart(16, "0")}`) }))).toContain("sources:");
  expect(count()).toBe(0);
  const ok = await r.tasks.intake(USER, { text: "x request", sources: [SRC] });
  expect(parseIntakeDetail(r.board.get(ok.draft.id)!.detail).sources).toEqual([SRC]);
});

test("the request must be 1 to 7000 characters", async () => {
  const r = await rig();
  for (const text of ["", "   ", undefined, 5, "x".repeat(7001)]) await refusal(() => r.tasks.intake(USER, { text }));
  expect(r.board.list()).toHaveLength(0);
  expect((await r.tasks.intake(USER, { text: "x".repeat(7000) })).draft.draft).toBe(true);
});

// ---- PII

test("a PII request never goes to a planner peer and, off campus, stays whole for the person", async () => {
  const r = await rig({ planner: true, pii: true, answer: JSON.stringify(GOOD), onCampus: false });
  const result = await r.tasks.intake(USER, { text: "prepare the file for SECRET-STUDENT" });
  expect(r.tasks.isPii(r.board.get(result.draft.id)!)).toBe(true);
  expect(result.split).toBe("unsplit");
  expect(result.reason).toContain("PII");
  expect(r.calls).toEqual([]);
  expect(r.planner.got.filter(env => env.refs?.task === String(result.draft.id) || env.body.includes("SECRET-STUDENT"))).toEqual([]);
  expect(r.tasks.publicView(r.board.get(result.draft.id)!)).toMatchObject({ title: "[pii]", detail: "[pii]" });
});

test("a PII request on campus is split by the on-prem model and the hub writes private drafts", async () => {
  const r = await rig({ planner: true, pii: true, answer: JSON.stringify({ parts: [
    { title: "Pull SECRET-STUDENT records", detail: "AC1: records pulled", class: "plan" },
    { title: "Write the summary", detail: "AC1: summary written", class: "implement", afterParts: [0] },
  ] }), onCampus: true });
  const result = await r.tasks.intake(USER, { text: "prepare the file for SECRET-STUDENT" });
  expect(result.split).toBe("hub");
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0]!.campusOnly).toBe(true); // transport itself refuses the Access endpoint for a private request
  expect(r.planner.got.filter(env => env.body.includes("SECRET-STUDENT") || env.refs?.task === String(result.draft.id))).toEqual([]);
  for (const child of result.children) {
    const stored = r.board.get(child.id)!;
    expect(stored.draft).toBe(true);
    expect(r.tasks.isPii(stored)).toBe(true);
    expect(r.tasks.publicView(stored)).toMatchObject({ title: "[pii]", detail: "[pii]" });
  }
});

test("an ordinary request with a PII source word in the hub note never reaches the history unredacted", async () => {
  const r = await rig({ pii: true, answer: JSON.stringify({ parts: [GOOD.parts[0]] }) });
  const result = await r.tasks.intake(USER, { text: "ordinary request" });
  expect(result.reason).toContain("at least 2");
  expect(JSON.stringify(r.board.get(result.draft.id)!.history)).not.toContain("SECRET-STUDENT");
});

test("Inference.split asks transport to refuse the Access endpoint only for a private request", async () => {
  const seen: unknown[] = [];
  const omni = { base: async () => "http://gateway/v1", chat: async (_body: unknown, opts: unknown) => { seen.push(opts); return { message: { role: "assistant", content: "{}" } }; } } as unknown as OmniRoute;
  const inference = new Inference(DEFAULT_INFERENCE, { omni, fixedModel: () => "m", log: () => {} });
  await inference.split("s", "u");
  await inference.split("s", "u", { campusOnly: false });
  await inference.split("s", "u", { campusOnly: true });
  expect(seen.map(opts => (opts as { onCampusOnly?: boolean }).onCampusOnly)).toEqual([undefined, undefined, true]);
});

// ---- approve and discard

test("an approval that lands while the hub's split is inside its screening await wins: no child is created, and none is left undrafted", async () => {
  const releases: (() => void)[] = []; let calls = 0;
  // the first screen call is the request's own (at propose) and passes; every later one is the split's screen of a part or of its reason, and is held
  const r = await rig({ answer: JSON.stringify(GOOD), screen: () => ++calls === 1 ? Promise.resolve() : new Promise<void>(resolve => { releases.push(resolve); }) });
  const running = r.tasks.intake(USER, { text: "prepare the Q3 report" });
  const waitFor = async (condition: () => boolean, label: string) => { const end = Date.now() + 3000; while (!condition() && Date.now() < end) await Bun.sleep(5); expect(condition(), label).toBe(true); };
  await waitFor(() => releases.length >= 3, "the hub's split is inside its screening await (two parts and its reason)");
  const draft = r.board.list().find(task => task.draft)!;
  const approved = await r.tasks.approveIntake(USER, draft.id); // the person approves the one card they saw
  expect(approved.map(task => task.id)).toEqual([draft.id]);
  for (const release of releases) release();
  const result = await running;
  expect(result.split).toBe("unsplit"); expect(result.children).toEqual([]);
  expect(result.reason).toContain("refused");
  expect(r.board.list(), "no child was created").toHaveLength(1);
  expect(r.board.get(draft.id)).toMatchObject({ state: "backlog" }); expect(r.board.get(draft.id)!.draft).toBeUndefined();
  expect(r.board.get(draft.id)!.deps ?? []).toEqual([]);
});

test("each layer holds on its own: Tasks refuses a HUB intake split of a parent that is no longer a draft before the board is asked, and the board refuses when Tasks is bypassed", async () => {
  const r = await rig({ answer: JSON.stringify(GOOD) });
  const { draft } = await r.tasks.intake(USER, { text: "prepare the Q3 report" });
  await r.tasks.approveIntake(USER, draft.id);
  const revision = r.board.get(draft.id)!.planningRevision ?? 0;
  const asked: boolean[] = [];
  const original = r.board.splitBacklog.bind(r.board);
  r.board.splitBacklog = ((...args: Parameters<typeof original>) => { asked.push(true); return original(...args); }) as typeof original;
  // Tasks layer: refused before any board call, so nothing reaches the transaction
  await expect(r.tasks.splitBacklog("hub", { id: draft.id, revision, parts: GOOD.parts, reason: "x" }, { intake: true })).rejects.toThrow("split changed, pinned or already started");
  expect(asked, "Tasks refused it before the board was asked").toEqual([]);
  // board layer: the flag Tasks sets for exactly the hub's intake write is honoured by the transaction
  r.board.requireDraftForNextSplit = true;
  expect(() => r.board.splitBacklog(draft.id, "hub", revision, GOOD.parts as never, "x")).toThrow("split changed or invalid");
  // and Tasks sets it: a live draft's intake split through Tasks reaches the board with the requirement on
  const fresh = (await r.tasks.intake(USER, { text: "another request" })).draft;
  const seen: boolean[] = [];
  r.board.splitBacklog = ((...args: Parameters<typeof original>) => { seen.push(r.board.requireDraftForNextSplit); return original(...args); }) as typeof original;
  await r.tasks.splitBacklog("hub", { id: fresh.id, revision: r.board.get(fresh.id)!.planningRevision ?? 0, parts: GOOD.parts, reason: "x" }, { intake: true });
  expect(seen, "Tasks turned the requirement on for the hub's intake write").toEqual([true]);
  // a planner's split of an ordinary card does not turn it on
  const plain = r.board.propose(USER, { title: "plain", class: "plan", backlog: true });
  seen.length = 0;
  await r.tasks.splitBacklog("hub", { id: plain.id, revision: 0, parts: GOOD.parts, reason: "x" }, { intake: true }).catch(() => undefined);
  const viaPlanner = await rig({ planner: true });
  const card = viaPlanner.board.propose(USER, { title: "plain", class: "plan", backlog: true });
  const flags: boolean[] = [];
  const orig2 = viaPlanner.board.splitBacklog.bind(viaPlanner.board);
  viaPlanner.board.splitBacklog = ((...args: Parameters<typeof orig2>) => { flags.push(viaPlanner.board.requireDraftForNextSplit); return orig2(...args); }) as typeof orig2;
  await viaPlanner.tasks.splitBacklog("claude", { id: card.id, revision: 0, parts: GOOD.parts, reason: "x" });
  expect(flags).toEqual([false]);
});

test("the board refuses an intake split of a parent that is no longer a draft, whatever the planning revision says", async () => {
  const r = await rig();
  const { draft } = await r.tasks.intake(USER, { text: "prepare the Q3 report" });
  await r.tasks.approveIntake(USER, draft.id);
  const revision = r.board.get(draft.id)!.planningRevision ?? 0;
  expect(revision, "an approval does not move the planning revision").toBe(draft.planningRevision ?? 0);
  const parts = GOOD.parts.map(part => ({ ...part, afterParts: undefined }));
  r.board.requireDraftForNextSplit = true;
  expect(() => r.board.splitBacklog(draft.id, "hub", revision, parts as never, "x")).toThrow("split changed or invalid");
  expect(r.board.requireDraftForNextSplit, "the flag is spent by the call").toBe(false);
  expect(r.board.get(draft.id)!.deps ?? []).toEqual([]);
  // an ordinary split by a planner is unaffected
  r.board.requireDraftForNextSplit = false;
  expect(r.board.splitBacklog(draft.id, "hub", revision, parts as never, "x").children).toHaveLength(2);
});

test("a planner that splits an intake child again leaves no grandchild behind: approve and discard take the whole tree", async () => {
  for (const op of ["approve", "discard"] as const) {
    const r = await rig({ planner: true });
    const { draft } = await r.tasks.intake(USER, { text: "prepare the Q3 report" });
    const first = await r.tasks.splitBacklog("claude", { id: draft.id, revision: draft.planningRevision ?? 0, parts: GOOD.parts, reason: "split the request" });
    const child = r.board.get(first.children[1]!.id)!;
    const second = await r.tasks.splitBacklog("claude", { id: child.id, revision: child.planningRevision ?? 0, parts: GOOD.parts, reason: "split the child again" });
    const tree = [draft.id, ...first.children.map(task => task.id), ...second.children.map(task => task.id)];
    for (const task of second.children) expect(r.board.get(task.id)!.draft).toBe(true);
    // an ordinary card the draft depends on is not part of the family
    const outside = r.board.propose(USER, { title: "ordinary prerequisite", class: "plan", backlog: true });
    r.board.plan(draft.id, USER, { deps: [...(r.board.get(draft.id)!.deps ?? []), outside.id] }, r.board.get(draft.id)!.planningRevision ?? 0, "depend on outside");
    const changed = await (op === "approve" ? r.tasks.approveIntake(USER, draft.id) : r.tasks.discardIntake(USER, draft.id));
    expect(changed.map(task => task.id).sort((a, b) => a - b)).toEqual([...tree].sort((a, b) => a - b));
    for (const id of tree) expect(op === "approve" ? r.board.get(id)!.draft : r.board.get(id)!.state).toBe(op === "approve" ? undefined : "cancelled");
    expect(r.board.get(outside.id)).toMatchObject({ state: "backlog" });
  }
});

test("approve is the person's, clears draft on the parent and every child, and then the normal pull works", async () => {
  const r = await rig({ answer: JSON.stringify(GOOD) });
  const result = await r.tasks.intake(USER, { text: "prepare the Q3 report" });
  const ids = [result.draft.id, ...result.children.map(child => child.id)];
  for (const by of ["claude", "codex", "hub"]) expect(await refusal(() => r.tasks.approveIntake(by, result.draft.id))).toContain("console command");
  for (const id of ids) expect(r.board.get(id)!.draft).toBe(true);
  const approved = await r.tasks.approveIntake(USER, result.draft.id);
  expect(approved.map(task => task.id)).toEqual(ids);
  for (const id of ids) {
    const task = r.board.get(id)!;
    expect(task.draft).toBeUndefined(); expect(task.state).toBe("backlog");
    expect(task.history.at(-1)).toMatchObject({ by: USER, event: "draft approved" });
  }
  expect((await r.tasks.moveBacklog(USER, result.children[0]!.id, true)).state).toBe("proposed");
  expect(await refusal(() => r.tasks.approveIntake(USER, result.draft.id))).toContain("not an open intake draft");
});

test("approve is all or nothing: a child that already moved fails the whole approval", async () => {
  const r = await rig({ answer: JSON.stringify(GOOD) });
  const result = await r.tasks.intake(USER, { text: "prepare the Q3 report" });
  expect(() => r.board.approveDrafts([result.draft.id, 99999], USER, "x")).toThrow("draft changed");
  expect(r.board.get(result.draft.id)!.draft).toBe(true);
  for (const child of result.children) expect(r.board.get(child.id)!.draft).toBe(true);
});

test("approve and discard refuse an ordinary backlog card and unknown ids", async () => {
  const r = await rig();
  const plain = r.board.propose(USER, { title: "plain", class: "plan", backlog: true });
  for (const call of [() => r.tasks.approveIntake(USER, plain.id), () => r.tasks.discardIntake(USER, plain.id), () => r.tasks.approveIntake(USER, 999), () => r.tasks.discardIntake(USER, 999)]) expect(await refusal(call)).toContain("not an open intake draft");
  for (const id of [0, -1, 1.5, "3", undefined]) expect(await refusal(() => r.tasks.approveIntake(USER, id))).toContain("positive task number");
  expect(r.board.get(plain.id)).toMatchObject({ state: "backlog" });
});

test("discard cancels the parent and every child through Tasks.cancel, and only the person may", async () => {
  const r = await rig({ answer: JSON.stringify(GOOD) });
  const result = await r.tasks.intake(USER, { text: "prepare the Q3 report" });
  for (const by of ["claude", "codex", "hub"]) expect(await refusal(() => r.tasks.discardIntake(by, result.draft.id))).toContain("console command");
  const cancelled = await r.tasks.discardIntake(USER, result.draft.id);
  expect(cancelled).toHaveLength(3);
  for (const task of cancelled) {
    expect(r.board.get(task.id)).toMatchObject({ state: "cancelled" });
    expect(r.board.get(task.id)!.history.at(-1)).toMatchObject({ event: "cancelled", by: USER, note: expect.stringContaining("discarded") });
  }
  expect(await refusal(() => r.tasks.discardIntake(USER, result.draft.id))).toContain("not an open intake draft");
});

test("an unsplit draft can be approved or discarded alone", async () => {
  const a = await rig();
  const one = await a.tasks.intake(USER, { text: "x request" });
  expect((await a.tasks.approveIntake(USER, one.draft.id)).map(task => task.id)).toEqual([one.draft.id]);
  const b = await rig();
  const two = await b.tasks.intake(USER, { text: "x request" });
  expect((await b.tasks.discardIntake(USER, two.draft.id)).map(task => task.id)).toEqual([two.draft.id]);
});

test("the draft column survives a reopen and an old database without it gets it", async () => {
  const r = await rig({ answer: JSON.stringify(GOOD) });
  const result = await r.tasks.intake(USER, { text: "prepare the Q3 report" });
  const path = (r.board as any).db.filename as string;
  const again = new Board(path);
  try {
    expect(again.get(result.draft.id)).toMatchObject({ draft: true });
    for (const child of result.children) expect(again.get(child.id)).toMatchObject({ draft: true });
  } finally { again.close(); }
});

// ---- the command

test("intake is person-only: an agent shell is refused, live-test cannot write it, and the audit never names the request", () => {
  for (const args of [["a request"], ["discard", "3"], ["a request", "--source", SRC]]) expect(classifyPeerCommand("intake", args)).toBe("console");
  expect(classifyPeerCommand("intake", ["approve", "3"])).toBe("conductor"); // #933: the daemon admits only the configured conductor
  expect(liveTestRefusal("intake", ["a request"])).toBe(true);
  expect(cliCommandLabel("intake", ["approve", "3"])).toBe("intake approve");
  expect(cliCommandLabel("intake", ["discard", "3"])).toBe("intake discard");
  expect(cliCommandLabel("intake", ["my SECRET-STUDENT request"])).toBe("intake");
});

test("ahub help documents intake with its flags and subcommands, and the command is in the dispatch table", () => {
  const entry = HELP.find(item => helpCommands(item).includes("intake"));
  expect(entry).toBeDefined();
  expect(entry!.usage).toBe("ahub intake \"<text>\" [--source <id>...] | approve <id> | discard <id> [--json] [--color=auto|always|never]");
  for (const word of ["person only", "draft backlog card", "hub_backlog_split", "never to a planner", "registered src:", "task cancel"]) expect(entry!.description, word).toContain(word);
  expect(renderHelp(100, false, "intake").replace(/\s+/g, " ")).toContain("ahub intake");
  const src = readFileSync(join(import.meta.dir, "../src/cli/main.ts"), "utf8"), at = src.indexOf("const commands: Record<");
  expect(src.slice(at, src.indexOf("\n};\n", at))).toMatch(/^  intake: /m);
});

test("the human output names the draft, who splits it, the reason and the next commands", () => {
  const text = (lines: { text: string }[][]) => lines.map(line => line.map(span => span.text).join("")).join("\n");
  const draft = { id: 7, title: "Intake: prepare", state: "backlog" };
  const planner = text(renderIntake({ draft, children: [], split: "planner" }, 100));
  expect(planner).toContain("Intake draft #7"); expect(planner).toContain("asked the planner"); expect(planner).toContain("ahub intake approve 7"); expect(planner).toContain("ahub intake discard 7");
  const hub = text(renderIntake({ draft, children: [{ id: 8, class: "plan", title: "Part one" }, { id: 9, class: "implement", deps: [8], title: "Part two" }], split: "hub" }, 100));
  expect(hub).toContain("2 draft parts"); expect(hub).toContain("#9"); expect(hub).toContain("#8");
  const unsplit = text(renderIntake({ draft, children: [], split: "unsplit", reason: "the model gave no answer" }, 100));
  expect(unsplit).toContain("left whole"); expect(unsplit).toContain("the model gave no answer");
  expect(text(renderIntakeChange("approve", [{ id: 7, state: "backlog", title: "t" }], 100))).toContain("Intake approved: 1 card released");
  expect(text(renderIntakeChange("discard", [{ id: 7, state: "cancelled", title: "t" }, { id: 8, state: "cancelled", title: "u" }], 100))).toContain("Intake discarded: 2 cards cancelled");
});
