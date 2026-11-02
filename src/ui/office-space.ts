/**
 * officeModel() -> acon SpaceScene (#1012 Part 2). Pure: no DOM, no I/O, no clock beyond the model's own.
 *
 * Reads only the scene officeModel built, which is allowlisted by #264 (peer states, queue counts and modes; task ids,
 * classes, states, owners and public titles; approval counts; link and arc ids). No envelope body, task detail,
 * approval title, path or symbol can reach it, and test/acon-plugin.test.ts pins that with the #264 marker fixture.
 */
import type { OfficeScene } from "./office-model.ts";

type Tone = "ok" | "warn" | "err" | "neutral";
type ActorState = "idle" | "working" | "waiting" | "blocked" | "away";
type ZoneKind = "queue" | "work" | "review" | "done";
type LinkKind = "message" | "overlap" | "conflict" | "cohort";
interface Link { panel: string; params?: Record<string, string> }
export interface SpaceScene {
  actors: { id: string; name: string; state: ActorState; pet?: string; card?: string;
    marks?: { kind: "approval" | "inbox" | "paused" | "mode"; text: string }[]; link: Link }[];
  zones: { id: string; title: string; kind?: ZoneKind; count: number }[];
  cards: { id: string; title: string; zone: string; owner?: string; tone?: Tone; link: Link }[];
  links?: { kind: LinkKind; from: string; to: string; label?: string; at?: string }[];
}

const ZONES: Record<string, { kind: ZoneKind; title: string }> = {
  todo: { kind: "queue", title: "To do" }, work: { kind: "work", title: "Work floor" },
  review: { kind: "review", title: "Review" }, done: { kind: "done", title: "Done" },
};
const clip = (text: string, max = 200) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const ID = /[^A-Za-z0-9._:-]/g;
const safeId = (text: string) => text.replace(ID, "_").slice(0, 128);

/** officeModel desk condition -> SpaceScene actor state (the shell picks pet rows by state). */
function actorState(condition: string, attached: boolean, approvals: number, needsReview: number): ActorState {
  if (!attached || condition === "offline") return "away";
  if (condition === "waiting" || approvals > 0) return "waiting";
  if (needsReview > 0) return "blocked";
  if (condition === "busy") return "working";
  if (condition === "paused") return "idle";
  return "idle";
}

/**
 * Maps one project's office scene. `project.id` prefixes every id so scenes from several projects never collide;
 * `project.label` (set when more than one project runs) is prefixed to actor names.
 */
