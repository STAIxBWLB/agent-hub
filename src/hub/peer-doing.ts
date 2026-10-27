import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";

/**
 * #878: what a peer is doing, derived from signals the hub already receives (a Claude session's title and todo
 * list, a Codex thread name and plan, an ACP plan). Daemon memory only: never persisted, logged, captured or relayed.
 */
export interface PeerDoing { text: string; source: "title" | "todo"; at: number }
export type DoingKind = "title" | "todo" | "reset";

export const DOING_MAX = 120;
export const DOING_STUB = "[private]";
/** At most this much of a transcript is read per signal; lines over TITLE_LINE_MAX are skipped unparsed. */
export const TITLE_READ_MAX = 1024 * 1024;
export const TITLE_LINE_MAX = 64 * 1024;

/** One line of display text: controls and line breaks become spaces, cut to DOING_MAX code points. */
export function doingText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
  return text ? [...text].slice(0, DOING_MAX).join("") : undefined;
}

type Observed = PeerDoing & { private: boolean };

/** The current item if there is one, else the title. Privacy is decided when a value is observed and again when shown. */
export class DoingTracker {
  private title: Observed | undefined;
  private item: Observed | undefined;

  /** `isPrivate` is the hub's screen at observation time; a throw counts as private. An empty text clears that kind. */
  observe(kind: "title" | "todo", value: unknown, isPrivate: (text: string) => boolean, at = Date.now()): void {
    const text = doingText(value);
    let hidden = true;
    if (text !== undefined) try { hidden = isPrivate(text); } catch { /* a failed screen is a stub */ }
    const next = text === undefined ? undefined : { text, source: kind, at, private: hidden };
    if (kind === "title") this.title = next; else this.item = next;
  }

  /** `privateNow`: the peer owns or reviews a PII task, or is in a private turn. */
  view(privateNow: boolean): PeerDoing | undefined {
    const value = this.item ?? this.title;
    if (!value) return undefined;
    return { text: value.private || privateNow ? DOING_STUB : value.text, source: value.source, at: value.at };
  }
}

/** Where the last read of a transcript stopped; `skip` drops the rest of a line too long for one read. */
export interface TitleCursor { path: string; offset: number; skip: boolean }

/**
 * The latest `{"type":"ai-title","aiTitle":...}` row appended since `cursor`, reading at most TITLE_READ_MAX bytes and
 * only whole lines. Undefined when none was appended; a missing, foreign or unreadable file reads nothing.
 */
export function readAiTitle(cursor: TitleCursor): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(cursor.path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    if (st.size < cursor.offset) { cursor.offset = 0; cursor.skip = false; } // replaced or truncated: start over
    const length = Math.min(st.size - cursor.offset, TITLE_READ_MAX);
    if (length <= 0) return undefined;
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, cursor.offset);
    // Lines end at a newline byte: decoding first would misplace the offset after a split multi-byte character.
    const end = buf.subarray(0, read).lastIndexOf(10);
    if (end === -1) {
      if (read === TITLE_READ_MAX) { cursor.offset += read; cursor.skip = true; } // inside a line longer than one read
      return undefined;
    }
    let at = cursor.skip ? buf.indexOf(10) + 1 : 0, title: string | undefined;
    cursor.skip = false;
    while (at <= end) {
      const next = buf.indexOf(10, at);
      if (next - at <= TITLE_LINE_MAX) {
        const line = buf.subarray(at, next).toString("utf8");
        if (line.includes("\"ai-title\"")) {
          try {
            const row = JSON.parse(line);
            if (row?.type === "ai-title" && typeof row.aiTitle === "string") title = row.aiTitle;
          } catch { /* a partial or foreign line */ }
        }
      }
      at = next + 1;
    }
    cursor.offset += end + 1;
    return title;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const SUBJECT_CAP = 256;

/**
 * One Claude session's current item, from the tool input its PreToolUse hook already sends: TodoWrite's in-progress
 * todo, or the task TaskUpdate puts in progress. Answers undefined for no change, null for no current item.
 */
export class ClaudeTodoSource {
  private readonly subjects = new Map<string, string>();
  private task: string | undefined;

  item(tool: string, input: Record<string, unknown>): string | null | undefined {
    if (tool === "TodoWrite") {
      if (!Array.isArray(input.todos)) return undefined;
      this.task = undefined;
      const todo = input.todos.find((t: unknown) => (t as { status?: unknown } | null)?.status === "in_progress") as { activeForm?: unknown; content?: unknown } | undefined;
      return doingText(todo?.activeForm) ?? doingText(todo?.content) ?? null;
    }
    if (tool !== "TaskUpdate" || (typeof input.taskId !== "string" && typeof input.taskId !== "number")) return undefined;
    const id = String(input.taskId), subject = doingText(input.subject);
    if (subject) {
      this.subjects.delete(id); this.subjects.set(id, subject);
      if (this.subjects.size > SUBJECT_CAP) this.subjects.delete(this.subjects.keys().next().value as string);
    }
    // ponytail: a task's subject is known only from a TaskUpdate that names it (TaskCreate's id is in its result, which
    // the hook does not send); an unknown one shows no current item. Forward the PostToolUse result if that matters.
    const text = () => doingText(input.activeForm) ?? this.subjects.get(id) ?? null;
    if (input.status === "in_progress") { this.task = id; return text(); }
    if (id !== this.task) return undefined;
    if (input.status === undefined) return text();
    this.task = undefined;
    return null;
  }
}
