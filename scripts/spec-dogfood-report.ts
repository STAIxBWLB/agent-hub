// #1064 T6 (AC11): the design-spec dogfood report. For the first-parent commits on main in a window (each is one squash or merge PR), it counts the PRs that touch
// a dogfood spec's paths and how many of those also changed the owning spec. Before the module specs existed (the baseline window), the owning document is the design
// monolith. It also reports schema errors and stale documents on HEAD. The `spec not updated` noise share and agent contradictions are reviewer-assessed, not git facts.
// Usage: bun scripts/spec-dogfood-report.ts --since <ISO> --until <ISO> [--baseline] [--json]
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { SpecsEngine } from "../src/hub/specs.ts";
import { loadConfig } from "../src/hub/daemon.ts";

export const MONOLITH = "docs/specs/2026-09-19-agent-hub-design.md";
/** The dogfood tree of #1064: goal, architecture and three modules. */
export const DOGFOOD_TAG = "dogfood";

export interface PrCommit { sha: string; subject: string; date: string; files: string[] }
export interface Covering { id: string; path: string }
export interface PrVerdict { touches: boolean; specChanged: boolean; ids: string[] }

/**
 * One PR's verdict. `covering` are the dogfood specs whose paths the PR touched (empty means it touched none). In the dogfood window the PR co-changed when it
 * changed at least one covering spec file; in the baseline window, when it changed `owningBaseline` (the monolith).
 */
export function classifyPr(files: readonly string[], covering: readonly Covering[], owningBaseline?: string): PrVerdict {
  const changed = new Set(files);
  const ids = covering.map(spec => spec.id).sort();
  if (!covering.length) return { touches: false, specChanged: false, ids };
  const specChanged = owningBaseline !== undefined ? changed.has(owningBaseline) : covering.some(spec => changed.has(spec.path));
  return { touches: true, specChanged, ids };
}

export interface Summary { prs: number; touching: number; coChanged: number; share: number | null }

export function summarize(verdicts: readonly PrVerdict[]): Summary {
  const touching = verdicts.filter(v => v.touches), coChanged = touching.filter(v => v.specChanged).length;
  return { prs: verdicts.length, touching: touching.length, coChanged, share: touching.length ? coChanged / touching.length : null };
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `status ${result.status}`}`);
  return result.stdout;
}

/** First-parent commits of `ref` in the window, each with the files it changed against its first parent. */
export function prCommits(root: string, since: string, until: string, ref = "origin/main"): PrCommit[] {
  const out: PrCommit[] = [];
  for (const line of git(root, ["log", "--first-parent", `--since=${since}`, `--until=${until}`, "--format=%H%x09%cI%x09%s", ref]).split("\n")) {
    if (!line.trim()) continue;
    const [sha, date, ...subject] = line.split("\t");
    const files = git(root, ["diff-tree", "--no-commit-id", "-r", "--name-only", "-m", "--first-parent", sha!]).split("\n").filter(Boolean);
    out.push({ sha: sha!, date: date!, subject: subject.join("\t"), files });
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const since = option("--since"), until = option("--until"), baseline = args.includes("--baseline"), json = args.includes("--json");
  if (!since || !until || Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) {
    console.error("usage: bun scripts/spec-dogfood-report.ts --since <ISO date> --until <ISO date> [--baseline] [--json]");
    process.exit(2);
  }
  const root = resolve(import.meta.dir, "..");
  const engine = new SpecsEngine(root, loadConfig(root).specs);
  const dogfood = engine.list().specs.filter(spec => spec.path.startsWith("docs/design/"));
  const dogfoodIds = new Set(dogfood.map(spec => spec.id));
  const rows = prCommits(root, since, until).map(pr => {
    const touched = pr.files.filter(file => !file.startsWith("docs/design/") && file !== MONOLITH);
    const covering = touched.length ? engine.covers(touched).specs.filter(spec => dogfoodIds.has(spec.id)) : [];
    return { ...pr, verdict: classifyPr(pr.files, covering, baseline ? MONOLITH : undefined) };
  });
  const summary = summarize(rows.map(row => row.verdict));
  const check = engine.check();
  const report = {
    window: { since, until, baseline, owning: baseline ? MONOLITH : "the covering docs/design spec" },
    dogfoodSpecs: dogfood.map(spec => ({ id: spec.id, status: spec.status })),
    ...summary,
    schemaErrors: check.errors,
    staleDocuments: check.stale,
    reviewerAssessed: { specNotUpdatedNoise: "count from the review notes of the window's tasks", agentContradictions: "count from the window's reviews" },
    touchingPrs: rows.filter(row => row.verdict.touches).map(row => ({ sha: row.sha.slice(0, 8), subject: row.subject, ids: row.verdict.ids, specChanged: row.verdict.specChanged })),
  };
  if (json) console.log(JSON.stringify(report, null, 1));
  else {
    const pct = summary.share === null ? "n/a" : `${Math.round(summary.share * 100)}%`;
    console.log([
      `Window ${since} .. ${until}${baseline ? " (baseline: owning document is the design monolith)" : ""}`,
      `PRs on main: ${summary.prs}; touching dogfood paths: ${summary.touching}; also changed the owning spec: ${summary.coChanged} (${pct})`,
      `Schema errors on HEAD: ${check.errors}; stale documents: ${check.stale}`,
      "Reviewer-assessed (not git facts): `spec not updated` noise share, agent contradictions of a dogfood spec.",
      "",
      ...report.touchingPrs.map(pr => `- ${pr.specChanged ? "co-changed" : "spec unchanged"} ${pr.sha} ${pr.subject} [${pr.ids.join(", ")}]`),
    ].join("\n"));
  }
}
