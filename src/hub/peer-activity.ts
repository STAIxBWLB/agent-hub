const ACTIVITY_KINDS = ["files", "shell", "network", "hub", "memory", "agents", "model", "unknown"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
interface PeerActivity { kind: ActivityKind; since: number }

function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** One transient row per busy peer. Privacy suppression lasts through the current turn. */
export class PeerActivityTracker {
  private readonly rows = new Map<string, PeerActivity>();
  private readonly hidden = new Set<string>();

  observe(peer: string, kind: unknown, isPrivate: () => boolean, now = Date.now()): void {
    if (kind === undefined) { this.clear(peer); return; }
    if (!isActivityKind(kind) || this.withheld(peer, isPrivate)) return;
    this.rows.set(peer, { kind, since: now });
  }

  view(peer: string, isPrivate: () => boolean): PeerActivity | undefined {
    if (!this.rows.has(peer) || this.withheld(peer, isPrivate)) return undefined;
    return this.rows.get(peer);
  }

  private withheld(peer: string, isPrivate: () => boolean): boolean {
    if (this.hidden.has(peer)) return true;
    try { if (!isPrivate()) return false; } catch { /* Unknown privacy withholds the row. */ }
    this.hidden.add(peer);
    this.rows.delete(peer);
    return true;
  }

  private clear(peer: string): void {
    this.rows.delete(peer);
    this.hidden.delete(peer);
  }
}