export function officeSpace(model: OfficeScene, project: { id: string; label?: string }, now?: number): SpaceScene {
  const pre = (id: string | number) => safeId(`${project.id}:${id}`);
  const name = (peer: string) => clip(project.label ? `${project.label} / ${peer}` : peer, 64);
  // Links name the owning project so a multi-project console opens the right one (the panel's show() selects it).
  const board: Link = { panel: "board", params: { project: project.id } }, agents: Link = { panel: "agents", params: { project: project.id } };
  const actors: SpaceScene["actors"] = model.desks.map((desk) => {
    const marks: NonNullable<SpaceScene["actors"][number]["marks"]> = [];
    if (desk.approvals > 0) marks.push({ kind: "approval", text: desk.approvals === 1 ? "1 approval" : `${desk.approvals} approvals` });
    const inbox = desk.tray.queued + desk.tray.needsReview;
    if (inbox > 0) marks.push({ kind: "inbox", text: `${inbox} queued` });
    if (desk.condition === "paused") marks.push({ kind: "paused", text: "paused" });
    if (desk.mode) marks.push({ kind: "mode", text: clip(desk.mode, 40) });
    // The card is only the bubble's attributed task ("#id ..."): a peer reviewing #2 while owning #1 shows #2, an empty bubble shows none.
    const attributed = /^#(\d+) /.exec(desk.bubble)?.[1];
    const card = attributed ? { id: Number(attributed) } : undefined;
    return { id: pre(desk.id), name: name(desk.id), state: actorState(desk.condition, desk.attached, desk.approvals, desk.tray.needsReview),
      ...(card ? { card: pre(card.id) } : {}), ...(marks.length ? { marks } : {}), link: agents };
  });
  const zones: SpaceScene["zones"] = model.rooms.map((room) => ({ id: pre(room.id), title: ZONES[room.id]?.title ?? clip(room.label, 60), ...(ZONES[room.id] ? { kind: ZONES[room.id]!.kind } : {}), count: Math.max(0, room.count) }));
  const zoneOf = (placement: string | undefined): string | undefined => {
    if (!placement) return undefined;
    if (placement.startsWith("room:")) return pre(placement.slice(5));
    if (placement === "shelf:done") return pre("done");
    if (placement.startsWith("desk:")) return pre("work");
    return undefined;
  };
  const cards: SpaceScene["cards"] = [];
  const seen = new Set<number>();
  for (const card of [...model.desks.flatMap((d) => d.cards), ...model.rooms.flatMap((r) => r.cards), ...(model.attributedCards ?? [])]) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    const zone = zoneOf(model.placed[String(card.id)]);
    if (!zone) continue;
    const tone: Tone = card.rework ? "err" : card.waiting ? "warn" : card.state === "approved" ? "ok" : "neutral";
    // label is "#id public title"; the public view already stubs a private task as [pii].
    cards.push({ id: pre(card.id), title: clip(card.label), zone, ...(card.owner ? { owner: pre(card.owner) } : {}), tone, link: board });
  }
  const desks = new Set(model.desks.map((d) => d.id));
  const links: NonNullable<SpaceScene["links"]> = [];
  const KINDS: Record<string, LinkKind> = { overlap: "overlap", conflict: "conflict", cohort: "cohort" };
  for (const link of model.links) {
    const kind = KINDS[link.kind] ?? (/conflict/.test(link.kind) ? "conflict" : /cohort/.test(link.kind) ? "cohort" : "overlap");
    const peers = link.peers.filter((p) => desks.has(p));
    for (let i = 0; i + 1 < peers.length; i += 1) links.push({ kind, from: pre(peers[i]!), to: pre(peers[i + 1]!), ...(link.tasks.length ? { label: clip(link.tasks.map((t) => `#${t}`).join(" "), 60) } : {}) });
  }
  for (const arc of model.arcs) {
    if (!desks.has(arc.from)) continue;
    // The model's arc clock stops in a quiet project; with the wall clock, an expired arc never takes a slot under the link cap.
    if (now !== undefined && Number.isFinite(arc.until) && arc.until <= now) continue;
    const at = Number.isFinite(arc.until) ? new Date(arc.until - 10_000).toISOString() : undefined;
    // A broadcast arc has an empty `to` (office-model contract): it reaches every visible desk but the sender, as on the dashboard.
    const targets = arc.to.length ? arc.to : [...desks];
    for (const to of targets.filter((p) => desks.has(p) && p !== arc.from)) links.push({ kind: "message", from: pre(arc.from), to: pre(to), ...(arc.task ? { label: `#${arc.task}` } : {}), ...(at ? { at } : {}) });
  }
  // An attributed task that is not on the floor (not placed) has no card to point at.
  const placedCards = new Set(cards.map((c) => c.id));
  for (const actor of actors) if (actor.card && !placedCards.has(actor.card)) delete actor.card;
  return { actors, zones, cards, links };
}

/** acon's SPACE_CAPS: a scene over them fails conformance, so the plugin trims before sending (newest links kept). */
export const SPACE_CAPS = { actors: 32, cards: 200, links: 64 } as const;

/** Joins per-project scenes within acon's caps. */
export function mergeSpaces(scenes: SpaceScene[]): SpaceScene {
  // Cap actors and cards first, then keep only references inside what was kept, so links to cut actors never crowd out visible ones.
  const actors = scenes.flatMap((s) => s.actors).slice(0, SPACE_CAPS.actors);
  const actorIds = new Set(actors.map((a) => a.id));
  const cards = scenes.flatMap((s) => s.cards).slice(0, SPACE_CAPS.cards).map((c) => c.owner && !actorIds.has(c.owner) ? (({ owner: _owner, ...rest }) => rest)(c) : c);
  const cardIds = new Set(cards.map((c) => c.id));
  const kept = actors.map((a) => a.card && !cardIds.has(a.card) ? (({ card: _card, ...rest }) => rest)(a) : a);
  const links = scenes.flatMap((s) => s.links ?? []).filter((l) => actorIds.has(l.from) && actorIds.has(l.to));
  return { actors: kept, zones: scenes.flatMap((s) => s.zones), cards, links: links.slice(Math.max(0, links.length - SPACE_CAPS.links)) };
}
