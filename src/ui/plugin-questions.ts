/**
 * #1053 T5: the acon inbox side of a question a peer asked with hub_ask. Pure: it builds the inbox item from the stored row the hub reports and checks the
 * person evidence an answer needs; `plugin.ts` owns the transport. No text here is logged.
 *
 * Authority: an answer is accepted only when the console advertises `action.meta` and `action()` received the console's own `meta` (`via: "console"`, a verified
 * `identity`), which the page cannot set (agent-console `action(input, meta?)`). An answer without it is refused before any request reaches the hub.
 */

/** The console's evidence of who acted (agent-console `ActionMeta`), declared structurally so agent-hub keeps zero runtime dependencies. */
export interface PersonMeta { identity: string; node: string; via: "console" }
export interface QuestionRowView {
  set: string; peer: string; created: number; private?: boolean;
  questions: { id: string; prompt: string; options: { id: string; label: string; description?: string }[]; multi?: boolean; allowOther?: boolean }[];
}
interface FormQuestion { id: string; prompt: string; options: { id: string; label: string; description?: string }[]; multiple?: boolean; other?: { maxLength: number } }
export interface QuestionItem {
  id: string; group: "decision"; kind: string; title: string; actor: string; project: string; at: string; chip: { text: string; tone: "warn" };
  verbs: { id: string; label: string; primary?: boolean; form?: { questions: FormQuestion[] } }[];
  link: { panel: string; params: Record<string, string> };
}

/** Both features are needed: `inbox.form` renders the form, `action.meta` gives the answer its person evidence. One alone is the plain item. */
export const canAnswerInInbox = (features: readonly string[] | undefined): boolean => !!features?.includes("inbox.form") && features.includes("action.meta");

const flat = (text: string, max: number) => Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim()).slice(0, max).join("");
export const questionItemId = (project: string, set: string) => `question:${project}:${set}`;
export const QUESTION_ITEM = /^question:([^:]+):(qs-[a-f0-9]{12})$/;

/**
 * The inbox item. A private question (asked in a PII turn or about a PII task) gets a stub title and no detail: its text is in the form only, which is the person's
 * own answer surface. Without the two features the item is a plain decision with an `open` verb that links to the agents panel.
 */
export function questionItem(row: QuestionRowView, project: { id: string; name: string }, features: readonly string[] | undefined): QuestionItem {
  const head = row.private ? "a question" : `: ${flat(row.questions[0]?.prompt ?? "", 80)}`;
  const title = (row.private ? `${row.peer} asks ${head}` : `${row.peer} asks${head}`).slice(0, 200);
  const link = { panel: "agents", params: { project: project.id } };
  const base = { id: questionItemId(project.id, row.set), group: "decision" as const, title, actor: row.peer, project: project.name, at: new Date(row.created).toISOString(), chip: { text: "question", tone: "warn" as const }, link };
  if (!canAnswerInInbox(features)) return { ...base, kind: "decision", verbs: [{ id: "open", label: "Open Agents", primary: true }] };
  const form = { questions: row.questions.map<FormQuestion>(question => ({ id: question.id, prompt: question.prompt, options: question.options.map(option => ({ id: option.id, label: option.label, ...(option.description ? { description: option.description } : {}) })),
    ...(question.multi === true ? { multiple: true } : {}), ...(question.allowOther === true ? { other: { maxLength: 500 } } : {}) })) };
  return { ...base, kind: "question", verbs: [{ id: "answer", label: "Answer", primary: true, form }, { id: "open", label: "Open Agents" }] };
}

/** The console's evidence, or the refusal that tells the person how to get it. Page-supplied fields that would stand in for it are refused too. */
export function personEvidence(features: readonly string[] | undefined, meta: unknown, input: Record<string, unknown>): { ok: true; identity: string } | { ok: false; error: string } {
  if (!features?.includes("action.meta") || !meta || typeof meta !== "object") return { ok: false, error: "Answering needs a console with verified person identity; update acon and reopen this panel, or answer with ahub answer." };
  const value = meta as Record<string, unknown>;
  if (value.via !== "console" || typeof value.identity !== "string" || !value.identity.trim() || typeof value.node !== "string" || !value.node.trim())
    return { ok: false, error: "Answering needs a console with verified person identity; update acon and reopen this panel, or answer with ahub answer." };
  if (["author", "meta", "personMeta", "person", "identity", "surface", "questionSet", "projectId", "instanceId"].some(key => Object.hasOwn(input, key)))
    return { ok: false, error: "The person's identity and the target come from the console; remove those fields and retry." };
  return { ok: true, identity: value.identity.trim().slice(0, 200) };
}
