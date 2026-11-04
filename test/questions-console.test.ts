import { expect, test } from "bun:test";
import { needs, summarizeNeeds } from "../src/ui/needs.ts";
import { parseNeedsSummary } from "../src/cli/pet.ts";
import { consoleNeeds, attentionCommand } from "../src/cli/attention.ts";
import { initialConsoleState, reduceConsole, renderConsoleLines, paint, keyTable, type ConsoleState } from "../src/cli/console-state.ts";
import { questionRows, startFlow, stepFlow, type QuestionView } from "../src/cli/console-question.ts";
import { parseAnswerArgs } from "../src/cli/answer-args.ts";
import { HELP, helpCommands } from "../src/cli/help.ts";
import { classifyPeerCommand, cliCommandLabel } from "../src/cli/identity.ts";

// #1053 T4: the question need, `ahub answer`, and the console's decision keys. The daemon-backed legs are in questions-console-daemon.test.ts.
const now = 1000;
const opt = (id: string, label = id) => ({ id, label });
const row = (set = "qs-aaaaaaaaaaaa", created = 10): QuestionView => ({ set, peer: "codex", created, questions: [
  { id: "db", prompt: "Which database?", options: [opt("pg", "Postgres"), opt("sqlite", "SQLite")] },
  { id: "extras", prompt: "Which extras?", options: [opt("a"), opt("b"), opt("c")], multi: true, allowOther: true },
] });
const lines = (state: ConsoleState, columns = 120) => renderConsoleLines(state, columns, 30).map(line => paint(line, false)).join("\n");

test("a question is an act need that waits for the person, ranks after approvals and defaults, and carries ids only", () => {
  const result = needs({ approvals: [{ id: "perm", peer: "kimi", expiresAt: 5000 }], questions: [{ set: "qs-bbbbbbbbbbbb", peer: "codex", since: 20 }, { set: "qs-aaaaaaaaaaaa", peer: "pi", since: 10 }], storageBlocked: true }, now);
  expect(result.items.map(item => item.kind)).toEqual(["approval", "question", "question", "storage"]);
  expect(result.items.filter(item => item.kind === "question").map(item => item.id)).toEqual(["qs-aaaaaaaaaaaa", "qs-bbbbbbbbbbbb"]);
  expect(result.state).toBe("waiting");
  expect(needs({ questions: [{ set: "qs-aaaaaaaaaaaa", peer: "codex", since: 1 }] }, now)).toMatchObject({ act: 1, watch: 0, state: "waiting" });
  expect(needs({ questions: [] }, now).state).toBe("sleeping");
  // viewing never clears it: the same input answers the same, and a malformed set is not a need
  const input = { questions: [{ set: "qs-aaaaaaaaaaaa", peer: "codex" }] };
  expect(needs(input, now)).toEqual(needs(input, now + 999_999));
  expect(needs({ questions: [{ set: "bad set with spaces", peer: "codex" }] }, now).items).toEqual([]);
  for (const item of needs({ questions: [{ set: "qs-aaaaaaaaaaaa", peer: "codex", since: 3, prompt: "SECRET" } as never] }, now).items) expect(Object.keys(item).every(key => ["kind", "level", "peer", "id", "until", "since"].includes(key))).toBe(true);
  expect(summarizeNeeds({ questions: [{ set: "qs-aaaaaaaaaaaa", peer: "codex" }] }, now)).toMatchObject({ act: 1, state: "waiting", first: { kind: "question", level: "act", id: "qs-aaaaaaaaaaaa" } });
});

test("the pet and status parsers accept a waiting question and still refuse an inconsistent summary", () => {
  const summary = { act: 1, watch: 0, state: "waiting", first: { kind: "question", level: "act", peer: "codex", id: "qs-aaaaaaaaaaaa", since: 5 } };
  expect(parseNeedsSummary(summary)).toMatchObject({ state: "waiting", first: { kind: "question" } });
  expect(parseNeedsSummary({ ...summary, state: "blocked" })).toBeUndefined();
  expect(parseNeedsSummary({ ...summary, first: { ...summary.first, level: "watch" } })).toBeUndefined();
});

