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

/** One report row per kind that is not verified: ahead, unknown, or an agy-style no-public-source note. */
export async function watchRows(fetchImpl: FetchLike = fetch): Promise<string[]> {
  const rows: string[] = [];
  for (const id of Object.keys(COMPAT) as CompatId[]) {
    const source = SOURCES[id] ?? { kind: "none" as const };
    if (source.kind === "none") { rows.push(`- **${id}**: no public source; local drift only (${describe(id)}).`); continue; }
    const latest = await latestVersion(source, fetchImpl);
    const verdict = assessVersion(id, latest, []);
    if (verdict.ok && verdict.state === "verified") continue;
    // A source that cannot be read reads as unknown, never as a refusal or a crash.
    const state = latest === undefined ? "unknown" : verdict.state;
    rows.push(`- **${id}** (${sourceLabel(source)}): latest ${latest ?? "unknown"}, ${state}; ${describe(id)}; repeat the receipt in ${COMPAT[id].receipt} before adding the version.`);
  }
  return rows;
}

/** The watcher's verdict, importable so tests inject a fake fetch: exit code 0 all verified, 3 some ahead (or unknown). */
export async function watch(fetchImpl: FetchLike = fetch, now = new Date()): Promise<{ code: 0 | 3; report: string }> {
  const rows = await watchRows(fetchImpl);
  if (!rows.length) return { code: 0, report: "Every watched agent CLI's latest published version is verified." };
  const report = ["Published agent CLI versions ahead of their verified set (`src/adapters/compat.ts`).", "",
    ...rows, "",
    "Next step for each: a model-free receipt in `docs/verification/`, then add the version to `verified` in the same PR. Until then a person may run `ahub agents trust <id> <version>` on their machine.",
    "", `Checked ${now.toISOString().slice(0, 10)} by .github/workflows/agent-compat.yml.`].join("\n");
  return { code: 3, report };
}

if (import.meta.main) {
  const { code, report } = await watch();
  console.log(report);
  process.exit(code);
}
