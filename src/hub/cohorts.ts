import type { Task } from "./board.ts";
import type { PeerId } from "./envelope.ts";

/**
 * Turn-free cohorts (issue #107): the owners of overlapping tasks, frozen into one group from the moment the overlap is
 * found until each of them has stopped after its task closed. Whether a cohort is silent is decided when it is formed
 * (turn-free on, no PII, every owner's context path verified) and never switched on later; it is lifted when an owner
 * that cannot receive facts joins or loses that path. Membership does not end when the board closes a task: a member
 * stays in until its native turn has ended after that, so a late final answer is still the cohort's.
 *
 * Completion is two-step. Each member's done is an intent. The member whose intent completes the set is selected, in
 * one synchronous step, to integrate: it is asked to check its work against the others before its done is recorded,
 * and its next done is accepted only for the same target (owner generation, cohort revision, files) once every other
 * member has stopped. Anything that changes the target asks again, a bounded number of times; past that the outcome is
 * recorded as unresolved, never as integrated.
 */

/** Integration requests for one cohort revision before the outcome is recorded as unresolved. */
export const MAX_REQUESTS = 3;

export interface Member {
  task: number;
  owner: PeerId;
  /** Changes whenever the task changes hands. */
  gen: number;
  /** When the task left the open states for its owner; its next native turn end settles it. */
  closedAt?: number;
}

export interface Integration {
  task: number;
  owner: PeerId;
  gen: number;
  revision: number;
  /** The files as they were at the last request: the next done is accepted only for this target. */
  tree: string;
  requests: number;
  /** When the last request went out: a done right after it is a retry, not a confirmation. */
  at: number;
  /** The fact offer that went out with the last request: the next done acknowledges it. */
  offer?: string;
  confirmed?: boolean;
}

export interface Cohort {
  id: number;
  /** Bumps on every change of membership, owner or completion intent. */
  revision: number;
  members: Map<number, Member>;
  silent: boolean;
  intents: Map<number, { gen: number; at: number }>;
  integration?: Integration;
  /** Members whose completed-change notice the silence withheld: what replaces it if no integration runs. */
  held: Set<number>;
}

export interface CohortDeps {
  /** Whether these owners may work without messages: turn-free on, no PII, every owner's context path verified. */
  silence: (owners: PeerId[]) => boolean;
  /**
   * Whether `peer`'s native turn ended after `since` and nothing of it ran since. Evidence is a native turn end (Codex
   * turn/completed, Claude's Stop hook), never a task approval or a delivery acknowledgement.
   */
  quiescent: (peer: PeerId, since: number) => boolean;
}

export type Completion =
  | { action: "proceed"; integrated?: boolean }
  | { action: "request"; why: string; requests: number; cohort: Cohort; repeat?: boolean }
  | { action: "unresolved"; why: string; cohort: Cohort };

export class Cohorts {
  private readonly live: Cohort[] = [];
  private next = 1;

  constructor(private readonly d: CohortDeps) {}

  /** The live cohort `task` is in. */
  of(task: number): Cohort | undefined {
    return this.live.find((c) => c.members.has(task));
  }

  list(): Cohort[] {
    this.gc();
    return [...this.live];
  }

  /**
   * `task` overlaps `others` (open tasks of other owners): from now on they are one cohort. Merges cohorts the tasks were
   * in, records owner changes (each bumps the revision and voids that member's intent), and lifts a silent cohort that
   * an owner without verified facts joins. Returns what happened, for the notices.
   */
  join(task: Task, others: Task[], gen: (t: Task) => number): { cohort: Cohort; formed: boolean; lifted: boolean } | undefined {
    const all = [task, ...others].filter((t) => t.owner);
    const found = [...new Set(all.map((t) => this.of(t.id)).filter((c): c is Cohort => !!c))];
    if (!found.length && all.length < 2) return undefined;
    const wasSilent = found.some((c) => c.silent);
    let cohort = found[0];
    const formed = !cohort;
    if (!cohort) {
      cohort = { id: this.next++, revision: 0, members: new Map(), silent: false, intents: new Map(), held: new Set() };
      this.live.push(cohort);
    }
    let changed = formed;
    for (const other of found.slice(1)) {
      for (const [id, m] of other.members) cohort.members.set(id, m);
      for (const [id, i] of other.intents) cohort.intents.set(id, i);
      for (const id of other.held) cohort.held.add(id);
      cohort.silent &&= other.silent;
      this.live.splice(this.live.indexOf(other), 1);
      changed = true;
    }
    for (const t of all) {
      const m = cohort.members.get(t.id);
      const g = gen(t);
      if (m && m.owner === t.owner && m.gen === g) continue;
      cohort.members.set(t.id, { task: t.id, owner: t.owner!, gen: g });
      cohort.intents.delete(t.id);
      changed = true;
    }
    if (changed) cohort.revision++;
    const owners = [...new Set([...cohort.members.values()].map((m) => m.owner))];
    if (formed) cohort.silent = this.d.silence(owners);
    else if (cohort.silent && changed && !this.d.silence(owners)) cohort.silent = false;
    // Lifted: a silent cohort (or a silent one merged into this) is no longer silent, and its members must hear it.
    return { cohort, formed, lifted: wasSilent && !cohort.silent };
  }

