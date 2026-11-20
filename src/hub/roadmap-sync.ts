import { createHash } from "node:crypto";
import { githubRepo, milestoneId } from "./roadmap.ts";

export interface MirrorIssue { number: number; milestone: number | null }
export interface MirrorMilestone { number: number; title: string; state: "open" | "closed" }
export interface MirrorDesired { title: string; state: "open" | "closed"; issues: number[] }
export interface MirrorPlan { calls: string[][]; fingerprint: string }

export interface MarkerMilestone { number: number; title: string; description: string | null }
export type MirrorRecovery = (
  | { kind: "create" }
  | { kind: "bind"; number: number }
  | { kind: "ambiguous"; numbers: number[] }
) & { titleConflicts: number[] };

/** Resolve a lost create response without ever inferring identity from a title. */
export function recoverMirrorBinding(marker: string, title: string, remote: readonly MarkerMilestone[]): MirrorRecovery {
  if (!/^<!-- ahub-roadmap:[A-Za-z0-9._-]+:[1-9][0-9]* -->$/.test(marker)) throw new Error("invalid roadmap marker");
  const marked = remote.filter(row => row.description?.includes(marker)).map(row => milestoneId(row.number)).sort((a, b) => a - b);
  const titleConflicts = remote.filter(row => row.title === title && !row.description?.includes(marker)).map(row => milestoneId(row.number)).sort((a, b) => a - b);
  if (marked.length > 1) return { kind: "ambiguous", numbers: marked, titleConflicts };
  if (marked.length === 1) return { kind: "bind", number: marked[0]!, titleConflicts };
  return { kind: "create", titleConflicts };
}

/** Plan one public milestone against a complete, host-validated snapshot. Never applies it. */
export function planRoadmapMirror(repoInput: string, desired: MirrorDesired, remote: MirrorMilestone | null, issues: readonly MirrorIssue[]): MirrorPlan {
  const repo = githubRepo(repoInput);
  if (typeof desired.title !== "string" || !desired.title.trim() || desired.title.length > 300 || /[\p{Cc}\p{Cf}]/u.test(desired.title)
      || !["open", "closed"].includes(desired.state)) throw new Error("invalid public milestone");
  const desiredIds = new Set(desired.issues.map(milestoneId));
  if (desiredIds.size !== desired.issues.length) throw new Error("duplicate issue membership");
  const calls: string[][] = [];
  if (remote === null) {
    // The server assigns the number. A later preview plans membership separately.
    calls.push(["api", `repos/${repo}/milestones`, "--method", "POST", "-f", `title=${desired.title}`, "-f", `state=${desired.state}`]);
  } else {
    const number = milestoneId(remote.number);
    if (remote.state !== "open" && remote.state !== "closed") throw new Error("invalid remote milestone state");
    if (remote.title !== desired.title || remote.state !== desired.state)
      calls.push(["api", `repos/${repo}/milestones/${number}`, "--method", "PATCH", "-f", `title=${desired.title}`, "-f", `state=${desired.state}`]);
    const seen = new Set<number>();
    for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
      const id = milestoneId(issue.number);
      if (seen.has(id)) throw new Error("duplicate remote issue");
      seen.add(id);
      if (issue.milestone !== null) milestoneId(issue.milestone);
      if (desiredIds.has(id) && issue.milestone !== number)
        calls.push(["api", `repos/${repo}/issues/${id}`, "--method", "PATCH", "-F", `milestone=${number}`]);
      else if (!desiredIds.has(id) && issue.milestone === number)
        calls.push(["api", `repos/${repo}/issues/${id}`, "--method", "PATCH", "-F", "milestone=null"]);
    }
    if ([...desiredIds].some(id => !seen.has(id))) throw new Error("issue membership snapshot is incomplete");
  }
  return { calls, fingerprint: createHash("sha256").update(JSON.stringify(calls)).digest("hex") };
}
