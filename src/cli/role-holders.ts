/** Read recorded task-holder metadata only; presentation never chooses a holder or parses note text. */
export type TaskHolderRole = "planner" | "owner" | "reviewer";
const word = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const entries = (task: any): Record<string, unknown>[] => Array.isArray(task?.history)
  ? task.history.filter((entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry)) : [];

export function taskHolderText(task: any, role: TaskHolderRole): string {
  const holder = word(task?.[role]);
  if (!holder) return role === "owner" && word(task?.reserved) ? `${task.reserved} (reserved)` : "-";
  const history = entries(task);
  const reasons: string[] = [];
  if (role === "planner") {
    const recorded = history.findLast(entry => entry.planner === holder && word(entry.plannerReason));
    const reason = word(task?.plannerReason) ?? word(recorded?.plannerReason);
    if (reason) reasons.push(reason);
  } else if (role === "reviewer") {
    const recorded = history.findLast(entry => ["assigned", "reassigned", "escalated", "done", "reviewer changed", "reviewer unavailable"].includes(String(entry.event)));
    const reason = word(task?.reviewerReason) ?? word(recorded?.reviewerReason) ?? (recorded?.event === "reviewer changed" && recorded.reason === "manual" ? "named" : undefined);
    if (reason) reasons.push(reason);
    if (task?.sameFamilyFallback === true && !reasons.includes("same-family fallback")) reasons.push("same-family fallback");
  } else {
    const recorded = history.findLast(entry => entry.owner === holder && ["assigned", "reassigned", "escalated", "backlog pulled"].includes(String(entry.event)));
    const reason = word(task?.ownerReason) ?? (recorded?.reason === "manual" && recorded.event === "reassigned" && word(recorded.by) && recorded.by !== "hub" ? "named" : word(recorded?.reason));
    if (reason) reasons.push(reason);
    if (task?.reserved === holder && !reasons.includes("reserved")) reasons.push("reserved");
  }
  return `${holder}${reasons.length ? ` (${reasons.join("; ")})` : ""}`;
}

/** The daemon's per-extra boolean stays boolean on the wire; an absent proof is not a false proof. */
export function ownerIsolationText(isolated: unknown, reason?: unknown): string | undefined {
  if (isolated === true) return "isolated";
  if (isolated === false) return `not isolated: ${word(reason) ?? "execution root not verified"}`;
  return undefined;
}
