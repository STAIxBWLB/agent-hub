import { aged, consoleCommand, LIMITS, type Reading } from "./status.ts";

const peerId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= LIMITS.maxText && !/[\p{Cc}\p{Cf}]/u.test(value);
/** A fresh partial snapshot may prove one kind independently of unrelated missing fields. */
export function attentionLines(reading: Reading, root: string, now: number): string[] {
  if (!root.startsWith("/") || reading.fetchedAt === undefined || !Number.isFinite(reading.fetchedAt)
    || !Number.isFinite(now) || now < reading.fetchedAt || !["running", "partial"].includes(aged(reading, now).state)) return [];
  const command = consoleCommand(root), lines: string[] = [];
  for (const peer of (reading.peers ?? []).slice(0, LIMITS.maxRows)) {
    if (!peerId(peer.id)) continue;
    if (Number.isSafeInteger(peer.needsReview) && Number(peer.needsReview) > 0) lines.push(`${peer.id}: ${peer.needsReview} held deliveries need review. Terminal: ${command}`);
    if (peer.budgetPaused === true) lines.push(`${peer.id}: budget pause reported. Terminal: ${command}`);
  }
  const permission = reading.permission;
  if (permission && Number.isSafeInteger(permission.until) && permission.until > now && (permission.peer === undefined || peerId(permission.peer))) {
    lines.push(`Permission request${permission.peer ? ` for ${permission.peer}` : ""} awaits you. Terminal: ${command}`);
  }
  // ponytail: status lacks exact offline-owned-in_progress facts; a bounded public read would be a separate task.
  return lines;
}
