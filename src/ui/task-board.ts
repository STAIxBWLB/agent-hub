/** Only structural public fields enter the board model; never titles, details or history. */
export interface BoardCardInput {
  id: number; state: string; owner?: string | null; reviewer?: string | null;
  deps?: readonly number[]; reserved?: string | null; urgent?: boolean; priority?: number; started?: boolean;
}
export interface BoardPeerInput { state?: string; attached?: boolean; rostered?: boolean; needsReview?: number; }
export interface BoardCardState {
  id: number; column: string; priority: number; starred: boolean; waiting: string[];
  assignable: boolean; pull: boolean; returnable: boolean;
}
export interface BoardColumns {
  columns: { id: string; label: string; ready: BoardCardState[]; waiting: BoardCardState[] }[];
  unknown: number[];
}
/** Self-contained for the hashed dashboard script, using exactly the same model as tests. */
export function boardColumns(tasks: readonly BoardCardInput[], peers: Readonly<Record<string, BoardPeerInput>>): BoardColumns {
  const columns: BoardColumns["columns"] = [
    { id: "backlog", label: "Backlog", ready: [], waiting: [] },
    { id: "todo", label: "To Do", ready: [], waiting: [] },
    { id: "progress", label: "In Progress", ready: [], waiting: [] },
    { id: "review", label: "Review / QA", ready: [], waiting: [] },
    { id: "done", label: "Done", ready: [], waiting: [] },
  ];
  const states = new Map(tasks.map(task => [task.id, task.state])), unknown: number[] = [];
  for (const task of tasks) {
    const index = task.state === "backlog" ? 0 : task.state === "proposed" ? 1 : ["in_progress", "changes_requested"].includes(task.state) ? 2 : task.state === "in_review" ? 3 : task.state === "approved" ? 4 : -1;
    const column = columns[index];
    if (!column) { unknown.push(task.id); continue; }
    const waiting: string[] = [];
    if (task.state === "proposed") {
      if ((task.deps ?? []).some(id => states.get(id) !== "approved")) waiting.push("dependencies not approved");
      if (task.reserved && !task.owner) waiting.push("reserved owner not assigned");
      if (task.owner) {
        const peer = Object.hasOwn(peers, task.owner) ? peers[task.owner] : undefined;
        if (!peer || !["idle", "busy", "paused", "offline"].includes(peer.state ?? "")) waiting.push("owner status unknown");
        else if (peer.state === "paused" || (peer.needsReview ?? 0) > 0) waiting.push("owner delivery held");
        else if (peer.state === "offline" || peer.attached === false || peer.rostered === false) waiting.push("owner unavailable");
      }
    }
    const priority = task.urgent === true ? 0 : Number.isInteger(task.priority) && task.priority! >= 0 && task.priority! <= 3 ? task.priority! : 2;
    const card: BoardCardState = { id: task.id, column: column.id, priority, starred: priority <= 1, waiting,
      assignable: ["proposed", "in_progress", "changes_requested"].includes(task.state),
      pull: task.state === "backlog", returnable: task.state === "proposed" && !task.owner && task.started === false };
    (waiting.length ? column.waiting : column.ready).push(card);
  }
  return { columns, unknown };
}
