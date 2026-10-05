import type { RelayRequestRecord } from "../src/models/relay.ts";

export const PI_ROUTE_SENTINEL = "PI_HUB_AUTO_OK";
type Verdict = "passed" | "failed" | "cancelled" | "unknown";
// Only closed dispatch records can certify a route; backend status is diagnostic state.
export type SmokeDispatch = Pick<RelayRequestRecord, "id" | "alias" | "outcome" | "identified" | "identitySource" | "durationMs"> & {
  dispatchGroupId?: string;
  fallbackOfId?: string;
  failureClass?: string;
  httpStatus?: number;
};
const aliases = new Set(["mlx/fast", "dgx/fast", "dgx/coding"]);
const failureClasses = new Set(["startup", "transport", "network", "http", "timeout", "cancelled", "admission", "configuration", "upstream", "unknown"]);
const safeId = (id: string | undefined) => id && /^[a-zA-Z0-9-]{1,80}$/.test(id) ? id : undefined;
const outcome = (records: SmokeDispatch[]): Verdict => !records.length ? "unknown"
  : records.some(r => r.outcome === "failed") ? "failed"
  : records.some(r => r.outcome === "cancelled") ? "cancelled" : "passed";

export function piSmokeVerdict(input: { answer: string; failed: boolean; choices: string[]; requests: SmokeDispatch[]; requirePrimary?: boolean }) {
  const dispatches = input.requests.map(r => ({
    id: safeId(r.id), dispatchGroupId: safeId(r.dispatchGroupId), fallbackOfId: safeId(r.fallbackOfId),
    alias: aliases.has(r.alias) ? r.alias : "unknown", outcome: r.outcome,
    identified: r.identified, identitySource: r.identitySource,
    durationMs: Number.isFinite(r.durationMs) ? Math.max(0, r.durationMs) : 0,
    failureClass: r.failureClass && failureClasses.has(r.failureClass) ? r.failureClass : undefined,
    httpStatus: Number.isInteger(r.httpStatus) && r.httpStatus! >= 100 && r.httpStatus! <= 599 ? r.httpStatus : undefined,
  }));
  const primary = dispatches.filter(r => !r.fallbackOfId);
  const fallback = dispatches.filter(r => !!r.fallbackOfId);
  const nativeResponse = !input.failed && input.answer === PI_ROUTE_SENTINEL ? "passed" : "failed";
  const primaryRoute = outcome(primary);
  const fallbackRoute = outcome(fallback);
  const fallbackOccurred = fallback.length > 0;
  const connectivity = nativeResponse === "passed" && dispatches.some(r => r.outcome === "completed") && input.choices.length > 0;
  const passed = connectivity && (!input.requirePrimary || (primaryRoute === "passed" && !fallbackOccurred));
  return { route: "hub/auto", policy: input.requirePrimary ? "require-primary" : "connectivity", passed,
    nativeResponse, primaryRoute, fallbackRoute, fallbackOccurred,
    choices: input.choices.map(alias => aliases.has(alias) ? alias : "unknown"), dispatches };
}
