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
export interface QuestionFlow { set: string; index: number; picks: Record<string, string[]>; others: Record<string, string>; typing?: string }
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

export const startFlow = (row: QuestionView): QuestionFlow => ({ set: row.set, index: 0, picks: {}, others: {} });

const printable = (key: string) => key.length > 0 && !key.startsWith("\x1b") && ![...key].some(char => char < " " || char === "\x7f");

export function stepFlow(flow: QuestionFlow, row: QuestionView, key: string): FlowStep {
  const question = row.questions[flow.index];
  if (!question) return { notice: "that question has no more parts" };
  const next: QuestionFlow = { ...flow, picks: { ...flow.picks }, others: { ...flow.others } };
  const advance = (): FlowStep => {
    next.index = flow.index + 1; next.typing = undefined;
    if (next.index < row.questions.length) return { flow: next };
    return { answers: row.questions.map(item => ({ questionId: item.id, optionIds: next.picks[item.id] ?? [], ...(next.others[item.id] ? { other: next.others[item.id]! } : {}) })) };
  };
  if (flow.typing !== undefined) {
    if (key === "\x1b") { next.typing = undefined; return { flow: next }; }
    if (key === "\r" || key === "\n") {
      const text = flow.typing.trim();
      if (!text) { next.typing = undefined; return { flow: next }; }
      next.others[question.id] = text;
      if (question.multi !== true) next.picks[question.id] = [];
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
      const chosen = new Set(next.picks[question.id] ?? []);
      if (chosen.has(option.id)) chosen.delete(option.id); else chosen.add(option.id);
      next.picks[question.id] = question.options.filter(item => chosen.has(item.id)).map(item => item.id);
      return { flow: next };
    }
    next.picks[question.id] = [option.id]; delete next.others[question.id];
    return advance();
  }
  if ((key === "\r" || key === "\n") && question.multi === true && ((next.picks[question.id]?.length ?? 0) > 0 || next.others[question.id])) return advance();
  return { flow: next };
}

/** The prompt line while a flow is open: the question, its numbered options, the chosen ones marked, and the keys that act. */
export function flowPrompt(flow: QuestionFlow, row: QuestionView, text: (value: unknown) => string): string {
  const question = row.questions[flow.index];
  if (!question) return "";
  const head = `${row.peer} asks ${flow.index + 1}/${row.questions.length}: ${text(question.prompt)}`;
  if (flow.typing !== undefined) return `${head}  other: ${flow.typing}_  Enter keeps  Esc back`;
  const chosen = new Set(flow.picks[question.id] ?? []);
  const options = question.options.map((option, index) => `${index + 1}${question.multi === true && chosen.has(option.id) ? "*" : ""} ${text(option.label)}`).join("  ");
  return `${head}  ${options}${question.allowOther === true ? "  o other" : ""}${question.multi === true ? "  Enter done" : ""}  Esc cancel`;
}