test("the console's attention model sees only the set, the peer and the time of an open question, and names where to answer", () => {
  const state = { ...initialConsoleState(true), petEnabled: true, questions: [row("qs-aaaaaaaaaaaa", 7)] };
  const model = consoleNeeds(state, now);
  expect(model.items).toEqual([{ kind: "question", level: "act", peer: "codex", id: "qs-aaaaaaaaaaaa", since: 7 }]);
  expect(JSON.stringify(model)).not.toContain("Which database");
  expect(attentionCommand(model.items[0]!)).toContain("ahub answer qs-aaaaaaaaaaaa");
  // `n` on a question opens the answer flow for exactly that set, and acts on nothing else
  const next = reduceConsole(state, "n", now);
  expect(next.effects).toEqual([]);
  expect(next.state.questionFlow?.set).toBe("qs-aaaaaaaaaaaa");
});

test("A answers the oldest open question key by key: a digit picks, multi toggles, o types other text, and the last answer is sent once", () => {
  let state: ConsoleState = { ...initialConsoleState(false), questions: [row("qs-bbbbbbbbbbbb", 20), row("qs-aaaaaaaaaaaa", 10)] };
  state.questions = questionRows(state.questions);
  expect(state.questions[0]!.set).toBe("qs-aaaaaaaaaaaa"); // oldest first
  const press = (key: string) => { const out = reduceConsole(state, key, now); state = out.state; return out.effects; };
  expect(press("A")).toEqual([]);
  expect(state.questionFlow?.set).toBe("qs-aaaaaaaaaaaa");
  expect(lines(state)).toContain("codex asks 1/2: Which database?");
  expect(press("2")).toEqual([]); // single choice moves on
  expect(lines(state)).toContain("codex asks 2/2: Which extras?");
  expect(press("1")).toEqual([]); expect(press("3")).toEqual([]); expect(press("1")).toEqual([]); // a on, c on, a off
  expect(lines(state)).toContain("3* c");
  expect(press("o")).toEqual([]);
  for (const key of "fine") press(key);
  expect(lines(state)).toContain("other: fine_");
  const effects = press("\r");
  expect(effects).toEqual([{ type: "answer", set: "qs-aaaaaaaaaaaa", answers: [{ questionId: "db", optionIds: ["sqlite"] }, { questionId: "extras", optionIds: ["c"], other: "fine" }] }]);
  expect(state.questionFlow).toBeUndefined();
});

test("Esc leaves the flow and the question stays open; a key that is not offered changes nothing; a closed set ends the flow with a notice", () => {
  let state: ConsoleState = { ...initialConsoleState(false), questions: [row()] };
  const press = (key: string) => { const out = reduceConsole(state, key, now); state = out.state; return out.effects; };
  press("A"); press("9");
  expect(state.questionFlow?.index).toBe(0);
  expect(press("\x1b")).toEqual([]);
  expect(state.questionFlow).toBeUndefined();
  expect(state.questions).toHaveLength(1);
  press("A"); state = { ...state, questions: [] };
  expect(press("1")).toEqual([]);
  expect(state.questionFlow).toBeUndefined();
  expect(state.notice).toContain("no longer open");
  expect(press("A")).toEqual([]);
  expect(state.notice).toContain("no open question");
});

test("other text is bounded and a multi question needs at least one pick before Enter", () => {
  const view = row();
  let flow = startFlow(view);
  flow = stepFlow(flow, view, "1").flow!; // db answered
  expect(stepFlow(flow, view, "\r").flow?.index).toBe(1); // nothing picked: Enter does nothing
  flow = stepFlow(flow, view, "o").flow!;
  for (let i = 0; i < 600; i++) flow = stepFlow(flow, view, "x").flow!;
  expect(Array.from(flow.typing!).length).toBe(500);
  expect(stepFlow(flow, view, "\x7f").flow!.typing!.length).toBe(499);
});

