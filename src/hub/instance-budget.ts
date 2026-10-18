import type { Budget, BudgetHooks, Moved, PauseRecord } from "./budget.ts";

export type BudgetAccountMembers = (account: string) => readonly string[];
type Headroom = ReturnType<Budget["headroom"]>;

/** Membership comes only from the host's startup-bound registry/declarations, never from model text. */
function memberIds(account: string, members: BudgetAccountMembers): string[] {
  const ids = [...new Set(members(account))];
  return ids.length ? ids : [account]; // unknown external peers retain their singleton behavior
}

/** Per task/role the latest move is authoritative; retrying a failed fanout cannot grow duplicate history. */
function mergeMoves(...groups: readonly Moved[][]): Moved[] {
  return [...new Map(groups.flat().map(move => [JSON.stringify([move.id, move.role]), move])).values()];
}

/** Wrap the daemon's existing per-peer callbacks. Its canHandOff predicate must exclude account siblings. */
export function instanceBudgetHooks(base: BudgetHooks, members: BudgetAccountMembers, account: (peer: string) => string): BudgetHooks {
  const ids = (peer: string) => memberIds(account(peer), members);
  // A failed handoff leaves the core pause unmarked. Preserve completed work until its retry or resume notice;
  // one entry per board task/role bounds this state by the host's task board, rather than by retry count.
  const partialMoves = new Map<string, Moved[]>();
  const summaries = async (peer: string, request: (member: string) => Promise<string | undefined>, deduplicate = false): Promise<string | undefined> => {
    const peers = ids(peer);
    if (peers.length === 1) return request(peers[0]!);
    const parts = await Promise.all(peers.map(async member => {
      const text = await request(member).catch(() => undefined);
      return text === undefined || text.length === 0 ? undefined : { member, text };
    }));
    const groups = new Map<string, { members: string[]; text: string }>();
    for (const part of parts) if (part) {
      const key = deduplicate ? part.text : part.member;
      const group = groups.get(key);
      if (group) group.members.push(part.member);
      else groups.set(key, { members: [part.member], text: part.text });
    }
    return [...groups.values()].map(part => `[${part.members.join(", ")}]\n${part.text}`).join("\n\n") || undefined;
  };
  return {
    ...base,
    account,
    pause(peer) { for (const member of ids(peer)) base.pause(member); },
    resume(peer) { for (const member of ids(peer)) base.resume(member); },
    requestCheckpoint: peer => summaries(peer, member => base.requestCheckpoint(member)),
    platformContext: peer => summaries(peer, member => base.platformContext(member), true),
    attached: peer => ids(peer).some(member => base.attached(member)),
    canHandOff: peer => ids(peer).some(member => base.canHandOff(member)),
    async handoff(peer, context, urgentOnly) {
      const peers = ids(peer);
      if (peers.length === 1) return base.handoff(peers[0]!, context, urgentOnly);
      const key = account(peer);
      let moved = partialMoves.get(key) ?? [];
      for (const member of peers) {
        const current = await base.handoff(member, context, urgentOnly);
        moved = mergeMoves(moved, current);
        partialMoves.set(key, moved);
      }
      partialMoves.delete(key);
      return moved;
    },
    resumed(record) {
      const key = account(record.peer), peers = ids(record.peer), partial = partialMoves.get(key);
      const resumed: PauseRecord = partial ? { ...record, moved: mergeMoves(record.moved, partial) } : record;
      for (const member of peers) base.resumed(member === resumed.peer ? resumed : { ...resumed, peer: member });
      partialMoves.delete(key);
    },
  };
}

/** Routing sees each declared member's account window; the underlying quota store still keeps it once. */
export function projectBudgetHeadroom(rows: Headroom, members: BudgetAccountMembers): Headroom {
  return Object.fromEntries(Object.entries(rows).flatMap(([account, reading]) => memberIds(account, members).map(member => [member, reading])));
}
