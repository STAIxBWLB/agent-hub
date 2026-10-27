import type { SdlcGh } from "./sdlc.ts";

/**
 * #481 S7: the scheduled security-scan baseline. The hub runs no scanner and invents no control: it reads the open-alert counts GitHub already holds for the
 * repository (Dependabot, secret scanning, code scanning), records one scan row each interval, and the existing control-band path judges the series. A source that
 * is not enabled, not permitted or unreadable counts as unknown, never as zero alerts, so a repository with no source configured records nothing.
 */
export const SECURITY_SOURCES = ["dependabot", "secret_scanning", "code_scanning"] as const;
export type SecuritySource = typeof SECURITY_SOURCES[number];
export interface SecurityScan { repo: string; sources: SecuritySource[]; counts: Partial<Record<SecuritySource, number | null>>; total: number | null }
const PATH: Record<SecuritySource, string> = { dependabot: "dependabot/alerts", secret_scanning: "secret-scanning/alerts", code_scanning: "code-scanning/alerts" };
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_ALERTS = 1000;

/** Open alerts of one source, exactly (paged to the cap), or null when the source cannot be read completely. Counts only: no alert text, name or location is kept. */
async function openAlerts(repo: string, source: SecuritySource, run: SdlcGh, deadline: number): Promise<number | null> {
  let total = 0;
  for (let page = 1; page <= MAX_ALERTS / 100; page++) {
    const left = deadline - performance.now();
    if (left <= 0) return null;
    const reply = await run(["api", `repos/${repo}/${PATH[source]}?state=open&per_page=100&page=${page}`, "--jq", "length"], Math.min(10_000, left), undefined, 256).catch(() => undefined);
    if (!reply || reply.code !== 0) return null;
    const n = Number(reply.stdout.trim());
    if (!Number.isSafeInteger(n) || n < 0 || n > 100) return null;
    total += n;
    if (n < 100) return total;
  }
  return null; // more than the cap: unknown, not a clipped number
}

/** Fixed argv, bounded time and output. The total is known only when every named source was read. */
export async function readSecurityScan(repo: string, sources: readonly SecuritySource[], run: SdlcGh): Promise<SecurityScan | undefined> {
  if (!REPO.test(repo) || repo.startsWith("-") || !sources.length || sources.some(source => !SECURITY_SOURCES.includes(source))) return undefined;
  const deadline = performance.now() + 20_000, counts: SecurityScan["counts"] = {};
  for (const source of sources) counts[source] = await openAlerts(repo, source, run, deadline);
  const known = sources.every(source => counts[source] !== null && counts[source] !== undefined);
  return { repo, sources: [...sources], counts, total: known ? sources.reduce((sum, source) => sum + counts[source]!, 0) : null };
}
