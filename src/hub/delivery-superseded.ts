import type { Envelope } from "./envelope.ts";
import type { Task } from "./board.ts";

/** Evidence only, never task text: a mixed/unknown/live row requires a person's decision. */
export function supersededDeliveryReason(
  originals: readonly Envelope[],
  board: { get(id: number): Pick<Task, "id" | "state" | "owner" | "reviewer"> | undefined },
  recipient: string,
): string | undefined {
  if (!originals.length) return undefined;
  const reasons = new Set<string>();
  for (const env of originals) {
    if (env.from !== "hub") return undefined;
    if (env.kind === "presence") { reasons.add("presence"); continue; }
    if (env.kind !== "task" && env.kind !== "review") return undefined;
    if (!env.refs?.task || !/^[1-9][0-9]*$/.test(env.refs.task)) return undefined;
    const task = board.get(Number(env.refs.task));
    if (!task) return undefined;
    if (task.state === "approved") reasons.add(`task #${task.id} approved`);
    else if (env.kind === "review" && (task.state !== "in_review" || task.reviewer !== recipient)) reasons.add(`task #${task.id} review moved`);
    else if (env.kind === "task" && task.owner !== recipient) reasons.add(`task #${task.id} owner moved`);
    else return undefined;
  }
  return `superseded: ${[...reasons].join("; ")}`;
}
