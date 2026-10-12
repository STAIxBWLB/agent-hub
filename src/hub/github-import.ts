import { sdlcGh, type SdlcGh } from "./sdlc.ts";
export interface GitHubSource { provider: "github"; repo: string; issue: number; url: string; }
export interface GitHubImportIssue { source: GitHubSource; title: string; detail: string; }
export interface GitHubImportSelection { repo?: string; label: string; milestone?: string; }
const REPO=/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const selectionText=(value:unknown):value is string=>typeof value==="string"&&value.trim()===value&&value.length>0&&value.length<=100&&!value.startsWith("-")&&!/\p{Cc}/u.test(value);
/** Read-only issue intake; the existing reader bounds process time, stdout and diagnostics. */
export async function readGitHubImport(input: GitHubImportSelection, run: SdlcGh=sdlcGh): Promise<{ issues: GitHubImportIssue[]; partial: boolean; }> {
  if(!selectionText(input.label)||input.milestone!==undefined&&!selectionText(input.milestone)||input.repo!==undefined&&!REPO.test(input.repo))throw new Error("invalid GitHub import selection");
  const deadline=performance.now()+10_000;
  const read=async(args:string[])=>{const left=deadline-performance.now();if(left<=0)throw new Error("GitHub import read deadline expired");const result=await run(args,Math.min(left,10_000));if(result.code!==0||new TextEncoder().encode(result.stdout).length>256*1024)throw new Error("GitHub import read failed or exceeded its output bound");return JSON.parse(result.stdout) as unknown;};
  let repo=input.repo;
  if(repo===undefined){const raw=await read(["repo","view","--json","nameWithOwner"]);if(!raw||typeof raw!=="object"||typeof (raw as Record<string,unknown>).nameWithOwner!=="string")throw new Error("GitHub repository identity unavailable");repo=(raw as {nameWithOwner:string}).nameWithOwner;}
  if(!REPO.test(repo))throw new Error("invalid GitHub repository identity");
  // ponytail: one bounded page of32 issues; add paginated reads under the shared deadline for larger intake.
  const args=["issue","list","--repo",repo,"--state","open","--label",input.label,...(input.milestone===undefined?[]:["--milestone",input.milestone]),"--limit","33","--json","number,title,body,url,state"];
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
