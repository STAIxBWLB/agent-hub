/**
 * Pure office scene model for the dashboard (#264, phase 1: the static Flat view).
 * Self-contained so `src/hub/ui.ts` injects it into the page by toString(), exactly like
 * task-progress.ts. Inputs are allowlisted: peer states, queue counts and modes; task ids,
 * classes, states, owners, reviewers, deps and public titles; approval counts by peer; budget
 * pause readings. env.body, task detail, approval titles, paths and symbols never enter;
 * test/office-model.test.ts pins that with a marker fixture.
 */

/** The peer fields the scene reads from `status.peers[id]`. Everything else is ignored. */
export interface OfficePeerInput {
  state?: string;
  attached?: boolean;
  paused?: string;
  queued?: number;
  queuedImportant?: number;
  needsReview?: number;
  heldBy?: string;
  permissionMode?: string;
}
/** The task fields the scene reads. `title` is the public view (`[pii]` stub for private tasks). */
export interface OfficeTaskInput {
  id: number;
  title?: string;
  class?: string;
  state?: string;
  owner?: string;
  reviewer?: string;
  deps?: readonly number[];
}
export interface OfficeSnapshotInput {
  status?: { peers?: Record<string, OfficePeerInput> };
  tasks?: readonly OfficeTaskInput[];
  permissions?: readonly { peer?: string }[];
  budget?: Record<string, { paused?: { reason?: string; resetsAt?: number | null } | null; [key: string]: unknown }>;
}
export interface OfficeCounts {
  proposed: number; waiting: number; in_progress: number; in_review: number; changes_requested: number; approved: number;
  unknown?: number;
}
/** One task card. Positions are grid units; the renderer maps them into the SVG viewBox. */
export interface OfficeCard {
  id: number;
  taskClass: string;
  state: string;
  owner: string;
  reviewer: string;
  waiting: boolean;
  rework: boolean;
  /** Visible text: "#id class". */
  label: string;
  /** Accessible name: "#id class: public title (state)", plus waiting/rework/review marks. */
  name: string;
  x: number; y: number; w: number; h: number;
}
export interface OfficeDesk {
  id: string;
  slot: number;
  x: number; y: number; w: number; h: number;
  state: string;
  /** idle | busy | offline | paused | waiting (approvals) | unknown; drives glyph, label and class. */
  condition: string;
  glyph: string;
  label: string;
  /** Accessible name, e.g. "codex: busy on task #12 (implement)". */
  name: string;
  dimmed: boolean;
  attached: boolean;
  approvals: number;
  tray: { queued: number; important: number; heldBy: string; needsReview: number };
  mode: string;
  /** "#id class" of the peer's single in_progress task; empty when zero, several or unknown. Never guessed. */
  bubble: string;
  breakNote: string;
  breakResetsAt: number | null;
  cards: OfficeCard[];
  extraCards: number;
}
export interface OfficeRoom {
  id: string;
  label: string;
  /** Task-list filter state the "+N more" control selects; empty when the room has none. */
  filterState: string;
  count: number;
  cards: OfficeCard[];
  overflow: number;
  x: number; y: number; w: number; h: number;
}
export interface OfficeTransitions {
  desksAdded: string[];
  desksRemoved: string[];
  cardsMoved: { id: number; from: string; to: string }[];
}
export interface OfficeScene {
  cols: number;
  width: number;
  height: number;
  desks: OfficeDesk[];
  extraPeers: number;
  rooms: OfficeRoom[];
  counts: OfficeCounts;
  transitions: OfficeTransitions;
  /** Sticky desk assignment; pass the whole scene back as `previous` so slots survive churn. */
  slots: Record<string, number>;
  /** Task id -> placement ("room:todo" | "room:work" | "room:review" | "shelf:done" | "desk:<peer>" | "counted:unknown"). */
  placed: Record<string, string>;
}

