import { createHash } from "node:crypto";
import { githubRepo, milestoneId } from "./roadmap.ts";
import type { SdlcGh } from "./sdlc.ts";

export interface MirrorIssue { number: number; milestone: number | null }
export interface MirrorMilestone { number: number; title: string; state: "open" | "closed" }
export interface MirrorDesired { title: string; state: "open" | "closed"; issues: number[]; marker: string }
export interface MirrorPlan { calls: string[][]; fingerprint: string }
export interface MirrorSnapshot { milestones: (MirrorMilestone & MarkerMilestone)[]; issues: MirrorIssue[] }

/** Complete bounded metadata-only pages. A failed or full last page refuses every write plan. */
export async function readMirrorSnapshot(repoInput: string, run: SdlcGh): Promise<MirrorSnapshot> {
  const repo = githubRepo(repoInput), deadline = performance.now() + 20_000;
  const pages = async (kind: "milestones" | "issues"): Promise<Record<string, unknown>[]> => {
    const rows: Record<string, unknown>[] = [], seen = new Set<number>();
    for (let page = 1; page <= 10; page++) {
      const left = deadline - performance.now();
      if (left <= 0) throw new Error("roadmap mirror inventory timed out");
      const projection = kind === "milestones" ? "[.[]|{number,title,state,description,html_url}]" : "[.[]|{number,html_url,milestone:(.milestone|if . == null then null else {number} end),pull_request:(.pull_request!=null)}]";
      const result = await run(["api", `repos/${repo}/${kind}?state=all&per_page=100&page=${page}`, "--hostname", "github.com", "--jq", projection], Math.min(left, 10_000), undefined, 2 * 1024 * 1024);
      if (performance.now() > deadline || result.code !== 0 || Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) throw new Error("roadmap mirror inventory unavailable");
      const raw: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(raw) || raw.length > 100) throw new Error("roadmap mirror inventory malformed");
      for (const item of raw) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("roadmap mirror inventory malformed");
        const row = item as Record<string, unknown>, id = milestoneId(row.number);
        if (seen.has(id)) throw new Error("roadmap mirror inventory duplicated");
        seen.add(id); rows.push(row);
      }
      if (raw.length < 100) return rows;
    }
    throw new Error("roadmap mirror inventory incomplete");
  };
  const milestones = (await pages("milestones")).map(row => {
    if (typeof row.title !== "string" || row.title.length > 300 || row.state !== "open" && row.state !== "closed" || row.description !== null && typeof row.description !== "string" || typeof row.html_url !== "string" || row.html_url.toLowerCase() !== `https://github.com/${repo}/milestone/${milestoneId(row.number)}`) throw new Error("roadmap mirror milestone malformed");
    return { number: milestoneId(row.number), title: row.title, state: row.state, description: row.description } as MirrorMilestone & MarkerMilestone;
  });
  const issueRows = await pages("issues");
  if (issueRows.some(row => typeof row.pull_request !== "boolean")) throw new Error("roadmap mirror issue malformed");
  const issues = issueRows.filter(row => row.pull_request === false).map(row => {
    const value = row.milestone;
    if (value !== null && (!value || typeof value !== "object" || Array.isArray(value)) || typeof row.html_url !== "string" || row.html_url.toLowerCase() !== `https://github.com/${repo}/issues/${milestoneId(row.number)}`) throw new Error("roadmap mirror issue malformed");
    return { number: milestoneId(row.number), milestone: value === null ? null : milestoneId((value as Record<string, unknown>).number) };
  });
  return { milestones, issues };
}

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
  if (!/^<!-- ahub-roadmap:[A-Za-z0-9._-]+:[1-9][0-9]* -->$/.test(desired.marker)) throw new Error("invalid roadmap marker");
  if (typeof desired.title !== "string" || !desired.title.trim() || desired.title.length > 300 || /[\p{Cc}\p{Cf}]/u.test(desired.title)
      || !["open", "closed"].includes(desired.state)) throw new Error("invalid public milestone");
  const desiredIds = new Set(desired.issues.map(milestoneId));
  if (desiredIds.size !== desired.issues.length) throw new Error("duplicate issue membership");
  const calls: string[][] = [];
  if (remote === null) {
    // The server assigns the number. A later preview plans membership separately.
    calls.push(["api", `repos/${repo}/milestones`, "--hostname", "github.com", "--method", "POST", "-f", `title=${desired.title}`, "-f", `state=${desired.state}`, "-f", `description=${desired.marker}`]);
  } else {
    const number = milestoneId(remote.number);
    if (remote.state !== "open" && remote.state !== "closed") throw new Error("invalid remote milestone state");
    if (remote.title !== desired.title || remote.state !== desired.state)
      calls.push(["api", `repos/${repo}/milestones/${number}`, "--hostname", "github.com", "--method", "PATCH", "-f", `title=${desired.title}`, "-f", `state=${desired.state}`]);
    const seen = new Set<number>();
    for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
      const id = milestoneId(issue.number);
      if (seen.has(id)) throw new Error("duplicate remote issue");
      seen.add(id);
      if (issue.milestone !== null) milestoneId(issue.milestone);
      if (desiredIds.has(id) && issue.milestone !== number)
        calls.push(["api", `repos/${repo}/issues/${id}`, "--hostname", "github.com", "--method", "PATCH", "-F", `milestone=${number}`]);
      else if (!desiredIds.has(id) && issue.milestone === number)
        calls.push(["api", `repos/${repo}/issues/${id}`, "--hostname", "github.com", "--method", "PATCH", "-F", "milestone=null"]);
    }
    if ([...desiredIds].some(id => !seen.has(id))) throw new Error("issue membership snapshot is incomplete");
  }
  return { calls, fingerprint: createHash("sha256").update(JSON.stringify(calls)).digest("hex") };
}
