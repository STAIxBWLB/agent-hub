/**
 * A rolling window of counted tokens, by the time each was used (not the time it was read), so a row read late still ages out
 * on schedule. The hub's own count against a ceiling a person configured, never the provider's quota (#285).
 */
export class TokenWindow {
  private rows: { at: number; n: number }[] = [];
  constructor(private readonly spanMs: number) {}

  add(at: number, n: number): void {
    if (!Number.isFinite(at) || !Number.isSafeInteger(n) || n <= 0) return;
    // The common case is a row at or after the newest one: no search. An older row (a late read) is placed by a scan from the end, which stops at once for a near-current one.
    let index = this.rows.length;
    while (index > 0 && this.rows[index - 1]!.at > at) index--;
    if (index === this.rows.length) this.rows.push({ at, n }); else this.rows.splice(index, 0, { at, n });
  }

  /**
   * Rebuild from a history in one pass, for a start-up replay of a long event log: rows already out of the window at `now` are skipped before
   * anything is inserted, so the cost follows the window and not the log. `add`-ing every historical row instead keeps the expired ones until a read prunes them.
   */
  seed(rows: Iterable<{ at: number; n: number }>, now: number): void {
    const live: { at: number; n: number }[] = [];
    for (const row of rows) if (Number.isFinite(row.at) && Number.isSafeInteger(row.n) && row.n > 0 && now - row.at <= this.spanMs) live.push({ at: row.at, n: row.n });
    live.sort((a, b) => a.at - b.at);
    this.rows = this.rows.length ? [...this.rows, ...live].sort((a, b) => a.at - b.at) : live;
  }

  private prune(now: number): void {
    let drop = 0;
    while (drop < this.rows.length && now - this.rows[drop]!.at > this.spanMs) drop++;
    if (drop) this.rows.splice(0, drop);
  }

  sum(now: number): number {
    this.prune(now);
    return this.rows.reduce((total, row) => total + row.n, 0);
  }

  /** When the oldest counted token was used: the window frees its first share at this time plus its span. */
  oldest(now: number): number | undefined {
    this.prune(now);
    return this.rows[0]?.at;
  }

  reset(): void { this.rows = []; }
}
