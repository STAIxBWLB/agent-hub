import { sdlcGh, type SdlcGh } from "./sdlc.ts";
export interface GitHubSource { provider: "github"; repo: string; issue: number; url: string; }
export interface GitHubImportIssue { source: GitHubSource; title: string; detail: string; }
export interface GitHubImportSelection { repo?: string; label: string; milestone?: string; }
const REPO=/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const selectionText=(value:unknown):value is string=>typeof value==="string"&&value.trim()===value&&value.length>0&&value.length<=100&&!value.startsWith("-")&&!/\p{Cc}/u.test(value);
/** Read-only issue intake; the existing reader bounds process time, stdout and diagnostics. */
export async function readGitHubImport(input: GitHubImportSelection, run: SdlcGh=sdlcGh): Promise<{ issues: GitHubImportIssue[]; partial: boolean; }> {
  if(!selectionText(input.label)||input.label.includes(",")||input.label.includes('"')||input.milestone!==undefined&&!selectionText(input.milestone)||input.repo!==undefined&&!REPO.test(input.repo))throw new Error("invalid GitHub import selection");
  const {label,milestone}=input;
  const deadline=performance.now()+10_000;
  const read=async(args:string[])=>{const left=deadline-performance.now();if(left<=0)throw new Error("GitHub import read deadline expired");const result=await run(args,Math.min(left,10_000),undefined,2*1024*1024);if(performance.now()>deadline)throw new Error("GitHub import read deadline expired");if(result.code!==0||new TextEncoder().encode(result.stdout).length>2*1024*1024)throw new Error("GitHub import read failed or exceeded its output bound");return JSON.parse(result.stdout) as unknown;};
  let repo=input.repo;
  if(repo===undefined){const raw=await read(["repo","view","--json","nameWithOwner"]);if(!raw||typeof raw!=="object"||typeof (raw as Record<string,unknown>).nameWithOwner!=="string")throw new Error("GitHub repository identity unavailable");repo=(raw as {nameWithOwner:string}).nameWithOwner;}
  if(!REPO.test(repo))throw new Error("invalid GitHub repository identity");
  // ponytail: one bounded page of32 issues; add paginated reads under the shared deadline for larger intake.
  const args=["issue","list","--repo",repo,"--state","open","--label",label,...(milestone===undefined?[]:["--milestone",milestone]),"--limit","33","--json","number,title,body,url,state"];
  const raw=await read(args);if(!Array.isArray(raw)||raw.length>33)throw new Error("invalid GitHub issue page");
  const seen=new Set<number>();
  const issues=raw.map(row=>{
    if(!row||typeof row!=="object"||!Number.isSafeInteger(row.number)||row.number<=0||seen.has(row.number)||row.state!=="OPEN"||typeof row.title!=="string"||!row.title.trim()||row.title.length>300||typeof row.body!=="string"||row.body.length>8000||typeof row.url!=="string")throw new Error("invalid GitHub issue data");
    seen.add(row.number);
    const expected=`https://github.com/${repo}/issues/${row.number}`;
    if(row.url.toLowerCase()!==expected.toLowerCase())throw new Error("GitHub issue identity mismatch");
    return {source:{provider:"github" as const,repo:repo!.toLowerCase(),issue:row.number,url:expected},title:row.title,detail:row.body};
  });
  return {issues:issues.slice(0,32),partial:issues.length>32};
}

/** R3 (#1481): the paged, read-only reader the roadmap uses. One deadline covers repository resolution and every page. */
export const GITHUB_PAGE_SIZE = 100;
export const GITHUB_PAGE_LIMIT = 10;
export const GITHUB_READ_DEADLINE_MS = 20_000;
export interface GitHubIssueRow { number: number; title: string; url: string; milestone: number | null }
export interface GitHubMilestoneRow { number: number; title: string; description: string; due: string | null; url: string }
export interface GitHubPagedRead<T> { repo: string; rows: T[]; partial: boolean }
export interface GitHubPageOptions { repo?: string; pageSize?: number; maxPages?: number; deadlineMs?: number }
const ISSUE_JQ = "[.[]|{number,title,url:.html_url,pr:(.pull_request!=null),milestone:(.milestone.number)}]";
const MILESTONE_JQ = "[.[]|{number,title,description,due:.due_on,url:.html_url}]";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

