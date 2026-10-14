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
  /** Optional (phase 3): the open turn's start, attributed task id and attribution kind. Absent on older daemons. */
  turn?: { since?: number; task?: number; attribution?: string };
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
  /** Optional (phase 3): the task's check is running; the task stays in_progress meanwhile. */
  checking?: boolean;
}
/** Optional (phase 3): a warning line between desks. Task and peer ids only, never paths or symbols. */
export interface OfficeLinkInput {
  kind?: string;
  tasks?: readonly number[];
  peers?: readonly string[];
  [key: string]: unknown;
}
/** The event-row fields the scene reads from `events[]`. Bodies and reasons are never read. */
export interface OfficeEventInput {
  seq?: number;
  event?: {
    t?: string;
    peer?: string;
    peers?: readonly string[];
    state?: string;
    dropped?: string;
    env?: { from?: string; to?: readonly string[]; kind?: string; priority?: string; ts?: number; refs?: { task?: string }; [key: string]: unknown };
    [key: string]: unknown;
  };
}
export interface OfficeSnapshotInput {
  status?: { peers?: Record<string, OfficePeerInput> };
  tasks?: readonly OfficeTaskInput[];
  permissions?: readonly { peer?: string }[];
  budget?: Record<string, { paused?: { reason?: string; resetsAt?: number | null } | null; [key: string]: unknown }>;
  events?: readonly OfficeEventInput[];
  links?: readonly OfficeLinkInput[];
}
export interface OfficeLink {
  kind: string;
  tasks: number[];
  peers: string[];
}
export interface OfficeCounts {
  proposed: number; waiting: number; in_progress: number; in_review: number; changes_requested: number; approved: number;
  backlog?: number;
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
  /** The task's check is running; the card stays at its owner's desk. */
  checking: boolean;
  /** Visible text: "#id public title". */
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
  /** "#id class" of the turn's attributed task (phase 3, exact), else of the peer's single in_progress task; empty when unknown. Never guessed. */
  bubble: string;
  /** The peer is paused with a turn still open: "finishing a turn" under the Break sign. */
  finishing: boolean;
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
/** One message arc between desks (or from the hub/console anchor). Ids, kind and timing only. */
export interface OfficeArc {
  seq: number;
  from: string;
  /** Recipient peer ids; empty means a broadcast (the renderer fans out to every visible desk). */
  to: string[];
  kind: string;
  priority: string;
  /** refs.task, a numeric task id string; empty when the envelope names no task. */
  task: string;
  dropped: string;
  /** Wall time (ms) after which the arc has faded out; the renderer fades with CSS, the model purges lazily. */
  until: number;
}
/** A delivery warning mark at a desk, from an overflow / undeliverable / stale / quiet event row. */
export interface OfficeAlert {
  seq: number;
  peer: string;
  kind: string;
  until: number;
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
  links: OfficeLink[];
  /** Sticky desk assignment; pass the whole scene back as `previous` so slots survive churn. */
  slots: Record<string, number>;
  /** Task id -> placement ("room:todo" | "room:work" | "room:review" | "shelf:done" | "desk:<peer>" | "counted:unknown"). */
  placed: Record<string, string>;
  arcs: OfficeArc[];
  alerts: OfficeAlert[];
  /** Peer -> last busy state row, so a short turn stays visible for a few seconds (the busy latch). */
  latched: Record<string, { seq: number; until: number }>;
  /** True = draw final positions with no motion: first snapshot, after a project switch, a snapshot gap over 3 s, or more than 6 transitions at once. */
  settle: boolean;
  /** Wall time of the last change; carried unchanged while nothing moves so an idle snapshot re-renders identically. */
  at: number;
  /** Newest envelope timestamp seen; expires arcs on the snapshot's own clock, never on wall time. */
  eventTime: number;
  /** Newest event seq consumed; dedupes rows when the same snapshot is rendered again. */
  lastSeq: number;
}

export function officeModel(snapshot: OfficeSnapshotInput, previous: OfficeScene | null, options: { cols?: number; now?: number }): OfficeScene {
  const FIXED = ["claude", "codex", "kimi", "pi", "local"];
  const KNOWN = ["proposed", "in_progress", "in_review", "changes_requested", "approved"];
  const GLYPHS: Record<string, string> = { idle: "○", busy: "●", offline: "×", paused: "‖", waiting: "⚑", unknown: "?" };
  const LABELS: Record<string, string> = { idle: "idle", busy: "busy", offline: "offline", paused: "paused", waiting: "waiting on approval" };
  const DESK_CAP = 12, ROOM_CARDS = 8, DESK_CARDS = 3;
  const DESK_W = 10, DESK_H = 20, DESK_DX = 12, DESK_DY = 22, DESK_COLS = 4, DESK_TOP = 3;
  const ROOM_W = 22, ROOM_H = 29, ROOM_DX = 23, ROOM_DY = 30;
  const ROOM_CARD_H = 7 / 3, ROOM_CARD_GAP = 0.5;
  const ARC_MS = 10_000, LATCH_MS = 3_000, SETTLE_GAP_MS = 3_000, SETTLE_MAX_MOVES = 6, ARC_CAP = 12, ALERT_CAP = 12;
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const cols = Math.max(1, Math.floor(num(options?.cols) || 1));
  const now = num(options?.now) || Date.now();
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
    if (state === "backlog") { counts.backlog = (counts.backlog ?? 0) + 1; waitingById.set(task.id, false); continue; }
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
  const classById = new Map<number, string>();
  for (const task of tasks) classById.set(task.id, text(task.class) || "task");
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
    const checking = task.checking === true;
    const owner = text(task.owner);
    const reviewer = text(task.reviewer);
    let name = `#${task.id} ${taskClass}: ${text(task.title)} (${state.replaceAll("_", " ")})`;
    if (waiting) name += ", waiting on dependencies";
    if (rework) name += ", rework";
    if (checking) name += ", check running";
    if (state === "in_review") name += `, ${owner || "unassigned"} reviewed by ${reviewer || "unassigned"}`;
    return { id: task.id, taskClass, state, owner, reviewer, waiting, rework, checking, label: `#${task.id} ${text(task.title)}`, name, x, y, w, h };
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
    // The open turn's attributed task names the bubble exactly (phase 3); without it the
    // single-in_progress-task heuristic applies, and otherwise there is no bubble. Never guessed.
    const turn = peer.turn && typeof peer.turn === "object" ? peer.turn : undefined;
    const turnTask = turn && typeof turn.task === "number" && Number.isSafeInteger(turn.task) ? turn.task : undefined;
    const bubble = turnTask !== undefined ? `#${turnTask} ${classById.get(turnTask) ?? "task"}`
      : !Object.hasOwn(peer, "turn") && current.length === 1 ? `#${current[0]!.id} ${text(current[0]!.class) || "task"}` : "";
    const finishing = turn !== undefined && condition === "paused";
    const label = LABELS[condition] ?? state;
    const parts = [condition === "busy" ? (bubble ? `busy on task ${bubble}` : "busy")
      : condition === "waiting" ? `waiting on approval (${count})`
      : condition === "paused" && breakNote ? `paused: ${breakNote}`
      : label];
    if (finishing) parts.push("finishing a turn");
    if (condition !== "waiting" && count > 0) parts.push(`${count} approval${count === 1 ? "" : "s"} waiting`);
    if (!attached) parts.push("disconnected, work retained");
    // An over-full desk shows two chips and a "+N more" line in the third slot.
    const shown = work.length > DESK_CARDS ? work.slice(0, DESK_CARDS - 1) : work;
    return {
      id, slot, x, y, w: DESK_W, h: DESK_H, state, condition,
      glyph: GLYPHS[condition] ?? "?", label, name: `${id}: ${parts.join(", ")}`,
      dimmed: condition === "offline", attached, approvals: count,
      tray: { queued: num(peer.queued), important: num(peer.queuedImportant), heldBy: text(peer.heldBy), needsReview: num(peer.needsReview) },
      mode: text(peer.permissionMode), bubble, breakNote, breakResetsAt,
      finishing,
      cards: shown.map((task, index) => card(task, x + 0.8, y + 8.5 + index * 2.5, DESK_W - 1.6, 2)),
      extraCards: work.length - shown.length,
    };
  });

  const desksBottom = Math.max(0, ...desks.map(desk => desk.y + desk.h));
  const roomsY = desksBottom ? desksBottom + 2 : 0;
  const roomDefs = [
    { id: "todo", label: "To do", filterState: "proposed", list: todo, count: counts.proposed + counts.waiting },
    { id: "work", label: "Work floor", filterState: "work", list: workUnplaced, count: counts.in_progress + counts.changes_requested },
    { id: "review", label: "Review", filterState: "in_review", list: review, count: counts.in_review },
    { id: "done", label: "Done", filterState: "", list: [] as OfficeTaskInput[], count: counts.approved },
  ];
  const rooms: OfficeRoom[] = roomDefs.map((def, index) => {
    const x = (index % cols) * ROOM_DX;
    const y = roomsY + Math.floor(index / cols) * ROOM_DY;
    return {
      id: def.id, label: def.label, filterState: def.filterState, count: def.count,
      // One column at 12 px per unit: 28 px cards, 6 px gaps, eight cards at most.
      cards: def.list.slice(0, ROOM_CARDS).map((task, row) => card(task, x + 1, y + 3.4 + row * (ROOM_CARD_H + ROOM_CARD_GAP), ROOM_W - 2, ROOM_CARD_H)),
      overflow: Math.max(0, def.list.length - ROOM_CARDS),
      x, y, w: ROOM_W, h: ROOM_H,
    };
  });

  const placed: Record<string, string> = {};
  for (const task of tasks) {    const state = text(task.state);
    const owner = text(task.owner);
    placed[task.id] = state === "proposed" ? "room:todo"
      : state === "in_review" ? "room:review"
      : state === "approved" ? "shelf:done"
      : state === "in_progress" || state === "changes_requested" ? (owner && shownSet.has(owner) ? `desk:${owner}` : "room:work")
      : state === "backlog" ? "counted:backlog" : "counted:unknown";
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

  // Phase 2 marks: message arcs, delivery warnings and the busy latch, from events[] rows.
  // The first snapshot after load or a project switch (previous === null) consumes rows without
  // drawing them: no replay of history. Rows are deduped by seq so re-rendering the same
  // snapshot is idempotent. Arcs expire on the snapshot's own envelope clock (eventTime), so an
  // unchanged snapshot yields an identical model and no DOM write; wall time enters only through
  // `now` at the moment a row is first seen, and through the settle gap below.
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  let lastSeq = previous?.lastSeq ?? 0;
  let eventTime = previous?.eventTime ?? 0;
  const arcs = previous ? [...previous.arcs] : [];
  const alerts = previous ? [...previous.alerts] : [];
  const latched: Record<string, { seq: number; until: number }> = { ...(previous?.latched ?? {}) };
  let newMarks = 0;
  for (const row of events) {
    const event = row?.event;
    if (!event || typeof event !== "object") continue;
    const env = event.env && typeof event.env === "object" ? event.env : undefined;
    const envTs = num(env?.ts);
    if (envTs > eventTime) eventTime = envTs;
    const seq = num(row?.seq);
    if (seq <= (previous?.lastSeq ?? 0)) continue;
    if (seq > lastSeq) lastSeq = seq;
    if (!previous) continue;
    if (event.t === "envelope" && env) {
      arcs.push({
        seq, from: text(env.from) || "unknown",
        to: Array.isArray(env.to) ? env.to.filter((id: unknown) => typeof id === "string") : [],
        kind: text(env.kind) || "message", priority: text(env.priority), task: text(env.refs?.task), dropped: text(event.dropped),
        until: (envTs || now) + ARC_MS,
      });
      newMarks++;
    } else if (event.t === "overflow" || event.t === "undeliverable" || event.t === "stale" || event.t === "quiet") {
      const targets = event.t === "quiet" ? (Array.isArray(event.peers) ? event.peers : []) : [text(event.peer)];
      for (const peer of targets) if (typeof peer === "string" && peer) { alerts.push({ seq, peer, kind: event.t, until: now + ARC_MS }); newMarks++; }
    } else if (event.t === "state" && text(event.state) === "busy") {
      const peer = text(event.peer);
      if (peer) { latched[peer] = { seq, until: now + LATCH_MS }; newMarks++; }
    }
  }
  const keptArcs = arcs.filter((arc) => arc.until > eventTime).slice(-ARC_CAP);
  const keptAlerts = alerts.slice(-ALERT_CAP);

  const moves = transitions.cardsMoved.length + transitions.desksAdded.length + transitions.desksRemoved.length + newMarks;
  // With nothing moving the flag is carried, so an unchanged snapshot yields an identical model.
  const settle = !previous ? true : moves === 0 ? previous.settle : now - previous.at > SETTLE_GAP_MS || moves > SETTLE_MAX_MOVES;
  const at = !previous || moves > 0 ? now : previous.at;

  const desksWidth = Math.max(0, ...desks.map(desk => desk.x + desk.w));
  // Phase 3 warning lines: validated down to the three kinds and their id lists; nothing else is copied.
  const links: OfficeLink[] = [];
  for (const link of Array.isArray(snapshot?.links) ? snapshot.links : []) {
    const kind = text(link?.kind);
    if (kind !== "overlap" && kind !== "conflict" && kind !== "cohort") continue;
    const linkTasks = (Array.isArray(link?.tasks) ? link.tasks : []).filter((id: unknown) => typeof id === "number" && Number.isSafeInteger(id));
    const linkPeers = (Array.isArray(link?.peers) ? link.peers : []).filter((id: unknown) => typeof id === "string" && id.length > 0);
    if (linkTasks.length + linkPeers.length < 2) continue;
    links.push({ kind, tasks: linkTasks, peers: linkPeers });

  }
  if (links.length > 24) {
    const rank = (kind: string) => kind === "conflict" ? 0 : kind === "cohort" ? 1 : 2;
    links.sort((a, b) => rank(a.kind) - rank(b.kind));
    links.length = 24;
  }
  return {
    cols,
    width: Math.max(desksWidth, ...rooms.map(room => room.x + room.w), 1),
    height: Math.max(desksBottom, ...rooms.map(room => room.y + room.h), 1),
    desks, extraPeers, rooms, counts, transitions, slots, placed,
    links,
    arcs: keptArcs, alerts: keptAlerts, latched, settle, at, eventTime, lastSeq,
  };
}
