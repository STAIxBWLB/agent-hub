import type { UsageWindow } from "../../hub/budget.ts";

/** Codex `rateLimits` snapshot (account/rateLimits/read, account/rateLimits/updated) -> windows. */
export function codexWindows(rateLimits: any): UsageWindow[] {
  const out: UsageWindow[] = [];
  // The slot decides (primary = short window, secondary = long one) and the duration overrides it when present:
  // readings are keyed by window id, so two windows must never both come out as "5h".
  for (const [w, slot] of [[rateLimits?.primary, "5h"], [rateLimits?.secondary, "week"]] as const) {
    if (!w || typeof w.usedPercent !== "number") continue;
    const mins = typeof w.windowDurationMins === "number" ? w.windowDurationMins : undefined;
    const id = mins === undefined ? slot : mins > 600 ? "week" : "5h";
    if (out.some((o) => o.id === id)) continue; // both slots claim the same window: keep the first, never overwrite
    out.push({ id, used: w.usedPercent / 100, ...(w.resetsAt ? { resetsAt: w.resetsAt * 1000 } : {}), ...(mins ? { windowMins: mins } : {}), source: "codex rateLimits" });
  }
  if (rateLimits?.rateLimitReachedType && !out.some((w) => w.used >= 1)) out.push({ id: "5h", used: 1, source: `codex ${rateLimits.rateLimitReachedType}` });
  return out;
}

/** Claude Code status line `rate_limits` -> windows. */
export function claudeWindows(rateLimits: any): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const [key, id, mins] of [["five_hour", "5h", 300], ["seven_day", "week", 10_080]] as const) {
    const w = rateLimits?.[key];
    if (!w || typeof w.used_percentage !== "number") continue;
    const resets = Number(w.resets_at);
    out.push({ id, used: w.used_percentage / 100, ...(resets ? { resetsAt: resets < 1e12 ? resets * 1000 : resets } : {}), windowMins: mins, source: "claude status line" });
  }
  return out;
}
