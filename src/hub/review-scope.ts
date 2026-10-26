/**
 * #852: a reviewer's review scope. `full` reads the code, runs the affected tests and reads CI; `code` reads the code only, because its sandbox
 * cannot run tests or read CI. AC3 (amended 2026-10-26) is structural, never a reading of free text: a `code` reviewer's changes_requested is always
 * recorded, and one with no open structured finding is recorded as evidence-only (see Tasks.review).
 */
export type ReviewScope = "full" | "code";
export const REVIEW_SCOPES: readonly ReviewScope[] = ["full", "code"];
export const isReviewScope = (value: unknown): value is ReviewScope => value === "full" || value === "code";

/** The one review-request line for a `code` reviewer (AC2). Fixed text: no hub or PR content is interpolated. */
export const CODE_SCOPE_LINE = "Your sandbox cannot run tests or read CI: review the code against the plan; do not list tests, check output or CI as unmet. The merger gates on exact-head CI (#852). Report every code defect as a structured finding with an id (hub_review findings, disposition open); a verdict with no open finding is recorded as evidence-only and does not count as a rejection.";
/** The one task notice the conductor gets when a code-scope reviewer's verdict is recorded as evidence-only (ids only, never text). */
export const evidenceOnlyNotice = (task: number, reviewer: string): string => `Task #${task}: a code-scope review by ${reviewer} was recorded as evidence-only (no open finding) and the task returned to its owner. Take the review.`;
