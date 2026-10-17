import type { Envelope } from "./envelope.ts";
import type { Task } from "./board.ts";

/** Evidence only, never task text: a mixed/unknown/live row requires a person's decision. */
export function supersededDeliveryReason(
  originals: readonly Envelope[],
  board: { get(id: number): Pick<Task, "id" | "state" | "owner" | "reviewer" | "cancelled"> | undefined },
  recipient: string,
): string | undefined {
  if (!originals.length) return undefined;
  const reasons = new Set<string>();
  for (const env of originals) {
    if (env.from !== "hub") return undefined;
    if (env.kind === "presence") { reasons.add("presence"); continue; }
    if (env.kind !== "task" && env.kind !== "review") return undefined;
    if (!env.refs?.task || !/^[1-9][0-9]*$/.test(env.refs.task)) return undefined;
    const id = Number(env.refs.task);
    if (!Number.isSafeInteger(id)) return undefined;
    const task = board.get(id);
    if (!task) return undefined;
    if (task.state === "cancelled") {
      if (typeof env.refs.taskCancelled === "number" && env.refs.taskCancelled === task.cancelled?.flowRevision) return undefined;
      reasons.add(`task #${task.id} cancelled`);
    } else if (task.state === "approved") reasons.add(`task #${task.id} approved`);
    else if ((env.kind === "review" || env.refs.taskRecipient === "reviewer") && (task.state !== "in_review" || task.reviewer !== recipient)) reasons.add(`task #${task.id} review moved`);
    else if (env.kind === "task" && env.refs.taskRecipient === "owner" && task.owner !== recipient) reasons.add(`task #${task.id} owner moved`);
    else return undefined; // Untagged legacy task notices and planner coordination carry no proof of supersession.
  }
  return `superseded: ${[...reasons].join("; ")}`;
}


/** Informational context for every referenced task, including peer/user and mixed rows. Never authorizes settlement. */
export function deliveryTaskContext(
  originals: readonly Envelope[],
  board: { get(id: number): Pick<Task, "id" | "state" | "owner" | "reviewer" | "cancelled"> | undefined },
  recipient: string,
): string | undefined {
  const context = new Set<string>();
  for (const env of originals) {
    if (!env.refs?.task || !/^[1-9][0-9]*$/.test(env.refs.task)) continue;
    const id = Number(env.refs.task);
    if (!Number.isSafeInteger(id)) continue;
    const task = board.get(id);
    if (!task) continue;
    if (task.state === "cancelled") context.add(`task #${task.id} cancelled`);
    else if (task.state === "approved") context.add(`task #${task.id} approved`);
    else if (task.owner !== recipient && task.reviewer !== recipient) context.add(`task #${task.id} moved`);
    else if ((env.kind === "review" || env.refs.taskRecipient === "reviewer") && (task.state !== "in_review" || task.reviewer !== recipient)) context.add(`task #${task.id} review moved`);
  }
  return context.size ? [...context].join("; ") : undefined;
}