  /** An owner lost its context path (or PII opened): every silent cohort it is in speaks again. */
  lift(peer: PeerId): Cohort[] {
    const out = this.live.filter((c) => c.silent && [...c.members.values()].some((m) => m.owner === peer));
    for (const c of out) {
      c.silent = false;
      c.revision++;
    }
    return out;
  }

  /**
   * The silent cohort that makes a message from `from` to `to` cohort coordination: `from` is a member that has not
   * stopped since its task closed, and `to` is a member too. A member that settled works on something else now.
   */
  silenced(from: PeerId, to: PeerId): Cohort | undefined {
    this.gc();
    return this.live.find((c) => {
      if (!c.silent) return false;
      const members = [...c.members.values()];
      return members.some((m) => m.owner === from && !this.settled(m)) && members.some((m) => m.owner === to);
    });
  }

  /** The task left the open states for its owner (done, approved, in review): its owner's next turn end settles it. */
  closed(task: number, at = Date.now()): void {
    const m = this.of(task)?.members.get(task);
    if (m) m.closedAt ??= at;
  }

  /** The task is open again for its owner (a failed check, changes requested, a reopen): its intent is void. */
  withdraw(task: number): void {
    const c = this.of(task);
    if (!c) return;
    const m = c.members.get(task);
    if (m) delete m.closedAt;
    c.intents.delete(task);
    c.revision++;
  }

  /**
   * `task`'s owner called done in silent cohort `c`. Records its intent; then either it proceeds (others are still at
   * work, another member integrates this revision, or its integration is confirmed), or it is asked to integrate (first
   * request, or the target moved), or, past MAX_REQUESTS, the outcome is unresolved.
   */
  completion(c: Cohort, task: Task, now: { gen: number; tree: string; factsCurrent: boolean }): Completion {
    const m = c.members.get(task.id);
    if (!m || m.owner !== task.owner || m.gen !== now.gen) {
      c.members.set(task.id, { task: task.id, owner: task.owner!, gen: now.gen });
      c.revision++;
    }
    c.intents.set(task.id, { gen: now.gen, at: c.intents.get(task.id)?.gen === now.gen ? c.intents.get(task.id)!.at : Date.now() });
    const missing = [...c.members.values()].filter((x) => c.intents.get(x.task)?.gen !== x.gen);
    if (missing.length) return { action: "proceed" };
    const ig = c.integration;
    if (ig && ig.revision === c.revision && ig.task !== task.id) return { action: "proceed" }; // another member integrates
    if (!ig || ig.revision !== c.revision || ig.task !== task.id || ig.gen !== now.gen || ig.owner !== task.owner) {
      c.integration = { task: task.id, owner: task.owner!, gen: now.gen, revision: c.revision, tree: now.tree, requests: 1, at: Date.now() };
      return { action: "request", why: "", requests: 1, cohort: c };
    }
    // A done within two seconds of the request is a retry of a call whose answer was lost, not a check of the work.
    if (Date.now() - ig.at < 2000) return { action: "request", why: ig.requests === 1 ? "" : "repeat", requests: ig.requests, cohort: c, repeat: true };
    // Its next done: accepted only for the same target, once every other member has stopped.
    const others = [...c.members.values()].filter((x) => x.task !== task.id);
    const running = others.filter((x) => !this.d.quiescent(x.owner, c.intents.get(x.task)!.at)).map((x) => x.owner);
    let why = "";
    if (running.length) why = `${[...new Set(running)].join(", ")} has not stopped since its done, so its changes may not be final`;
    else if (now.tree !== ig.tree) why = "the files changed since the last request";
    else if (!now.factsCurrent) why = "there are changes you have not been shown yet";
    if (!why) {
      ig.confirmed = true;
      return { action: "proceed", integrated: true };
    }
    if (ig.requests >= MAX_REQUESTS) return { action: "unresolved", why, cohort: c };
    ig.requests++;
    ig.tree = now.tree;
    ig.at = Date.now();
    delete ig.offer;
    return { action: "request", why, requests: ig.requests, cohort: c };
  }

  /**
   * Whether `task`'s confirmed integration still holds for `tree`: a check that ran on it counts only for the target
   * that was confirmed (owner generation, cohort revision, files).
   */
  holds(task: number, gen: number, tree: string): boolean {
    const c = this.of(task);
    const ig = c?.integration;
    if (!c || !c.silent || !ig || ig.task !== task) return true; // not an integration owner: nothing to hold
    return !!ig.confirmed && ig.gen === gen && ig.revision === c.revision && ig.tree === tree;
  }

  private settled(m: Member): boolean {
    return m.closedAt !== undefined && this.d.quiescent(m.owner, m.closedAt);
  }

  /** The task lost its owner (released, unassigned): it leaves the cohort, and the revision moves on. */
  leave(task: number): void {
    const c = this.of(task);
    if (!c) return;
    c.members.delete(task);
    c.intents.delete(task);
    c.revision++;
  }

  /**
   * A cohort is over once every member closed its task and stopped (silent), or closed it (not silent: nothing is
   * held back, so nothing waits for a turn end).
   */
  private gc(): void {
    for (const c of [...this.live]) {
      const members = [...c.members.values()];
      if (members.every((m) => (c.silent ? this.settled(m) : m.closedAt !== undefined))) this.live.splice(this.live.indexOf(c), 1);
    }
  }
}
