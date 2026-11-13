import { expect, test } from "bun:test";
import { needs, summarizeNeeds } from "../src/ui/needs.ts";
import { parseNeedsSummary } from "../src/cli/pet.ts";
import { consoleNeeds, attentionCommand } from "../src/cli/attention.ts";
import { initialConsoleState, reduceConsole, renderConsoleLines, paint, keyTable, syncPermissionDefaults, type ConsoleState } from "../src/cli/console-state.ts";
import { pasteFlow, questionRows, startFlow, stepFlow, type QuestionFlow, type QuestionView } from "../src/cli/console-question.ts";
import { parseAnswerArgs } from "../src/cli/answer-args.ts";
import { HELP, helpCommands } from "../src/cli/help.ts";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";

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
  // stream mode has no body, so opening the flow prints the question and every numbered option into the stream, and each later part prints again; the footer holds only the keys
  const opened = press("A");
  expect(state.questionFlow?.set).toBe("qs-aaaaaaaaaaaa");
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ type: "print", text: "codex asks 1/2: Which database?\n  1 Postgres\n  2 SQLite" });
  expect(lines(state)).toContain("codex asks 1/2  number picks  Esc cancel");
  const moved = press("2");                                                      // single choice moves on
  expect(moved).toHaveLength(1);
  expect(moved[0]).toMatchObject({ type: "print", text: expect.stringContaining("codex asks 2/2: Which extras?") });
  expect(lines(state)).toContain("codex asks 2/2");
  expect(press("1")).toEqual([]); expect(press("3")).toEqual([]); expect(press("1")).toEqual([]); // a on, c on, a off
  expect(lines(state)).toContain("chosen 3");
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
  // a delegated `--live-test` run is promoted to console identity unless refused here: every invocation that answers is refused, a bare listing is not
  for (const args of [["qs-0123456789ab", "db=pg"], ["qs-0123456789ab", "db=pg", "--other", "text"], ["qs-0123456789ab", "extras=", "--other=text"], ["--other", "x"], ["qs-0123456789ab"], ["--json", "qs-0123456789ab", "db=pg"]]) expect(liveTestRefusal("answer", args), args.join(" ")).toBe(true);
  for (const args of [[], ["--json"], ["--color=never"], ["--json", "--color=always"]]) expect(liveTestRefusal("answer", args), args.join(" ")).toBe(false);
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

test("a refresh never opens a y/n default prompt while the question flow owns the keys, and the footer hint names only the keys that act for the question", () => {
  let state: ConsoleState = { ...initialConsoleState(false), questions: [row()] };
  const press = (key: string) => { const out = reduceConsole(state, key, now); state = out.state; return out.effects; };
  press("A");
  const defaults = [{ peer: "codex", mode: "never-ask", source: "/p/.agenthub/config.json" }];
  expect(syncPermissionDefaults(state, defaults)).toBe(false);
  expect(state.confirm).toBeUndefined();
  expect(lines(state)).toContain("codex asks 1/2");
  // the first question takes one option and no other text: its prompt offers neither "o other" nor "Enter done" (the prompt line replaces the footer hint while the flow is open)
  expect(lines(state)).toContain("number picks  Esc cancel");
  expect(lines(state)).not.toContain("o other");
  press("2");
  // the second is multi with other text: both keys act
  expect(lines(state)).toContain("o other  Enter done  Esc cancel");
  press("o");
  expect(lines(state)).toContain("Enter keeps  Esc back");
  // once the flow ends the default prompt is offered as before
  press("\x1b"); press("\x1b");
  expect(state.questionFlow).toBeUndefined();
  expect(syncPermissionDefaults(state, defaults)).toBe(true);
  expect(state.confirm).toMatchObject({ type: "permission_default", peer: "codex" });
});

// --- the three connector findings on the console flow -------------------------------------------------------------------------------------------------------------------------------

/** A question whose prompt and labels are as long as the contract allows (prompt 500, label 80): the worst case for a one-line footer. */
const long = (n: number) => `${"w".repeat(30)} ${"x".repeat(30)} ${"y".repeat(19)}${n}`;
const wide = (): QuestionView => ({ set: "qs-cccccccccccc", peer: "codex", created: 1, questions: [{ id: "pick", prompt: Array.from({ length: 24 }, () => "a long question word").join(" ").slice(0, 500),
  options: Array.from({ length: 8 }, (_, i) => opt(`o${i + 1}`, long(i + 1))), allowOther: true }] });

test("finding 1: at 80 columns every option label is on screen while the flow is open, panels or stream, and no option is only in a clipped footer", () => {
  const view = wide();
  for (const [panels, rows] of [[true, 24], [true, 30], [false, 24]] as const) {
    let state: ConsoleState = { ...initialConsoleState(panels), questions: [view] };
    const out = reduceConsole(state, "A", now); state = out.state;
    // what a person can read: the rendered screen plus everything the flow printed into the stream
    const printed = out.effects.map(effect => effect.type === "print" ? effect.text : "").join("\n");
    const screen = renderConsoleLines(state, 80, rows).map(line => paint(line, false)).join("\n") + "\n" + printed;
    for (let i = 1; i <= 8; i++) expect(screen.replace(/\s+/g, "").includes(long(i).replace(/\s+/g, "")), `option ${i} (${panels ? "panels" : "stream"} ${rows} rows)`).toBe(true);   // a label may wrap across lines; every character must be there, in order
    for (const line of renderConsoleLines(state, 80, rows)) expect(Bun.stringWidth(paint(line, false))).toBeLessThanOrEqual(80);
    // the footer line itself holds only keys, so a digit can never pick something the footer cut off
    const footer = renderConsoleLines(state, 80, rows).at(-1)!; expect(paint(footer, false)).toContain("number picks");
  }
});

