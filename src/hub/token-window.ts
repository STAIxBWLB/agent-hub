/**
 * A rolling window of counted tokens, by the time each was used (not the time it was read), so a row read late still ages out
 * on schedule. The hub's own count against a ceiling a person configured, never the provider's quota (#285).
 */
export class TokenWindow {
  private rows: { at: number; n: number }[] = [];
  constructor(private readonly spanMs: number) {}

  add(at: number, n: number): void {
    if (!Number.isFinite(at) || !Number.isSafeInteger(n) || n <= 0) return;
    const index = this.rows.findIndex(row => row.at > at);
    if (index < 0) this.rows.push({ at, n }); else this.rows.splice(index, 0, { at, n });
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
