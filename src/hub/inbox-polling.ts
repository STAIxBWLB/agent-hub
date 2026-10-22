/** Advisory only: reading an inbox is never refused. */
export class InboxPolling {
  // ponytail: counters reset on restart; persist only if restarts hide real polling.
  private readonly streaks = new Map<string, { reads: number[]; noticed: boolean }>();

  reset(peer: string): void { this.streaks.delete(peer); }

  read(peer: string, empty: boolean, assigned: boolean, now: number): { count: number; minutes: number; notice: boolean } | undefined {
    if (!empty || assigned) { this.reset(peer); return; }
    let streak = this.streaks.get(peer);
    const last = streak?.reads.at(-1);
    if (!streak || last === undefined || now < last || now - last > 10 * 60_000) {
      streak = { reads: [], noticed: false };
      this.streaks.set(peer, streak);
    }
    streak.reads = streak.reads.filter(at => now - at <= 10 * 60_000);
    // ponytail: advice counts at most 64 recent reads; use time buckets if full high-rate counts become useful.
    if (streak.reads.length === 64) streak.reads.shift();
    streak.reads.push(now);
    if (streak.reads.length < 3) return;
    const notice = !streak.noticed;
    streak.noticed = true;
    return { count: streak.reads.length, minutes: Math.floor((now - streak.reads[0]!) / 60_000), notice };
  }
}
