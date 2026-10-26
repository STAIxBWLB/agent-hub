/**
 * #852 (AC3): a reviewer whose review scope is `code` reads the code only. Its sandbox cannot run tests or read CI, so a rejection that
 * rests on nothing but test execution, check output or CI is not a code finding and is refused. This is a narrow classifier and not a
 * judgement of free text: an item counts as verification-only only when it matches one of a few fixed phrasings about the three
 * categories and names nothing else (no path, symbol, behaviour or contract). When unsure, the verdict is accepted.
 */
import type { ReviewFinding } from "./review-findings.ts";

export type ReviewScope = "full" | "code";
export const REVIEW_SCOPES: readonly ReviewScope[] = ["full", "code"];
export const isReviewScope = (value: unknown): value is ReviewScope => value === "full" || value === "code";

/** Subjects only a runner can establish: tests, their execution, check output and CI. */
const SUBJECT = /\b(?:tests?|test suites?|bun test|scripts\/check\.sh|checks?|ci|continuous integration|github checks?|gates?|check output|typecheck|tsc|preload)\b/i;
/** What is said or asked about them: run, provide, verify, not green, unavailable, blocked, missing, pending, failed, EPERM. */
const CLAIM = /\b(?:provide|supply|paste|show|attach|run|rerun|re-run|execute[ds]?|execution|confirm(?:ed)?|verif(?:y|ied|ication)|unverified|green|passing|passed|successful|success|not (?:run|executed|verified|green|available|provided|supplied|confirmed|readable|read)|unavailable|missing|absent|unknown|pending|blocked|failed|stopped|eperm|sandbox|receipt|evidence|output)\b/i;
/** Anything naming code, a contract or a behaviour keeps the clause: a symbol, a path other than the gate's own, a line, a defect word. */
const CODE_SIGNAL = /(?:\b[a-z]+[A-Z]\w*\b|\w\(\)|::|=>|\bsrc\/|\bdocs\/|\bline \d+|\bbugs?\b|\bdefects?\b|\bregress\w*|\bunsafe\b|\bleaks?\b|\brace\b|\bwrong\b|\bincorrect\b|\binjection\b|\bdoes not (?:handle|refuse|match|call|reject|cover)\b|\bno (?:test|tests) (?:for|covers?)\b|\bnot covered\b|\badd (?:a |an )?tests?\b|\bcoverage\b|\bassert\w*\b)/;
/** Tokens that look like code but are the gate itself: removed before the code-signal read. */
const GATE_TOKENS = /(?:scripts\/check\.sh(?: --changed)?|test\/hub-home\.ts|bun test(?: [\w./-]+)*|\b[0-9a-f]{7,64}\b|\bAC\d+\b|\bPR #?\d+\b|#\d+)/gi;

/** One clause that is only about test execution, check output or CI. */
export function verificationOnlyClause(clause: string, itemHasSubject = false): boolean {
  const text = clause.replace(/\s+/g, " ").trim();
  if (!text || text.length > 300) return false; // long text carries reasoning: keep it
  if (CODE_SIGNAL.test(text.replace(GATE_TOKENS, " "))) return false;
  // A follow-on clause such as "provide its successful receipt" has no subject of its own: it inherits the item's.
  return (SUBJECT.test(text) || itemHasSubject) && CLAIM.test(text);
}

/** One unmet item: every clause (split on ; and sentence ends) must be verification-only, and the item must name a runner subject. */
export function verificationOnlyItem(item: string): boolean {
  const clauses = item.split(/[;]|\.(?:\s|$)/).map(part => part.trim()).filter(Boolean);
  const subject = SUBJECT.test(item);
  return clauses.length > 0 && subject && clauses.every(clause => verificationOnlyClause(clause, subject));
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