async function pagedRead<T>(kind: "issues" | "milestones", opts: GitHubPageOptions, run: SdlcGh, row: (raw: unknown, repo: string) => T | undefined, key: (value: T) => number): Promise<GitHubPagedRead<T>> {
  if (opts.repo !== undefined && !REPO.test(opts.repo)) throw new Error("invalid GitHub repository identity");
  const size = Math.min(GITHUB_PAGE_SIZE, Math.max(1, opts.pageSize ?? GITHUB_PAGE_SIZE)), pages = Math.min(GITHUB_PAGE_LIMIT, Math.max(1, opts.maxPages ?? GITHUB_PAGE_LIMIT));
  const deadline = performance.now() + (opts.deadlineMs ?? GITHUB_READ_DEADLINE_MS), bound = 2 * 1024 * 1024;
  const read = async (args: string[]): Promise<unknown> => {
    const left = deadline - performance.now();
    if (left <= 0) throw new Error("GitHub roadmap read deadline expired");
    const result = await run(args, Math.min(left, 10_000), undefined, bound);
    if (performance.now() > deadline) throw new Error("GitHub roadmap read deadline expired");
    if (result.code !== 0 || new TextEncoder().encode(result.stdout).length > bound) throw new Error("GitHub roadmap read failed or exceeded its output bound");
    return JSON.parse(result.stdout) as unknown;
  };
  let repo = opts.repo;
  if (repo === undefined) {
    const raw = await read(["repo", "view", "--json", "nameWithOwner"]) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || typeof raw.nameWithOwner !== "string") throw new Error("GitHub repository identity unavailable");
    repo = raw.nameWithOwner;
  }
  if (!REPO.test(repo)) throw new Error("invalid GitHub repository identity");
  const lower = repo.toLowerCase(), rows: T[] = [], seen = new Set<number>();
  for (let page = 1; page <= pages; page++) {
    let raw: unknown;
    try { raw = await read(["api", `repos/${repo}/${kind}?state=open&per_page=${size}&page=${page}`, "--jq", kind === "issues" ? ISSUE_JQ : MILESTONE_JQ]); }
    catch (error) {
      // The first page failing is an unavailable read. A later page failing, or the deadline, leaves what was read and says so.
      if (page === 1) throw error;
      return { repo: lower, rows, partial: true };
    }
    if (!Array.isArray(raw) || raw.length > size) throw new Error("invalid GitHub roadmap page");
    for (const item of raw) {
      const value = row(item, lower);
      if (value === undefined) continue;
      const id = key(value);
      if (seen.has(id)) continue;
      seen.add(id); rows.push(value);
    }
    if (raw.length < size) return { repo: lower, rows, partial: false };
  }
  // A full last page under the page limit may have more behind it: never present a short list as complete.
  return { repo: lower, rows, partial: true };
}

/** Open issues (pull requests excluded) with their GitHub milestone number. */
export function readGitHubIssuePages(opts: GitHubPageOptions = {}, run: SdlcGh = sdlcGh): Promise<GitHubPagedRead<GitHubIssueRow>> {
  return pagedRead("issues", opts, run, (raw, repo) => {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item !== "object" || !Number.isSafeInteger(item.number) || (item.number as number) <= 0 || typeof item.title !== "string") throw new Error("invalid GitHub issue data");
    if (item.pr === true) return undefined;
    const title = item.title.trim(), number = item.number as number, url = `https://github.com/${repo}/issues/${number}`;
    if (!title || title.length > 300 || typeof item.url !== "string" || item.url.toLowerCase() !== url) throw new Error("invalid GitHub issue data");
    const milestone = item.milestone === null || item.milestone === undefined ? null : item.milestone;
    if (milestone !== null && (!Number.isSafeInteger(milestone) || (milestone as number) <= 0)) throw new Error("invalid GitHub issue data");
    return { number, title, url, milestone: milestone as number | null };
  }, value => value.number);
}

/** Open milestones with their description and due day. */
export function readGitHubMilestonePages(opts: GitHubPageOptions = {}, run: SdlcGh = sdlcGh): Promise<GitHubPagedRead<GitHubMilestoneRow>> {
  return pagedRead("milestones", opts, run, (raw, repo) => {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item !== "object" || !Number.isSafeInteger(item.number) || (item.number as number) <= 0 || typeof item.title !== "string") throw new Error("invalid GitHub milestone data");
    const title = item.title.trim(), number = item.number as number, url = `https://github.com/${repo}/milestone/${number}`;
    if (!title || title.length > 300 || typeof item.url !== "string" || item.url.toLowerCase() !== url) throw new Error("invalid GitHub milestone data");
    const description = typeof item.description === "string" ? item.description.trim().slice(0, 4000) : "";
    const due = typeof item.due === "string" && ISO_DAY.test(item.due) ? item.due.slice(0, 10) : null;
    return { number, title, description, due, url };
  }, value => value.number);
}
