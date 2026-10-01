import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Task } from "./board.ts";
import { samePlace } from "./tasks.ts";

/** A file an owner's open task changed, as the turn snapshots saw it (issue #32). */
export interface Touch {
  task: number;
  peer: string;
  path: string;
  at: number;
}

/**
 * The files `peer` just changed that another owner's open task changed before it, grouped by that task. Pure: the
 * daemon passes the turn's files, the recorded touches and the open tasks, PII ones already left out. A file only one
 * agent touched is never a conflict, even when the task it was touched for has changed hands since.
 */
export function conflictsOf(peer: string, changed: string[], touches: Touch[], open: Task[]): { task: Task; paths: string[] }[] {
  const tasks = new Map(open.map((t) => [t.id, t]));
  const mine = new Set(changed);
  const hits = new Map<number, Set<string>>();
  for (const t of touches) {
    const task = tasks.get(t.task);
    if (!task || task.owner === peer || t.peer === peer || !mine.has(t.path)) continue;
    if (!hits.has(t.task)) hits.set(t.task, new Set());
    hits.get(t.task)!.add(t.path);
  }
  return [...hits].map(([id, paths]) => ({ task: tasks.get(id)!, paths: [...paths].sort() }));
}

/**
 * For `ahub check-path`, the Claude Code PreToolUse hook (issue #32): other owners' open tasks that claim a file (refs or
 * plan paths) or changed it in a turn. Reads hub.db only, so it works whether or not the hub runs. PII tasks are left
 * out: the hook's text reaches a cloud model. `project` is the file relative to the project root, `repo` relative to
 * the repository's top level (where turn snapshots record paths).
 */
export function pathWarnings(dbFile: string, peer: string, file: { project: string; repo?: string }): string[] {
  if (!existsSync(dbFile)) return [];
  const db = new Database(dbFile, { readonly: true });
  try {
    const rows = db.query("SELECT * FROM tasks WHERE owner IS NOT NULL AND owner != ? AND state IN ('proposed', 'in_progress', 'in_review', 'changes_requested') ORDER BY id").all(peer) as Record<string, string | number | null>[];
    let touches: Touch[] = [];
    try {
      if (file.repo) touches = db.query("SELECT * FROM touches WHERE path = ? AND peer != ?").all(file.repo, peer) as Touch[];
    } catch {
      // a hub without snapshots never made the table
    }
    return rows.flatMap((r) => {
      if ((JSON.parse(String(r.signals ?? "[]")) as string[]).includes("pii")) return [];
      const refs = JSON.parse(String(r.refs ?? "{}")) as { paths?: string[] };
      const plan = JSON.parse(String(r.plan ?? "{}")) as { paths?: string[] };
      const claims = [...(refs.paths ?? []), ...(plan.paths ?? [])].some((p) => samePlace(p, file.project));
      const changed = touches.some((t) => t.task === r.id);
      if (!claims && !changed) return [];
      const how = [changed ? "changed it" : "", claims ? "claims it" : ""].filter(Boolean).join(" and ");
      // The title is another agent's text: quoted as a JSON string, so a line break in it cannot start a line of its own.
      return [`task #${r.id} ${JSON.stringify(String(r.title).slice(0, 100))} (owner ${r.owner}, ${r.state}) ${how}`];
    });
  } finally {
    db.close();
  }
}
