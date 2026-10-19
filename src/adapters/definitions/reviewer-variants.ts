import type { AdapterDefinition } from "../registry-types.ts";
import { claudeReviewerBackend } from "../claude-print.ts";
import { codexReviewerBackend } from "../codex-review-isolation.ts";
import { kimiReviewerBackend } from "../kimi-review.ts";
import { createReviewer, createCodexReviewer } from "./native-factories.ts";
import { CODEX_DISPLAY, KIMI_DISPLAY } from "./native-display.ts";

export { claudeReviewerBackend };
/** No launch path is exposed by metadata-only placeholders. */
function unavailableLaunch(): never { throw new Error("Reviewer unavailable: verified runtime support is deferred to #533"); }

function reviewerVariant(kind: string, displayName: string, reviewer: NonNullable<AdapterDefinition["reviewer"]>, display: AdapterDefinition["display"]): AdapterDefinition {
  return {
    api: 1, kind, family: kind, displayName, transport: "hub-native", roles: ["reviewer"],
    defaultOnRoster: false, trust: { onPrem: false, hubSandboxed: false },
    start: { ...(reviewer.backend ? { create: createReviewer, daemonPort: "reviewer-print" as const } : {}), forms: ["headless"], defaultForm: "headless", ownsTerminal: () => false,
      launch: unavailableLaunch,
      conductorStartable: true, hubSwitches: [], ownedFlags: [] },
    identity: { mcp: "env" },
    permission: { modes: {}, readOnly: { kind: "hub-gate", allow: ["read", "search", "think"] }, unmanaged: "fresh read-only reviewer; an isolation receipt is required before startup" },
    session: { idField: "sessionId", currentId: () => undefined, freshOnRestore: true, launchKind: "reviewer-print", crashPlan: () => ({ resume: {}, how: "starts a fresh isolated review session" }) },
    turnEnd: "adapter", budget: { account: kind }, routing: { reviewOnly: true },
    reviewer, cli: { command: kind, startWords: () => [] }, display,
  };
}
const codexVariant = reviewerVariant("codex", "Codex reviewer", { backend: codexReviewerBackend, defaultPool: true, declaration: "explicit" }, CODEX_DISPLAY);
export const CODEX_REVIEWER_VARIANT: AdapterDefinition = { ...codexVariant, start: { ...codexVariant.start, create: createCodexReviewer } };
export const KIMI_REVIEWER_VARIANT = reviewerVariant("kimi", "Kimi reviewer", { backend: kimiReviewerBackend, defaultPool: true, declaration: "explicit" }, KIMI_DISPLAY);
/** Data-only declared placeholder for route explanations; no factory, backend or native argv. */
export const AGY_REVIEWER_VARIANT: AdapterDefinition = {
  ...reviewerVariant("agy", "agy reviewer", { defaultPool: false, declaration: "automatic", unavailable: "agy is an implementer peer (#485)" }, { palette: { fg: "#6558a6", bg: "#f1effa" } }),
  optional: true,
};
