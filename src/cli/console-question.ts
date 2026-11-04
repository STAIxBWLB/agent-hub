/**
 * #1053 T4: answering a question a peer asked with hub_ask, with the console's keys. Pure: the reducer passes it the open rows and a key, and it answers with the
 * next flow state, the answers once the last question is done, or nothing. The hub validates every answer against the stored row; this only builds them.
 *
 * One question at a time, the oldest open set first: a digit picks that option (single choice) or toggles it (multi, Enter moves on), `o` types free text where the
 * question allows it (Enter keeps it, Esc stops typing), Esc leaves the flow. Answering is neither outward nor destructive, so the last answer is sent with no confirm.
 */
import { MAX_OTHER, type AskQuestion } from "../hub/questions.ts";

/** What the hub's `questions` read returns for one open set. The text is the person's: it is shown here and never logged. */
export interface QuestionView { set: string; peer: string; created: number; private?: boolean; questions: AskQuestion[] }
/** `picks` and `others` are Maps, never plain objects: a question id is the agent's (`constructor`, `toString` and `__proto__` are valid ids), and an object lookup would find an inherited member. */
export interface QuestionFlow { set: string; index: number; picks: Map<string, string[]>; others: Map<string, string>; typing?: string }
export interface FlowAnswer { questionId: string; optionIds: string[]; other?: string }
export interface FlowStep { flow?: QuestionFlow; answers?: FlowAnswer[]; notice?: string }

/** Rows from the hub's reply, copied by shape so a malformed row is dropped rather than rendered. */
export function questionRows(raw: unknown): QuestionView[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap<QuestionView>(row => {
    if (!row || typeof row !== "object" || typeof row.set !== "string" || typeof row.peer !== "string" || !Array.isArray(row.questions) || !row.questions.length) return [];
    return [{ set: row.set, peer: row.peer, created: Number.isSafeInteger(row.created) ? row.created : 0, ...(row.private === true ? { private: true } : {}), questions: row.questions as AskQuestion[] }];
  }).sort((a, b) => a.created - b.created || a.set.localeCompare(b.set));
}

export const startFlow = (row: QuestionView): QuestionFlow => ({ set: row.set, index: 0, picks: new Map(), others: new Map() });

const printable = (key: string) => key.length > 0 && !key.startsWith("\x1b") && ![...key].some(char => char < " " || char === "\x7f");

export function stepFlow(flow: QuestionFlow, row: QuestionView, key: string): FlowStep {
  const question = row.questions[flow.index];
  if (!question) return { notice: "that question has no more parts" };
  const next: QuestionFlow = { ...flow, picks: new Map(flow.picks), others: new Map(flow.others) };
  const advance = (): FlowStep => {
    next.index = flow.index + 1; next.typing = undefined;
    if (next.index < row.questions.length) return { flow: next };
    return { answers: row.questions.map(item => ({ questionId: item.id, optionIds: next.picks.get(item.id) ?? [], ...(next.others.get(item.id) ? { other: next.others.get(item.id)! } : {}) })) };
  };
  if (flow.typing !== undefined) {
    if (key === "\x1b") { next.typing = undefined; return { flow: next }; }
    if (key === "\r" || key === "\n") {
      const text = flow.typing.trim();
      if (!text) { next.typing = undefined; return { flow: next }; }
      next.others.set(question.id, text);
      if (question.multi !== true) next.picks.set(question.id, []);
      return advance();
    }
    if (key === "\x7f" || key === "\b") { next.typing = Array.from(flow.typing).slice(0, -1).join(""); return { flow: next }; }
    if (printable(key)) next.typing = Array.from(flow.typing + key).slice(0, MAX_OTHER).join("");
    return { flow: next };
  }
  if (key === "\x1b") return { notice: "answer cancelled; the question stays open" };
  if (key === "o" && question.allowOther === true) { next.typing = ""; return { flow: next }; }
  if (/^[1-9]$/.test(key)) {
    const option = question.options[Number(key) - 1];
    if (!option) return { flow: next };
    if (question.multi === true) {
      const chosen = new Set(next.picks.get(question.id) ?? []);
      if (chosen.has(option.id)) chosen.delete(option.id); else chosen.add(option.id);
      next.picks.set(question.id, question.options.filter(item => chosen.has(item.id)).map(item => item.id));
      return { flow: next };
    }
    next.picks.set(question.id, [option.id]); next.others.delete(question.id);
    return advance();
  }
  if ((key === "\r" || key === "\n") && question.multi === true && ((next.picks.get(question.id)?.length ?? 0) > 0 || next.others.get(question.id))) return advance();
  return { flow: next };
}

/**
 * A pasted chunk while the person is typing an `o` answer: its printable characters join the text, bounded as typed keys are. A paste is only ever text here: a newline
 * in it is a space and an escape or control character is dropped, so a pasted Enter or Esc can never keep, send or leave the answer. Outside text entry it changes nothing.
 */
export function pasteFlow(flow: QuestionFlow, pasted: string): QuestionFlow {
  if (flow.typing === undefined) return flow;
  const text = [...pasted.replace(/[\r\n]+/g, " ")].filter(char => printable(char)).join("");
  return { ...flow, typing: Array.from(flow.typing + text).slice(0, MAX_OTHER).join("") };
}

/**
 * The question as lines to show in a wrapped area, never the one-line footer: the head, the prompt, then every option numbered with the chosen ones marked. The footer
 * clips a long line, and a digit submits at once, so an option that is not on screen must never be one a key can pick. `text` flattens agent text for a terminal.
 */
export function flowBody(flow: QuestionFlow, row: QuestionView, text: (value: unknown) => string): { head: string; prompt: string; options: string[] } | undefined {
  const question = row.questions[flow.index];
  if (!question) return undefined;
  const chosen = new Set(flow.picks.get(question.id) ?? []);
  return {
    head: `${row.peer} asks ${flow.index + 1}/${row.questions.length}`,
    prompt: text(question.prompt),
    options: question.options.map((option, index) => `${index + 1}${question.multi === true ? (chosen.has(option.id) ? "*" : " ") : ""} ${text(option.label)}`),
  };
}

/**
 * The footer line while a flow is open: only the keys that act, and the text being typed (its tail, so the cursor stays in view). It names no option and no prompt: those
 * are in `flowBody`'s wrapped area, where they cannot be cut off.
 */
export function flowPrompt(flow: QuestionFlow, row: QuestionView, text: (value: unknown) => string, columns = 80): string {
  const question = row.questions[flow.index];
  if (!question) return "";
  const head = `${row.peer} asks ${flow.index + 1}/${row.questions.length}`;
  if (flow.typing !== undefined) {
    const tail = Array.from(text(flow.typing)), room = Math.max(8, columns - 32);
    return `${head}  other: ${tail.length > room ? "..." + tail.slice(-room).join("") : tail.join("")}_  Enter keeps  Esc back`;
  }
  const chosen = new Set(flow.picks.get(question.id) ?? []);
  const marked = question.multi === true ? question.options.flatMap((option, index) => chosen.has(option.id) ? [String(index + 1)] : []) : [];
  return `${head}  number picks${question.allowOther === true ? "  o other" : ""}${question.multi === true ? `${marked.length ? `  chosen ${marked.join(",")}` : ""}  Enter done` : ""}  Esc cancel`;
}
