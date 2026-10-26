// #691: compare the published version of every public-source gated CLI with its verified set. #843 widened it from the
// three npm kinds to every COMPAT id that has a public source, npm or GitHub releases. agy has no public source and
// reports local drift only; pi is watched only once a COMPAT entry exists (#843 AC2).
// Prints a markdown report on stdout and exits 3 when some kind is ahead (1 is Bun's own crash code, so it is never a
// verdict). Model-free, no install, no account.
import { assessVersion, COMPAT, describe, type CompatId } from "../src/adapters/compat.ts";

export type WatchSource = { kind: "npm"; pkg: string } | { kind: "github"; repo: string } | { kind: "none" };

// The public source of each id, kept beside COMPAT, which stays the one version policy (#691). `pi` is a hook: it is
// watched only once COMPAT carries the entry, which #843 AC2 adds in another PR.
export const SOURCES: Record<CompatId, WatchSource> & Record<string, WatchSource> = {
  "claude-implementer": { kind: "npm", pkg: "@anthropic-ai/claude-code" },
  "codex-review": { kind: "npm", pkg: "@openai/codex" },
  "kimi-review": { kind: "npm", pkg: "@moonshot-ai/kimi-code" },
  jcode: { kind: "github", repo: "1jehuang/jcode" },
  agy: { kind: "none" },
  qwen: { kind: "npm", pkg: "@qwen-code/qwen-code" },
  "qwen-dual": { kind: "npm", pkg: "@qwen-code/qwen-code" },
  pi: { kind: "npm", pkg: "@earendil-works/pi-coding-agent" },
};

const sourceLabel = (source: WatchSource): string =>
  source.kind === "npm" ? `npm ${source.pkg}` : source.kind === "github" ? `GitHub releases ${source.repo}` : "no public source";

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ json: () => Promise<unknown> }>;

/** The latest published version a source offers, or undefined when it cannot be read (an unreadable source is unknown, never a crash). */
export async function latestVersion(source: WatchSource, fetchImpl: FetchLike = fetch): Promise<string | undefined> {
  const url = source.kind === "npm" ? `https://registry.npmjs.org/${source.pkg}/latest`
    : source.kind === "github" ? `https://api.github.com/repos/${source.repo}/releases/latest` : undefined;
  if (!url) return undefined;
  try {
    const body = (await (await fetchImpl(url, { signal: AbortSignal.timeout(15_000) })).json()) as { version?: unknown; tag_name?: unknown };
    const raw = source.kind === "npm" ? body.version : body.tag_name;
    // A GitHub release tag carries a leading v (v0.99.1); the version policy stores plain semver.
    return typeof raw === "string" ? raw.replace(/^v/, "") : undefined;
  } catch { return undefined; }
}

export type WatchVerdict = { code: 0 | 3; report: string };

// One drift row and the id it belongs to, so a caller (the test) can name which id is ahead without depending on the
// URL or the order of the fetches. `line` is the rendered report bullet.
export type DriftRow = { id: string; line: string };

/**
 * The report rows, split into the two kinds the exit code turns on (#843). `drift` holds the public-source kinds that
 * are ahead or unknown, and only those decide the exit code: every one verified means exit 0, so the workflow can close
 * the drift issue. `notices` holds the informational rows (agy-style no-public-source kinds), which are printed but
 * never make the watcher exit 3 — agy must never cause a failure.
 */
export async function watchRows(fetchImpl: FetchLike = fetch): Promise<{ drift: DriftRow[]; notices: string[] }> {
  const drift: DriftRow[] = [];
  const notices: string[] = [];
  for (const id of Object.keys(COMPAT) as CompatId[]) {
    const source = SOURCES[id] ?? { kind: "none" as const };
    // A no-public-source kind is an informational note, not drift: it can be neither ahead nor behind a public version.
    if (source.kind === "none") { notices.push(`- **${id}**: no public source; local drift only (${describe(id)}).`); continue; }
    const latest = await latestVersion(source, fetchImpl);
    const verdict = assessVersion(id, latest, []);
    if (verdict.ok && verdict.state === "verified") continue;
    // A source that cannot be read reads as unknown, never as a refusal or a crash.
    const state = latest === undefined ? "unknown" : verdict.state;
    drift.push({ id, line: `- **${id}** (${sourceLabel(source)}): latest ${latest ?? "unknown"}, ${state}; ${describe(id)}; repeat the receipt in ${COMPAT[id].receipt} before adding the version.` });
  }
  return { drift, notices };
}

/**
 * The watcher's verdict, importable so tests inject a fake fetch. Exit 0 when every public source is verified (only
 * informational notices remain); exit 3 when any public source is ahead or unknown, with the drift header the step
 * script keys on. Notices are always printed but never move the exit code on their own.
 */
export async function watch(fetchImpl: FetchLike = fetch, now = new Date()): Promise<WatchVerdict> {
  const { drift, notices } = await watchRows(fetchImpl);
  const footer = ["", `Checked ${now.toISOString().slice(0, 10)} by .github/workflows/agent-compat.yml.`];
  if (!drift.length) {
    // All public sources verified: exit 0 even when an informational notice (agy) remains, so the workflow closes the drift issue.
    const report = ["Every watched agent CLI's latest published version is verified.", ...(notices.length ? ["", "Informational:", ...notices] : []), ...footer];
    return { code: 0, report: report.join("\n") };
  }
  const report = ["Published agent CLI versions ahead of their verified set (`src/adapters/compat.ts`).", "",
    ...drift.map(row => row.line),
    ...(notices.length ? ["", "Informational (no public source, not drift):", ...notices] : []), "",
    "Next step for each: a model-free receipt in `docs/verification/`, then add the version to `verified` in the same PR. Until then a person may run `ahub agents trust <id> <version>` on their machine.",
    ...footer].join("\n");
  return { code: 3, report };
}

if (import.meta.main) {
  const { code, report } = await watch();
  console.log(report);
  process.exit(code);
}
