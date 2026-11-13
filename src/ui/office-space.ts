/**
 * officeModel() -> acon SpaceScene (#1012 Part 2, #1375). Pure: no DOM, no I/O, no clock beyond the model's own.
 *
 * Reads only the scene officeModel built, which is allowlisted by #264 (peer states, queue counts, modes and configured
 * roles; task ids, classes, states, owners and public titles; approval counts; link and arc ids). No envelope body, task
 * detail, approval title, path or symbol can reach it, and test/acon-plugin.test.ts pins that with the #264 marker fixture.
 *
 * The scene type is acon's own, imported type-only from its pinned contract entry rather than hand-copied, so a field or
 * cap drift fails typecheck here instead of at a person's console.
 */
import type { SpaceScene, Tone } from "@staix/agent-console/contract";
import type { OfficeScene } from "./office-model.ts";

export type { SpaceScene };

type ActorState = SpaceScene["actors"][number]["state"];
type ZoneKind = NonNullable<SpaceScene["zones"][number]["kind"]>;
type LinkKind = NonNullable<SpaceScene["links"]>[number]["kind"];
type Link = SpaceScene["actors"][number]["link"];
type Group = NonNullable<SpaceScene["groups"]>[number];

const ZONES: Record<string, { kind: ZoneKind; title: string }> = {
  backlog: { kind: "queue", title: "Backlog" },
  todo: { kind: "queue", title: "To do" }, work: { kind: "work", title: "Work floor" },
  review: { kind: "review", title: "Review" }, done: { kind: "done", title: "Done" },
};
const clip = (text: string, max = 200) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const ID = /[^A-Za-z0-9._:-]/g;
const safeId = (text: string) => text.replace(ID, "_").slice(0, 128);
const ROLE_LIMIT = 4, ROLE_TEXT_LIMIT = 32;
/** acon's role bounds: at most 4 public role names of at most 32 characters, in the configured order. */
const rolesOf = (configured: readonly string[] | undefined): string[] =>
  (configured ?? []).filter((role) => typeof role === "string" && role.trim().length > 0 && role.length <= ROLE_TEXT_LIMIT).slice(0, ROLE_LIMIT);

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
 * Maps one project's office scene. `project.id` prefixes every id so scenes from several projects never collide, and it
 * names the scene's group too (#1375): every actor, zone and card carries that `group`, and actor names stay bare because
 * the console shows the group itself. `project.label` titles the group when the caller has a human name for the project.
 */
export function officeSpace(model: OfficeScene, project: { id: string; label?: string }, now?: number): SpaceScene {
  const pre = (id: string | number) => safeId(`${project.id}:${id}`);
  const group: Group = { id: safeId(project.id), title: clip((project.label ?? project.id).trim(), 200) || safeId(project.id) };
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
    // `since` is only what the model holds: the open turn's start, so it is present while the actor is working and absent
    // for every other state, which has no change time here. Roles are the project's configured ones, bounded by acon.
    const roles = rolesOf(desk.roles);
    const since = desk.condition === "busy" && desk.turnSince !== undefined ? new Date(desk.turnSince).toISOString() : undefined;
    return { id: pre(desk.id), name: clip(desk.id, 64), state: actorState(desk.condition, desk.attached, desk.approvals, desk.tray.needsReview), group: group.id,
      ...(card ? { card: pre(card.id) } : {}), ...(roles.length ? { roles } : {}), ...(since ? { since } : {}), ...(marks.length ? { marks } : {}), link: agents };
  });
  const zones: SpaceScene["zones"] = model.rooms.map((room) => ({ id: pre(room.id), title: ZONES[room.id]?.title ?? clip(room.label, 60), ...(ZONES[room.id] ? { kind: ZONES[room.id]!.kind } : {}), count: Math.max(0, room.count), group: group.id }));
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
    cards.push({ id: pre(card.id), title: clip(card.label), zone, ...(card.owner ? { owner: pre(card.owner) } : {}), tone, group: group.id, link: board });
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
  return { groups: [group], actors, zones, cards, links };
}

/** acon's caps: `actors`, `cards` and `links` are its SPACE_CAPS, `groups` its item bound; over them a scene fails conformance. */
export const SPACE_CAPS = { actors: 96, groups: 200, cards: 200, links: 128 } as const;

/** Joins per-project scenes within acon's caps, keeping every reference inside what was kept. */
export function mergeSpaces(scenes: SpaceScene[]): SpaceScene {
  // Declare groups first: a record's `group` must reference one of them, so a scene past the group bound loses the reference
  // (pruned like `owner` and `card` below, never left as a dangling id) instead of the whole scene failing conformance; one
  // group per project, so only 200+ running projects reach that.
  const groups: Group[] = [], declared = new Set<string>();
  for (const group of scenes.flatMap((s) => s.groups ?? [])) {
    if (groups.length >= SPACE_CAPS.groups) break;
    if (declared.has(group.id)) continue;
    declared.add(group.id);
    groups.push({ id: group.id, title: group.title });
  }
  const grouped = <T extends { group?: string }>(row: T): T => row.group === undefined || declared.has(row.group) ? row : (({ group: _group, ...rest }) => rest as T)(row);
  // Cap actors and cards first, then keep only references inside what was kept, so links to cut actors never crowd out visible ones.
  const actors = scenes.flatMap((s) => s.actors).slice(0, SPACE_CAPS.actors).map(grouped);
  const actorIds = new Set(actors.map((a) => a.id));
  const cards = scenes.flatMap((s) => s.cards).slice(0, SPACE_CAPS.cards).map((c) => c.owner && !actorIds.has(c.owner) ? (({ owner: _owner, ...rest }) => rest)(c) : c).map(grouped);
  const cardIds = new Set(cards.map((c) => c.id));
  const kept = actors.map((a) => a.card && !cardIds.has(a.card) ? (({ card: _card, ...rest }) => rest)(a) : a);
  const zones = scenes.flatMap((s) => s.zones).map(grouped);
  const links = scenes.flatMap((s) => s.links ?? []).filter((l) => actorIds.has(l.from) && actorIds.has(l.to));
  return { groups, actors: kept, zones, cards, links: links.slice(Math.max(0, links.length - SPACE_CAPS.links)) };
}
