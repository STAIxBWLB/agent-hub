/**
 * #852 (AC3): a reviewer whose review scope is `code` reads the code only. Its sandbox cannot run tests or read CI, so a rejection that
 * rests on nothing but test execution, check output or CI is not a code finding and is refused.
 *
 * The classifier is a closed vocabulary, not a blacklist. A clause is verification-only only when EVERY word in it belongs to a fixed set of
 * verification words (the runner's nouns, the evidence's nouns, and a few function words and claim verbs) and the clause then matches one
 * bounded claim form: asking for the evidence, the subject not run, verified or green, unavailable or unknown, could not run, blocked or failed
 * by the sandbox, or the evidence itself missing. Any word outside the vocabulary (a behaviour, a condition, a file, a symbol, "when", "silently",
 * "ignored") keeps the verdict: an unknown suffix is a code finding. When unsure, the verdict is accepted.
 */
import type { ReviewFinding } from "./review-findings.ts";

export type ReviewScope = "full" | "code";
export const REVIEW_SCOPES: readonly ReviewScope[] = ["full", "code"];
export const isReviewScope = (value: unknown): value is ReviewScope => value === "full" || value === "code";

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));
/** Function words. Conditions and causes about behaviour ("when", "if", "while", "unless") are deliberately absent. */
const FUNCTION = words("a an the this that these those its it their there is are was were be been being has have had not no and or of at on in to for from by with before after per as because until yet still please only any all both each also which remain remains remained");
/** Verbs and states that make a verification claim. */
const CLAIM = words("provide provided supply supplied paste show shown attach attached confirm confirmed confirmation rerun run ran running execute executed execution verify verified verification unverified read readable reproduce reproduced reproducible could cannot can green passing passed successful success available unavailable unconfirmed unknown pending missing absent blocked failed contains reports independently independent ok");
/** The runner's own nouns: only a runner can establish these. */
const SUBJECT = words("test tests suite suites check checks gate gates ci typecheck tsc preload bun");
/** Evidence and context nouns, and the placeholders the gate's own tokens are rewritten to. */
const CONTEXT_NOUN = words("output result results evidence receipt report log logs head sha id file files body bodies brief hub task view public review reviewer reviewers sandbox environment temp temporary home directory creation creating writable authorized authorised isolated only exact affected required reviewed full new relevant targeted local five own unmet ac ref merge commit committed current eperm verification note");
const VOCAB: ReadonlySet<string> = new Set([...FUNCTION, ...CLAIM, ...SUBJECT, ...CONTEXT_NOUN]);
/** A verification claim must sit in a verification context: a reviewer, the sandbox, the brief, the hub, a head, evidence, or a requirement. */
const CONTEXT = words("reviewer reviewers sandbox eperm preload brief hub head evidence receipt affected required exact reviewed per merge");

/** The gate's own tokens look like code (paths, hashes, flags) but are the gate itself: rewritten to neutral placeholders before reading. */
const GATE_REWRITES: readonly (readonly [RegExp, string])[] = [
  [/scripts\/check\.sh(?: --changed)?/gi, " check "],
  [/bun test(?: [\w./-]+\.test\.ts)*/gi, " test "],
  [/\btest\/[\w./-]+\.ts\b/gi, " file "],
  [/\b[0-9a-f]{7,64}\b/gi, " id "],
  [/\bAC\d+\b/gi, " ac "],
  [/\bPR #?\d+\b|#\d+/gi, " ref "],
  [/n't\b/gi, " not"],
];
/** Anything shaped like code keeps the clause before the vocabulary is even read: an identifier shape, a call, a src or docs path. */
const CODE_SHAPE = /(?:\b[a-z]+[A-Z]\w*\b|\b[a-z]\w*_\w+\b|\w\(\)|::|=>|\bsrc\/|\bdocs\/|\bline \d+)/;

const normalise = (clause: string): string => GATE_REWRITES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), clause.replace(/\s+/g, " ").trim());
const tokens = (normalised: string): string[] => normalised.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const wordsOnly = (list: readonly string[]): boolean => list.length > 0 && list.every(token => VOCAB.has(token) || /^\d+$/.test(token));

