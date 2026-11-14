import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { instructedAnswerItem } from "../src/ui/plugin-questions.ts";
import { questionRows } from "../src/cli/console-question.ts";
import { answerProvenance, questionView, type QuestionRow } from "../src/hub/questions.ts";
import { ASK_ANSWER_TOOL, CONDUCTOR_TOOLS, IMPLEMENTER_HUB_TOOL_NAMES, QUESTION_TOOLS } from "../src/hub/hub-tools.ts";

test("instructed answer views retain public provenance and never the database quote", () => {
  const row: QuestionRow = { set: "qs-aaaaaaaaaaaa", peer: "codex", session: "", private: false, state: "answered", created: 1, settled: 2, envelope: 0,
    surface: "conductor", person: "claude", instructed: true, instruction: "DATABASE_ONLY_QUOTE", questions: [{ id: "q", prompt: "question", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }], answers: [{ questionId: "q", optionIds: ["a"] }] };
  const view = questionView(row);
  expect(view).not.toHaveProperty("instruction");
  expect(view.provenance).toBe("answered by claude on the person's instruction");
  const item = instructedAnswerItem({ set: row.set, peer: row.peer, created: row.created, person: row.person!, provenance: answerProvenance(row)! }, { id: "p", name: "project" });
  expect(item.title).toContain(view.provenance!);
  expect(item.verbs.map(verb => verb.id)).toEqual(["open"]);
  expect(JSON.stringify(item)).not.toContain("DATABASE_ONLY_QUOTE");
  expect(questionRows([view])).toEqual([]);
  expect(questionRows([{ ...view, state: "open" }])).toHaveLength(1);
});

test("instructed tool schema is single, conductor-scoped and capture-excluded, never an owned child's tool", () => {
  expect(CONDUCTOR_TOOLS.filter(tool => tool.name === "hub_ask_answer")).toEqual([ASK_ANSWER_TOOL]);
  expect(IMPLEMENTER_HUB_TOOL_NAMES).not.toContain("hub_ask_answer");
  expect(QUESTION_TOOLS.has("hub_ask_answer")).toBe(true);
  expect(ASK_ANSWER_TOOL.description).toContain("explicit per-set instruction in your own session");
  expect(ASK_ANSWER_TOOL.description).toContain("relays never qualify");
});


test("dashboard actually renders instructed answer provenance and answer text through text nodes, never the quote", () => {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("function renderInstructedAnswers("), html.indexOf("function renderApprovals("));
  const nodes: { text: string; children: unknown[]; dataset: Record<string, string>; append(...items: unknown[]): void }[] = [];
  const make = (_tag: string, text = "") => { const node = { text, children: [] as unknown[], dataset: {} as Record<string, string>, append(...items: unknown[]) { this.children.push(...items); } }; nodes.push(node); return node; };
  const section = make("section"), target = make("div");
  const render = runInNewContext(source + "; renderInstructedAnswers", { $: () => section, el: make, update: (_id: string, _rows: unknown, paint: (target: unknown) => void) => paint(target) });
  const provenance = "answered by claude on the person's instruction <img src=x onerror=alert(1)>";
  render([{ set: "qs-aaaaaaaaaaaa", instructed: true, provenance, answers: [{ questionId: "q", optionIds: ["a"], other: "ANSWER_TEXT" }], instruction: "DATABASE_ONLY_QUOTE" }]);
  expect(nodes.map(node => node.text).join(" ")).toContain(provenance);
  expect(nodes.map(node => node.text).join(" ")).toContain("ANSWER_TEXT");
  expect(JSON.stringify(nodes)).not.toContain("DATABASE_ONLY_QUOTE");
  expect(section.dataset.empty).toBe("false");
  expect(html).toContain("renderInstructedAnswers(snapshot.answeredQuestions)");
  render([]); expect(section.dataset.empty).toBe("true");
});