test("finding 2: a paste while the person types an o answer fills the answer, a pasted Enter or Esc cannot send or leave it, and a paste outside text entry changes nothing", () => {
  const typing = (text: string): QuestionFlow => pasteFlow({ ...startFlow(wide()), typing: "ab" }, text);
  expect(typing("cd").typing).toBe("abcd");
  expect(typing("line one\nline two").typing).toBe("abline one line two");                                              // a newline is a space (the caller strips the bracketed-paste markers)
  expect(typing("x\ry\x1bz\x07\x7f").typing).toBe("abx yz");                                                              // Enter becomes a space; Esc, bell and DEL are dropped
  expect(typing("é한글🙂").typing).toBe("abé한글🙂");
  expect(Array.from(typing("z".repeat(900)).typing!)).toHaveLength(500);                                                  // bounded as typed keys are
  expect(pasteFlow(startFlow(wide()), "should not land").typing).toBeUndefined();
});

test("finding 3: question ids that are Object.prototype members never reach an inherited value, in single and multi choice, and the answer carries them", () => {
  for (const id of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    const view: QuestionView = { set: "qs-dddddddddddd", peer: "codex", created: 1, questions: [
      { id, prompt: "single?", options: [opt("a"), opt("b")] },
      { id: `${id}x`, prompt: "multi?", options: [opt("a"), opt("b"), opt("c")], multi: true, allowOther: true },
      { id: "multi2", prompt: "multi again?", options: [opt("a"), opt("b")], multi: true }] };
    const multiFirst: QuestionView = { ...view, questions: [{ ...view.questions[1]!, id }, view.questions[0]!] };
    let flow = startFlow(view);
    expect(() => renderConsoleLines({ ...initialConsoleState(true), questions: [view], questionFlow: flow }, 80, 24), id).not.toThrow();
    const step = (key: string, row = view) => { const out = stepFlow(flow, row, key); if (out.flow) flow = out.flow; return out; };
    expect(step("2").flow?.index, id).toBe(1);                       // single choice on the inherited-name id
    step("1"); step("3");                                            // multi toggles on its own id
    step("o"); for (const c of "ok") step(c);
    expect(step("\r").flow?.index, id).toBe(2);
    step("2");
    const done = step("\r");
    expect(done.answers, id).toEqual([{ questionId: id, optionIds: ["b"] }, { questionId: `${id}x`, optionIds: ["a", "c"], other: "ok" }, { questionId: "multi2", optionIds: ["b"] }]);
    // an id that is the first multi question: a toggle on a never-picked inherited name starts empty, then holds exactly what was chosen
    flow = startFlow(multiFirst);
    step("1", multiFirst); step("3", multiFirst); step("1", multiFirst);
    expect(flow.picks.get(id), id).toEqual(["c"]);
  }
});

import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";
test("finding 2 through the real console: a paste after o is the answer's text, the command line stays empty, a pasted Enter does not send, and the typed Enter sends it", async () => {
  let data = (_text: string) => {};
  const output: string[] = [], requests: any[] = [];
  const terminal: ConsoleTerminal = { columns: 100, rows: 30, isTTY: true, write: text => { output.push(text); }, raw: () => {}, onData: listener => { data = listener; return () => {}; }, onResize: () => () => {}, onSignal: () => () => {} };
  const view = { set: "qs-eeeeeeeeeeee", peer: "codex", created: 1, questions: [{ id: "why", prompt: "Why?", options: [opt("a"), opt("b")], allowOther: true }] };
  const client = { onPush: (_msg: any) => {}, onClose: (_code: number, _reason: string) => {}, send: (_msg: any) => {}, close: () => {}, request: async (msg: any) => {
    requests.push(msg);
    if (msg.t === "questions") return { ok: true, questions: [view] };
    if (msg.t === "answer") return { ok: true, questionSet: msg.questionSet, state: "answered" };
    return { ok: true, status: { peers: {}, features: ["questions"] }, budget: {}, text: "[]", deliveries: [] };
  } };
  const running = runConsole({ client, cwd: "/tmp/fixture-only", stateDir: "/tmp/fixture-only", terminal, panels: true, color: false, noPet: true, runCommand: () => () => {} });
  const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await Bun.sleep(20); };
  try {
    await tick();
    data("A"); await tick(); data("o"); await tick();
    data("\x1b[200~pasted free text\r\x1b[201~"); await tick();                                        // a paste with a trailing Enter in it
    const screen = output.join("");
    expect(screen).toContain("pasted free text");
    expect(requests.some(msg => msg.t === "answer")).toBe(false);                                      // the pasted Enter did not send
    data("\r"); await tick();
    const sent = requests.find(msg => msg.t === "answer");
    expect(sent).toMatchObject({ surface: "console", questionSet: "qs-eeeeeeeeeeee", answers: [{ questionId: "why", optionIds: [], other: "pasted free text" }] });
    // the command line never saw the paste: Enter after the flow runs no command
    expect(requests.filter(msg => msg.t === "command" || msg.t === "say")).toEqual([]);
  } finally { data("\x03"); await running; }
});