test("parseAnswerArgs builds the answers the hub validates and refuses a malformed line before any request", () => {
  expect(parseAnswerArgs(["qs-0123456789ab", "db=pg", "extras=a,b", "--other", "and more"])).toEqual({ ok: false, error: expect.stringContaining("several questions") });
  expect(parseAnswerArgs(["qs-0123456789ab", "db=pg", "extras=a,b", "--other", "extras=and more"])).toEqual({ ok: true, value: { set: "qs-0123456789ab", answers: [{ questionId: "db", optionIds: ["pg"] }, { questionId: "extras", optionIds: ["a", "b"], other: "and more" }] } });
  expect(parseAnswerArgs(["qs-0123456789ab", "extras=", "--other=just text"])).toEqual({ ok: true, value: { set: "qs-0123456789ab", answers: [{ questionId: "extras", optionIds: [], other: "just text" }] } });
  for (const bad of [[], ["db=pg"], ["qs-0123456789ab"], ["qs-0123456789ab", "pg"], ["qs-0123456789ab", "db=pg", "db=sqlite"], ["qs-0123456789ab", "db=p g"], ["qs-0123456789ab", "db=pg", "--other"], ["qs-0123456789ab", "db=pg", "--nope"], ["qs-0123456789ab", "db=pg", "--other", "a", "--other", "b"]])
    expect(parseAnswerArgs(bad).ok, JSON.stringify(bad)).toBe(false);
});

test("ahub help documents answer, the dispatch table has it, and an agent shell is refused the command", () => {
  const entry = HELP.find(item => helpCommands(item).includes("answer"));
  expect(entry?.section).toBe("Messages and approvals");
  expect(entry?.usage).toContain("<question>=<option>");
  expect(classifyPeerCommand("answer", ["qs-0123456789ab", "db=pg"])).toBe("console");
  expect(classifyPeerCommand("answer", [])).toBe("console");
  expect(cliCommandLabel("answer", ["qs-0123456789ab", "db=SECRET"])).toBe("answer"); // the audit never names a set or an option
  expect(keyTable(120).flat().map(span => span.text).join(" ")).toContain("A answer");
});

test("the running console reads questions only from a hub that lists the feature, announces a new one once, and sends A's answer as the console's own", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { runConsole } = await import("../src/cli/console.ts");
  for (const feature of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "ahub-q-console-")); mkdirSync(join(root, ".agenthub"));
    let output = "", key = (_value: string) => {}, stop = () => {};
    const terminal = { columns: 120, rows: 40, isTTY: true, write: (text: string) => { output += text; }, raw: () => {}, onData: (fn: (value: string) => void) => { key = fn; return () => {}; }, onSignal: (fn: () => void) => { stop = fn; return () => {}; }, onResize: () => () => {} };
    const sent: Record<string, unknown>[] = [];
    let open = true;
    const client = { request: async (m: Record<string, unknown>) => {
      sent.push(m);
      if (m.t === "status") return { ok: true, status: { features: feature ? ["questions"] : [], peers: {}, tasks: {} } };
      if (m.t === "questions") return { ok: true, questions: open ? [row("qs-aaaaaaaaaaaa", 5)] : [] };
      if (m.t === "answer") { open = false; return { ok: true, questionSet: m.questionSet, state: "answered" }; }
      return {};
    }, send: () => {}, close: () => {}, onPush: () => {}, onClose: () => {} };
    const running = runConsole({ cwd: root, stateDir: root, terminal, client: client as never, color: false });
    try {
      await Bun.sleep(30);
      expect(sent.some(m => m.t === "questions")).toBe(feature);
      if (!feature) { key("A"); await Bun.sleep(10); expect(output).toContain("no open question"); continue; }
      key("A"); await Bun.sleep(10);
      expect(output).toContain("codex asks 1/2: Which database?");
      key("2"); key("1"); key("\r"); await Bun.sleep(40);
      expect(sent.filter(m => m.t === "answer")).toEqual([{ t: "answer", surface: "console", questionSet: "qs-aaaaaaaaaaaa", answers: [{ questionId: "db", optionIds: ["sqlite"] }, { questionId: "extras", optionIds: ["a"] }] }]);
      expect(output).toContain("answered qs-aaaaaaaaaaaa");
    } finally { stop(); await running; rmSync(root, { recursive: true, force: true }); }
  }
});