// Claim forms, read over the normalised, vocabulary-checked word string. Each is bounded; none accepts a trailing behaviour.
const LABELS = String.raw`(?:(?:verification|ac|required|unmet|evidence|note|exact|reviewer)\s+){0,3}`;
const REQUEST = new RegExp(String.raw`^${LABELS}(?:please\s+|still\s+)?(?:provide|supply|paste|show|attach|confirm|rerun|run|execute)\b`);
const NOT_DONE = /\bnot (?:yet )?(?:been )?(?:run|ran|executed|verified|confirmed|green|passing|passed|available|provided|supplied|shown|read|readable)\b/;
const UNAVAILABLE = /\b(?:unverified|unavailable|unconfirmed)\b|\b(?:remains?|is|are) (?:still )?(?:pending|unknown)\b/;
const COULD_NOT = /\b(?:could not|cannot|can not) (?:be )?(?:run|read|executed|reproduced)\b/;
const EVIDENCE_MISSING = /\b(?:no|without)\s+(?:\w+\s+){0,2}(?:check|test|tests|ci|gate)s?\s+(?:results?|output|evidence|receipt|report)\b|\b(?:check|test|tests|ci|gate)s?\s+(?:output|results?|evidence|receipt|report)\s+(?:is|are|was|were|remains?)\s+(?:missing|absent|unavailable)\b/;
const SANDBOXED = /\b(?:blocked|failed)\b/;
const SANDBOX_WORD = /\b(?:sandbox|eperm|preload)\b/;

/** One clause that is only about test execution, check output or CI evidence: every word is verification vocabulary and one bounded claim form matches. */
export function verificationOnlyClause(clause: string): boolean {
  const text = normalise(clause);
  if (!text || text.length > 300) return false; // long text carries reasoning: keep it
  if (CODE_SHAPE.test(text)) return false;
  const list = tokens(text);
  if (!wordsOnly(list) || !list.some(token => SUBJECT.has(token))) return false;
  const joined = list.join(" "), context = list.some(token => CONTEXT.has(token));
  if (REQUEST.test(joined)) return true;
  if (SANDBOXED.test(joined) && SANDBOX_WORD.test(joined)) return true; // "blocked by the read-only sandbox", "failed in preload with EPERM"
  return context && (NOT_DONE.test(joined) || UNAVAILABLE.test(joined) || COULD_NOT.test(joined) || EVIDENCE_MISSING.test(joined));
}

/**
 * A follow-on request with no runner subject of its own ("provide its successful receipt"): verification-only only as the continuation of a clause
 * that already qualified, and only when every word is vocabulary, it asks for evidence, and it names an evidence noun.
 */
function followOn(clause: string): boolean {
  const text = normalise(clause);
  if (!text || CODE_SHAPE.test(text)) return false;
  const list = tokens(text);
  return wordsOnly(list) && REQUEST.test(list.join(" ")) && list.some(token => ["receipt", "result", "results", "output", "evidence", "report"].includes(token));
}

/** One unmet item: every clause (split on ; and sentence ends) must be verification-only, at least one on its own words, and there must be one. */
export function verificationOnlyItem(item: string): boolean {
  const clauses = item.split(/;|\.(?:\s|$)/).map(part => part.trim()).filter(Boolean);
  if (!clauses.length) return false;
  const own = clauses.map(verificationOnlyClause);
  if (!own.some(Boolean)) return false; // at least one clause stands on its own words
  return clauses.every((clause, index) => own[index] || followOn(clause));
}

/**
 * True only when the verdict has at least one unmet item and every one of them is verification-only, with no open structured
 * finding. No items, any open finding, or any item that is not clearly verification-only keeps the verdict (when unsure, accept).
 */
export function classifyVerificationOnly(items: readonly string[], findings: readonly ReviewFinding[]): boolean {
  if (findings.some(finding => finding.disposition === "open")) return false; // a structured finding is a code finding by construction
  return items.length > 0 && items.every(verificationOnlyItem);
}

/** The one review-request line for a `code` reviewer (AC2). Fixed text: no hub or PR content is interpolated. */
export const CODE_SCOPE_LINE = "Your sandbox cannot run tests or read CI: review the code against the plan; do not list tests, check output or CI as unmet. The merger gates on exact-head CI (#852).";
/** The refusal reason (AC3), naming AC2. */
export const CODE_SCOPE_REFUSAL = "review scope is code (#852 AC2): your unmet items cite only test execution, check output or CI, which a code-scope reviewer cannot establish and must not list; the merger gates on exact-head CI. Review the code against the plan and name a specific code defect, or approve";
