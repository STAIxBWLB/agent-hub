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
const S = String.raw`(?:tests?|test suites?|bun test|scripts/check\.sh|checks?|ci|continuous integration|github checks?|gates?|check (?:output|results?)|typecheck|tsc|preload)`;
/** The only thing said about them that makes an item verification-only: evidence was not run, not shown, not readable or not green. */
const POSITIVE: readonly RegExp[] = [
  // Asking for the evidence: "provide its successful receipt", "paste the check output", "rerun the affected tests".
  new RegExp(String.raw`^(?:[\w ]{0,24}:\s*)?(?:please |still )?(?:provide|supply|paste|show|attach|confirm|rerun|re-run|run|execute)\b[^.;]{0,120}\b${S}\b`, "i"),
  // The subject was not run, verified, read or shown, or is not green.
  new RegExp(String.raw`\b${S}\b[^.;]{0,120}\b(?:(?:has|have|had|is|are|was|were|remains?|remained) (?:not|n't) (?:yet )?(?:been )?(?:run|ran|executed|verified|confirmed|green|passing|passed|available|provided|supplied|shown|readable|read)|(?:remains?|remained|is|are) (?:still )?(?:unverified|unavailable|unconfirmed|pending|unknown)|could not (?:be )?(?:run|read|executed|reproduced)|cannot (?:be )?(?:run|read|executed|reproduced)|(?:was|were|is|are) blocked)\b`, "i"),
  // Evidence of the subject is missing: "no check result", "check output is missing", "missing test evidence".
  new RegExp(String.raw`\b(?:no|without|missing|absent)\s+(?:\w+\s+){0,2}${S}\s+(?:results?|output|evidence|receipt|report)\b`, "i"),
  // The evidence itself is the whole claim: nothing may follow it ("check output is missing" yes, "check output is missing a guard" no).
  new RegExp(String.raw`^(?:[\w ]{0,24}:\s*)?(?:the |a |any )?(?:\w+\s+){0,2}${S}\s+(?:results?|output|evidence|receipt|report)\s+(?:is|are|was|were|remains?)\s+(?:missing|absent|unavailable|not (?:provided|supplied|shown|available))(?:\s+(?:in|from) the (?:review )?(?:brief|task|request|public task view))?$`, "i"),
  // The sandbox itself: "blocked by read-only sandbox EPERM", "failed in preload with EPERM".
  /\b(?:eperm|read-only sandbox)\b/i,
];
/** Anything that names code, configuration or a defect keeps the clause, whatever else it says. */
const CODE_WORD = /(?:\bbugs?\b|\bdefects?\b|\bregress\w*|\bunsafe\b|\bleaks?\b|\brace\b|\bwrong\b|\bincorrect\b|\binjection\b|\bworkflow\b|\bfixture\b|\btrigger\b|\bcleanup\b|\bconfig\w*|\bmock\w*|\bstubs?\b|\bassert\w*|\bcoverage\b|\bcover(?:s|ed)?\b|\bhandle[sd]?\b|\bdoes not\b|\bdo not (?:handle|cover)\b|\bshould\b|\bmust\b|\bneeds? (?:a|an|to)\b|\badd (?:a |an )?\w+|\bline \d+|\bsrc\/|\bdocs\/)/i;
/** Identifier shapes are read case-sensitively: camelCase, snake_case, a call or a scope operator. A capitalised word is not one. */
const CODE_SHAPE = /(?:\b[a-z]+[A-Z]\w*\b|\b[a-z]\w*_\w+\b|\w\(\)|::|=>)/;
const CODE_SIGNAL = { test: (text: string): boolean => CODE_WORD.test(text) || CODE_SHAPE.test(text) };
/** Gate tokens that look like code but are the gate itself: removed before the code-signal read. */
const GATE_TOKENS = /(?:scripts\/check\.sh(?: --changed)?|test\/hub-home\.ts|bun test(?: [\w./-]+)*|\b[0-9a-f]{7,64}\b|\bAC\d+\b|\bPR #?\d+\b|#\d+)/gi;

/** One clause that is only about test execution, check output or CI evidence: it matches a positive phrasing and names no code. */
export function verificationOnlyClause(clause: string): boolean {
  const text = clause.replace(/\s+/g, " ").trim();
  if (!text || text.length > 300) return false; // long text carries reasoning: keep it
  if (CODE_SIGNAL.test(text.replace(GATE_TOKENS, " "))) return false;
  return POSITIVE.some(pattern => pattern.test(text));
}

/**
 * A follow-on request with no runner subject of its own ("provide its successful receipt", "paste the output"): it is verification-only only
 * as the continuation of a clause that already matched positively, and only in this one bounded request shape.
 */
const FOLLOW_ON = /^(?:please |still )?(?:provide|supply|paste|show|attach|confirm)\s+(?:its|the|their|a|an)?\s*(?:\w+\s+){0,3}(?:receipts?|results?|output|evidence|report)\b[^.;]{0,60}$/i;

/** One unmet item: every clause (split on ; and sentence ends) must be verification-only, at least one on its own words, and there must be one. */
export function verificationOnlyItem(item: string): boolean {
  const clauses = item.split(/;|\.(?:\s|$)/).map(part => part.trim()).filter(Boolean);
  if (!clauses.length) return false;
  const own = clauses.map(verificationOnlyClause);
  if (!own.some(Boolean)) return false; // at least one clause stands on its own words
  return clauses.every((clause, index) => own[index] || (FOLLOW_ON.test(clause) && !CODE_SIGNAL.test(clause.replace(GATE_TOKENS, " "))));
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