export function officeModel(snapshot: OfficeSnapshotInput, previous: OfficeScene | null, options: { cols?: number }): OfficeScene {
  const FIXED = ["claude", "codex", "kimi", "pi", "local"];
  const KNOWN = ["proposed", "in_progress", "in_review", "changes_requested", "approved"];
  const GLYPHS: Record<string, string> = { idle: "○", busy: "●", offline: "×", paused: "‖", waiting: "⚑", unknown: "?" };
  const LABELS: Record<string, string> = { idle: "idle", busy: "busy", offline: "offline", paused: "paused", waiting: "waiting on approval" };
  const DESK_CAP = 12, ROOM_CARDS = 8, DESK_CARDS = 3;
  const DESK_W = 10, DESK_H = 12, DESK_DX = 12, DESK_DY = 14, DESK_COLS = 4, DESK_TOP = 3;
  const ROOM_W = 22, ROOM_H = 25, ROOM_DX = 24, ROOM_DY = 27;
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const cols = Math.max(1, Math.floor(num(options?.cols) || 1));
  const peers = snapshot?.status?.peers && typeof snapshot.status.peers === "object" ? snapshot.status.peers : {};
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks.filter((task) => task && typeof task.id === "number") : [];
  const permissions = Array.isArray(snapshot?.permissions) ? snapshot.permissions : [];
  const budget = snapshot?.budget && typeof snapshot.budget === "object" ? snapshot.budget : {};

  // State counts mirror taskProgress (src/ui/task-progress.ts) exactly, including the waiting
  // rule on deps; test/office-model.test.ts pins the equality so a drift fails there.
  const states = new Map<number, string>();
  for (const task of tasks) states.set(task.id, text(task.state));
  const counts: OfficeCounts = { proposed: 0, waiting: 0, in_progress: 0, in_review: 0, changes_requested: 0, approved: 0 };
  const waitingById = new Map<number, boolean>();
  for (const task of tasks) {
    const state = text(task.state);
    if (!KNOWN.includes(state)) { counts.unknown = (counts.unknown ?? 0) + 1; waitingById.set(task.id, false); continue; }
    const waiting = state === "proposed" && (task.deps ?? []).some((id: number) => states.get(id) !== "approved");
    waitingById.set(task.id, waiting);
    if (waiting) counts.waiting++;
    else counts[state as "proposed" | "in_progress" | "in_review" | "changes_requested" | "approved"]++;
  }

  const approvals = new Map<string, number>();
  for (const row of permissions) {
    const peer = text(row?.peer);
    if (peer) approvals.set(peer, (approvals.get(peer) ?? 0) + 1);
  }

  // Sticky desk slots: the fixed peer order seeds the first scene; after that a peer keeps its
  // slot while others come and go, and a new peer takes the lowest slot nobody remembers.
  const slots: Record<string, number> = { ...(previous?.slots ?? {}) };
  const present = Object.keys(peers);
  const ordered = [
    ...FIXED.filter((id) => present.includes(id)),
    ...present.filter((id) => !FIXED.includes(id)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
  ];
  const usedSlots = new Set(Object.values(slots));
  let free = 0;
  for (const id of ordered) {
    if (typeof slots[id] === "number") continue;
    while (usedSlots.has(free)) free++;
    slots[id] = free;
    usedSlots.add(free);
  }
  const bySlot = [...ordered].sort((a, b) => (slots[a] ?? 0) - (slots[b] ?? 0));
  const shownIds = bySlot.slice(0, DESK_CAP);
  const shownSet = new Set(shownIds);
  const extraPeers = bySlot.length - shownIds.length;

  const byId = (a: OfficeTaskInput, b: OfficeTaskInput) => a.id - b.id;
  const todo: OfficeTaskInput[] = [], review: OfficeTaskInput[] = [], workUnplaced: OfficeTaskInput[] = [];
  const workByOwner = new Map<string, OfficeTaskInput[]>();
  for (const task of tasks) {
    const state = text(task.state);
    if (state === "proposed") todo.push(task);
    else if (state === "in_review") review.push(task);
    else if (state === "in_progress" || state === "changes_requested") {
      const owner = text(task.owner);
      if (owner && shownSet.has(owner)) {
        const list = workByOwner.get(owner) ?? [];
        list.push(task);
        workByOwner.set(owner, list);
      } else workUnplaced.push(task);
    }
  }
  todo.sort(byId); review.sort(byId); workUnplaced.sort(byId);

  const card = (task: OfficeTaskInput, x: number, y: number, w: number, h: number): OfficeCard => {
    const state = text(task.state) || "unknown";
    const taskClass = text(task.class) || "task";
    const waiting = waitingById.get(task.id) === true;
    const rework = state === "changes_requested";
    const owner = text(task.owner);
    const reviewer = text(task.reviewer);
    let name = `#${task.id} ${taskClass}: ${text(task.title)} (${state.replaceAll("_", " ")})`;
    if (waiting) name += ", waiting on dependencies";
    if (rework) name += ", rework";
    if (state === "in_review") name += `, ${owner || "unassigned"} reviewed by ${reviewer || "unassigned"}`;
    return { id: task.id, taskClass, state, owner, reviewer, waiting, rework, label: `#${task.id} ${taskClass}`, name, x, y, w, h };
  };

  const desks: OfficeDesk[] = shownIds.map((id) => {
    const raw = peers[id];
    const peer: OfficePeerInput = raw && typeof raw === "object" ? raw : {};
    const slot = slots[id] ?? 0;
    const x = (slot % DESK_COLS) * DESK_DX;
    const y = DESK_TOP + Math.floor(slot / DESK_COLS) * DESK_DY;
    const state = text(peer.state) || "unknown";
    const entry = budget[id];
    const budgetPaused = entry && typeof entry === "object" ? entry.paused : null;
    const breakNote = text(peer.paused) || (budgetPaused ? text(budgetPaused.reason) : "");
    const breakResetsAt = budgetPaused && typeof budgetPaused.resetsAt === "number" ? budgetPaused.resetsAt : null;
    const count = approvals.get(id) ?? 0;
    const condition = state === "offline" ? "offline"
      : state === "paused" || breakNote ? "paused"
      : count > 0 ? "waiting"
      : state === "busy" ? "busy"
      : state === "idle" ? "idle" : "unknown";
    const attached = peer.attached !== false;
    const work = (workByOwner.get(id) ?? []).sort(byId);
    const current = work.filter((task) => text(task.state) === "in_progress");
    const bubble = current.length === 1 ? `#${current[0]!.id} ${text(current[0]!.class) || "task"}` : "";
    const label = LABELS[condition] ?? state;
    const parts = [condition === "busy" ? (bubble ? `busy on task ${bubble}` : "busy")
      : condition === "waiting" ? `waiting on approval (${count})`
      : condition === "paused" && breakNote ? `paused: ${breakNote}`
      : label];
    if (condition !== "waiting" && count > 0) parts.push(`${count} approval${count === 1 ? "" : "s"} waiting`);
    if (!attached) parts.push("disconnected, work retained");
    return {
      id, slot, x, y, w: DESK_W, h: DESK_H, state, condition,
      glyph: GLYPHS[condition] ?? "?", label, name: `${id}: ${parts.join(", ")}`,
      dimmed: condition === "offline", attached, approvals: count,
      tray: { queued: num(peer.queued), important: num(peer.queuedImportant), heldBy: text(peer.heldBy), needsReview: num(peer.needsReview) },
      mode: text(peer.permissionMode), bubble, breakNote, breakResetsAt,
      cards: work.slice(0, DESK_CARDS).map((task, index) => card(task, x + 0.8, y + 7.9 + index * 1.05, DESK_W - 1.6, 1)),
      extraCards: Math.max(0, work.length - DESK_CARDS),
    };
  });

  const desksBottom = shownIds.length ? DESK_TOP + Math.ceil(shownIds.length / DESK_COLS) * DESK_DY - (DESK_DY - DESK_H) : 0;
  const roomsY = desksBottom ? desksBottom + 2 : 0;
  const roomDefs = [
    { id: "todo", label: "To Do", filterState: "proposed", list: todo, count: counts.proposed + counts.waiting },
    { id: "work", label: "Work floor", filterState: "in_progress", list: workUnplaced, count: counts.in_progress + counts.changes_requested },
    { id: "review", label: "Review", filterState: "in_review", list: review, count: counts.in_review },
    { id: "done", label: "Done shelf", filterState: "", list: [] as OfficeTaskInput[], count: counts.approved },
  ];
  const rooms: OfficeRoom[] = roomDefs.map((def, index) => {
    const x = (index % cols) * ROOM_DX;
    const y = roomsY + Math.floor(index / cols) * ROOM_DY;
    return {
      id: def.id, label: def.label, filterState: def.filterState, count: def.count,
      cards: def.list.slice(0, ROOM_CARDS).map((task, row) => card(task, x + 1, y + 3.4 + row * 2.5, ROOM_W - 2, 2.2)),
      overflow: Math.max(0, def.list.length - ROOM_CARDS),
      x, y, w: ROOM_W, h: ROOM_H,
    };
  });

  const placed: Record<string, string> = {};
  for (const task of tasks) {
    const state = text(task.state);
    const owner = text(task.owner);
    placed[task.id] = state === "proposed" ? "room:todo"
      : state === "in_review" ? "room:review"
      : state === "approved" ? "shelf:done"
      : state === "in_progress" || state === "changes_requested" ? (owner && shownSet.has(owner) ? `desk:${owner}` : "room:work")
      : "counted:unknown";
  }
  const transitions: OfficeTransitions = { desksAdded: [], desksRemoved: [], cardsMoved: [] };
  if (previous) {
    const prevPlaced = previous.placed ?? {};
    for (const [idText, place] of Object.entries(placed)) {
      const before = prevPlaced[idText];
      if (before && before !== place) transitions.cardsMoved.push({ id: Number(idText), from: before, to: place });
    }
    transitions.cardsMoved.sort((a, b) => a.id - b.id);
    const prevDesks = new Set((previous.desks ?? []).map((desk) => desk.id));
    transitions.desksAdded = shownIds.filter((id) => !prevDesks.has(id));
    transitions.desksRemoved = [...prevDesks].filter((id) => !shownSet.has(id)).sort();
  }

  const roomRows = Math.ceil(rooms.length / cols);
  const desksWidth = shownIds.length ? Math.min(shownIds.length, DESK_COLS) * DESK_DX - 2 : 0;
  return {
    cols,
    width: Math.max(desksWidth, Math.min(rooms.length, cols) * ROOM_DX - 2, 1),
    height: roomsY + roomRows * ROOM_DY - 2,
    desks, extraPeers, rooms, counts, transitions, slots, placed,
  };
}
