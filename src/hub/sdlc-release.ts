import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childEnv, stopOwnedProcess } from "./child-process.ts";
import { hubGitSync } from "./git.ts";
import { sdlcGh, type SdlcGh } from "./sdlc.ts";
export interface DocEvidence { schemaVersion: 1; head?: string; version?: string; documents: { path?: string; state: "fresh" | "stale" | "nonancestor" | "unknown"; verifiedAgainst?: string; commits?: number; dirty?: boolean }[]; errors: number; fresh: boolean; }
export interface ReleaseReadiness { repo: string; head?: string; version?: string; tag?: string; tagCommit?: string; commits: string[]; mergedPrs: { pr: number; commit: string }[]; documents?: DocEvidence; liveIssues: { id: number; state: "open" | "closed" | "unknown" }[]; blockers: string[]; sourceReady: boolean; native: "unverified"; ready: false; }
export type ReleaseGit = (args: string[]) => { code: number; stdout: string };
export interface ReleaseReaders { gh?: SdlcGh; git?: ReleaseGit; docs?: (root: string, timeoutMs: number) => Promise<DocEvidence | undefined>; }
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Package-owned checker only; no caller-supplied program or document text is executed. */
export function readDocEvidence(root: string, timeoutMs = 10_000): Promise<DocEvidence | undefined> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/check-docs.mjs", import.meta.url)), root, "--json", "--committed"], { cwd: root, env: childEnv(), detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "", invalid = false;
    const stop = () => { invalid = true; void stopOwnedProcess(child, { group: true }).catch(() => {}); };
    const timer = setTimeout(stop, Math.max(1, Math.min(10_000, timeoutMs)));
    child.stdout?.setEncoding("utf8"); child.stdout?.on("data", chunk => { output += chunk; if (Buffer.byteLength(output) > 256 * 1024) { output = ""; stop(); } });
    child.once("error", () => { invalid = true; clearTimeout(timer); resolve(undefined); });
    child.once("close", (code, signal) => {
      clearTimeout(timer); if (invalid || signal || (code !== 0 && code !== 1)) return resolve(undefined);
      try {
        const data = JSON.parse(output);
        if (data.schemaVersion !== 1 || !Array.isArray(data.documents) || data.documents.length > 128 || !Number.isSafeInteger(data.errors) || data.errors < 0 || typeof data.fresh !== "boolean" || (data.head !== undefined && !SHA.test(data.head)) || (data.version !== undefined && !VERSION.test(data.version)) || data.documents.some((d: {state?:string}) => !["fresh","stale","nonancestor","unknown"].includes(d.state ?? ""))) return resolve(undefined);
        resolve(data);
      } catch { resolve(undefined); }
    });
  });
}
/** Read-only checklist. Native acceptance remains an explicit human/operational gate. */
export async function readReleaseReadiness(root: string, repo: string, liveIssues: number[], readers: ReleaseReaders = {}): Promise<ReleaseReadiness> {
  if (!REPO.test(repo) || repo.startsWith("-") || liveIssues.length > 32 || liveIssues.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(liveIssues).size !== liveIssues.length) throw new Error("release evidence requires owner/repository and bounded issue ids");
  const report: ReleaseReadiness = { repo, commits: [], mergedPrs: [], liveIssues: [], blockers: [], sourceReady: false, native: "unverified", ready: false };
  const deadline = performance.now() + 20_000;
  const gh: SdlcGh = args => { const left = deadline - performance.now(); return left > 0 ? (readers.gh ?? sdlcGh)(args, Math.min(left,10_000)) : Promise.resolve({code:1,stdout:""}); };
  const git: ReleaseGit = readers.git ?? (args => { const r = hubGitSync(args, { cwd: root, encoding: "utf8", timeout: Math.max(1, Math.min(1000, deadline - performance.now())), maxBuffer: 256 * 1024 }); return { code: r.status ?? 1, stdout: r.stdout ?? "" }; });
  const first = git(["rev-parse","--verify","HEAD"]); const head = first.stdout.trim();
  if (first.code !== 0 || !SHA.test(head)) { report.blockers.push("local HEAD unknown"); return report; } report.head = head;
  try { const r = git(["show",`${head}:package.json`]), pkg = JSON.parse(r.stdout); if (r.code === 0 && typeof pkg.version === "string" && VERSION.test(pkg.version)) report.version = pkg.version; else report.blockers.push("package version unknown"); } catch { report.blockers.push("package version unknown"); }
  const published = await gh(["release","view","--repo",repo,"--json","tagName,isDraft,isPrerelease"]);
  let tag: string | undefined;
  try { const p = JSON.parse(published.stdout); if (published.code === 0 && typeof p.tagName === "string" && p.tagName.startsWith("v") && VERSION.test(p.tagName.slice(1)) && p.isDraft === false) tag = p.tagName; } catch { /* unknown metadata */ }
  if (!tag) report.blockers.push("published release identity unknown");
  else {
    report.tag = tag; const local = git(["rev-parse","--verify",`refs/tags/${tag}^{commit}`]);
    const [owner,name] = repo.split("/");
    const ref = await gh(["api","graphql","-f","query=query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{... on Commit{oid} ... on Tag{target{... on Commit{oid}}}}}}}","-f",`owner=${owner}`,"-f",`name=${name}`,"-f",`ref=refs/tags/${tag}`]);
    let remote: string | undefined; try { const target = JSON.parse(ref.stdout)?.data?.repository?.ref?.target; remote = target?.oid ?? target?.target?.oid; } catch { /* unknown */ }
    const commit = local.stdout.trim();
    if (local.code !== 0 || ref.code !== 0 || !SHA.test(commit) || remote !== commit) report.blockers.push("local and remote release tag identity differ or are unknown");
    else if (git(["merge-base","--is-ancestor",commit,head]).code !== 0) report.blockers.push("published release is not a verified ancestor");
    else {
      report.tagCommit = commit;
      const work = git(["rev-list","--first-parent","--max-count=1001",`${commit}..${head}`]); const commits = work.stdout.trim().split("\n").filter(Boolean);
      if (work.code !== 0 || commits.length > 1000 || commits.some(c => !SHA.test(c))) report.blockers.push("merged work coverage unknown or truncated"); else report.commits = commits;
      let advanced = false;
      try { advanced = !!report.version && Bun.semver.order(report.version, tag.slice(1)) > 0; } catch { /* invalid version remains blocked */ }
      if (!advanced) report.blockers.push("package version has not advanced past published release");
    }
  }
  if (report.tagCommit) {
    // Resolve only commits since the verified tag, never the repository's lifetime PR list.
    const [owner, name] = repo.split("/");
    for (let start = 0; start < report.commits.length; start += 100) {
      const batch = report.commits.slice(start, start + 100);
      const objects = batch.map((commit, i) => `c${i}:object(oid:"${commit}"){... on Commit{oid associatedPullRequests(first:10){nodes{number state mergeCommit{oid}} pageInfo{hasNextPage}}}}`).join(" ");
      const pulls = await gh(["api", "graphql", "-f", `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${objects}}}`, "-f", `owner=${owner}`, "-f", `name=${name}`]);
      try {
        const data = JSON.parse(pulls.stdout)?.data?.repository;
        if (pulls.code !== 0 || !data) throw new Error("unavailable");
        for (const [i, commit] of batch.entries()) {
          const object = data[`c${i}`], connection = object?.associatedPullRequests, rows = connection?.nodes;
          if (object?.oid !== commit || connection?.pageInfo?.hasNextPage !== false || !Array.isArray(rows) || rows.length > 10 || rows.some(p => !Number.isSafeInteger(p?.number) || p.number <= 0 || !["OPEN", "CLOSED", "MERGED"].includes(p.state) || (p.state === "MERGED" && !SHA.test(p.mergeCommit?.oid)))) throw new Error("incomplete");
          for (const p of rows) if (p.state === "MERGED" && p.mergeCommit.oid === commit && !report.mergedPrs.some(r => r.pr === p.number)) report.mergedPrs.push({ pr: p.number, commit });
        }
      } catch { report.blockers.push("merged PR coverage unknown or truncated"); break; }
    }
  }
  const left = deadline - performance.now(); report.documents = left > 0 ? await (readers.docs ?? readDocEvidence)(root,Math.min(10_000,left)) : undefined;
  if (!report.documents || report.documents.head !== head || !report.documents.fresh || report.documents.errors || report.documents.documents.some(d => d.state !== "fresh")) report.blockers.push("documentation freshness or ancestry is unknown or stale");
  if (!liveIssues.length) report.blockers.push("native verification ledger unspecified");
  for (const id of liveIssues) {
    const reply = await gh(["issue","view",String(id),"--repo",repo,"--json","number,state"]); let state: "open"|"closed"|"unknown" = "unknown";
    try { const p = JSON.parse(reply.stdout); if (reply.code === 0 && p.number === id && ["OPEN","CLOSED"].includes(p.state)) state = p.state.toLowerCase(); } catch { /* unknown */ }
    report.liveIssues.push({id,state}); if (state !== "closed") report.blockers.push("native verification ledger open or unknown");
  }
  const last = git(["rev-parse","--verify","HEAD"]); if (last.code !== 0 || last.stdout.trim() !== head) report.blockers.push("local HEAD changed during release readback");
  report.blockers = [...new Set(report.blockers)]; report.sourceReady = report.blockers.length === 0;
  // Closed issue metadata is not a native receipt or permission to publish.
  report.blockers.push("native acceptance and person release decision unverified");
  return report;
}
