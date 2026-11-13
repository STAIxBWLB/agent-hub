import { QUESTION_SET } from "../hub/questions.ts";

/**
 * #1053 T4: `ahub answer <set> <question>=<option>[,<option>]... [--other <text>]...`. Pure: it turns argv into the `answers` list the hub validates
 * against the stored row, and never decides whether an answer is valid (the store does, with a reason that names a question by position).
 *
 * `--other <text>` is the free text of the one question named, or `--other <question>=<text>` when several are named; a question named with no options
 * (`extras=`) answers with its other text alone. The question ids are the agent's, bounded by the same pattern the store uses.
 */

const ID = /^[A-Za-z0-9_.-]{1,64}$/;
export interface ParsedAnswer { set: string; answers: { questionId: string; optionIds: string[]; other?: string }[] }
export type AnswerArgs = { ok: true; value: ParsedAnswer } | { ok: false; error: string };
export const ANSWER_USAGE = "usage: ahub answer <set> <question>=<option>[,<option>] [--other <text>]   (ahub answer lists the open questions)";

export function parseAnswerArgs(args: readonly string[]): AnswerArgs {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
  const [set, ...rest] = args;
  if (!set || !QUESTION_SET.test(set)) return fail(`${ANSWER_USAGE}; the set looks like qs-0123456789ab`);
  const picks = new Map<string, string[]>(), others: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index]!;
    if (word === "--other" || word.startsWith("--other=")) {
      const value = word === "--other" ? rest[++index] : word.slice("--other=".length);
      if (value === undefined || value === "") return fail("--other needs the text to give");
      others.push(value);
      continue;
    }
    if (word.startsWith("--")) return fail(`${ANSWER_USAGE}; unknown flag ${word.split("=")[0]}`);
    const at = word.indexOf("=");
    if (at < 1) return fail(`${ANSWER_USAGE}; "${word.slice(0, 40)}" is not <question>=<option>`);
    const question = word.slice(0, at);
    if (!ID.test(question)) return fail("a question id is 1 to 64 characters of letters, digits, dot, dash or underscore");
    if (picks.has(question)) return fail(`question ${question} is answered twice`);
    const options = word.slice(at + 1).split(",").filter(Boolean);
    if (options.some(option => !ID.test(option))) return fail(`question ${question}: an option id is 1 to 64 characters of letters, digits, dot, dash or underscore`);
    picks.set(question, options);
  }
  if (!picks.size) return fail(`${ANSWER_USAGE}; name at least one question`);
  const other = new Map<string, string>();
  for (const text of others) {
    const at = text.indexOf("=");
    const named = at > 0 && picks.has(text.slice(0, at)) ? text.slice(0, at) : undefined;
    const target = named ?? (picks.size === 1 ? [...picks.keys()][0]! : undefined);
    if (target === undefined) return fail("with several questions, give --other <question>=<text>");
    if (other.has(target)) return fail(`question ${target} has two --other texts`);
    other.set(target, named ? text.slice(at + 1) : text);
  }
  return { ok: true, value: { set, answers: [...picks].map(([questionId, optionIds]) => ({ questionId, optionIds, ...(other.has(questionId) ? { other: other.get(questionId)! } : {}) })) } };
}
