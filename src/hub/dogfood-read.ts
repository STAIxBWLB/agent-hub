import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { HUB_DB_BUSY_TIMEOUT_MS } from "./db-timeout.ts";
import { readPrCostHistory, sdlcGh, type SdlcGh } from "./sdlc.ts";
import { dogfoodScorecard, missing, source, type DogfoodTask, type DogfoodPr, type FeatureEvidence, type Source } from "./dogfood.ts";
import type { HistoryEntry } from "./board.ts";
import type { StampedEvent } from "./events.ts";

export const DOGFOOD_BYTE_CAP = 16 * 1024 * 1024;
const MAX_TASKS = 500, MAX_PRS = 16, MAX_CI_HEADS = 8, MAX_CI_READS = 32;
const date = (value: unknown): number | undefined => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
const id = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const repoName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith("-");

/** Read at most cap bytes; keep complete lines from the tail, never follow a FIFO or grow with an appender. */
export function dogfoodLines(file: string, cap = DOGFOOD_BYTE_CAP): Source<string[]> {
  let fd: number | undefined;
  try {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > DOGFOOD_BYTE_CAP) return missing([]);
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return missing([]);
    const start = Math.max(0, stat.size - cap), bytes = Buffer.alloc(Math.min(cap, stat.size));
    const n = readSync(fd, bytes, 0, bytes.length, start);
    let text = bytes.subarray(0,n).toString("utf8");
    if (start) { const newline = text.indexOf("\n"); text = newline < 0 ? "" : text.slice(newline + 1); }
    const whole = text.endsWith("\n") || !text;
    if (!whole) text = text.slice(0,Math.max(0,text.lastIndexOf("\n") + 1));
    return source(text.split("\n").filter(Boolean), !start && n === stat.size && whole);
  } catch { return missing([]); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function dogfoodEvents(lines: Source<string[]>, since: number, until: number): Source<StampedEvent[]> {
  const out: StampedEvent[] = []; let complete = lines.complete;
  for (const line of lines.data) {
    try {
      const e = JSON.parse(line);
      if (!e || typeof e !== "object" || e.v !== 1 || typeof e.type !== "string" || date(e.at) === undefined) { complete = false; continue; }
      const number = (n:unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
      const peer = typeof e.peer === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(e.peer) && !Object.hasOwn(Object.prototype,e.peer);
      const malformed = ["tokens","usage","turn_end","task","overflow","undeliverable"].includes(e.type) &&
        (e.type === "task" ? !id(e.id) || typeof e.class !== "string" || typeof e.event !== "string" || typeof e.state !== "string" : !peer ||
          e.type === "tokens" && !number(e.n) || e.type === "turn_end" && !number(e.ms) ||
          e.type === "usage" && (typeof e.id !== "string" || typeof e.source !== "string") ||
          ["overflow","undeliverable"].includes(e.type) && typeof e.id !== "string");
      if (malformed) {complete=false;continue;}
      const at = e.type === "usage" && date(e.measuredAt) !== undefined ? date(e.measuredAt)! : date(e.at)!;
      if (at >= since && at <= until) out.push({ ...e, at: new Date(at).toISOString() });
    } catch { complete = false; }
  }
  return { data: out, available: lines.available, complete };
}
/** Bounded read-only board snapshot. Select no task title/detail or history note into the result. */
export function dogfoodTasks(file: string): Source<DogfoodTask[]> {
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
    const rows = db.query(`SELECT id, (sdlc IS NOT NULL AND length(sdlc) > 65536) AS receipt_cut, CASE WHEN length(sdlc) <= 65536 THEN sdlc END AS sdlc,
      CASE WHEN length(signals) <= 65536 THEN signals END AS signals,
      CASE WHEN length(history) <= 131072 THEN history END AS history FROM tasks ORDER BY id DESC LIMIT ?`).all(MAX_TASKS + 1) as { id: number; receipt_cut: number; sdlc: string | null; signals: string | null; history: string | null }[];
    let complete = rows.length <= MAX_TASKS, bytes = 0;
    const tasks: DogfoodTask[] = [];
    for (const row of rows.slice(0,MAX_TASKS)) {
      if (row.receipt_cut) complete = false;
      bytes += (row.sdlc?.length ?? 0) + (row.signals?.length ?? 0) + (row.history?.length ?? 0);
      if (bytes > DOGFOOD_BYTE_CAP) { complete = false; break; }
      try {
        const signals = JSON.parse(row.signals ?? "null"), history = JSON.parse(row.history ?? "null"), receipt = JSON.parse(row.sdlc ?? "{}");
        if (!id(row.id) || !Array.isArray(signals) || !Array.isArray(history)) { complete = false; continue; }
        if (history.length > 4096) { complete = false; continue; }
        const clean: HistoryEntry[] = [];
        for (const h of history) {
          if (!h || !Number.isFinite(h.at) || typeof h.event !== "string") { complete = false; continue; }
          clean.push({ at: h.at, by: "hub", event: h.event, ...(h.reviewCost && typeof h.reviewCost === "object" ? { reviewCost: { ...(h.reviewCost.review && ["none","delta","full"].includes(h.reviewCost.review.scope) ? {review:{scope:h.reviewCost.review.scope,reviewers:1}} : {}) } } : {}), ...(Array.isArray(h.reviewFindings?.items) ? { reviewFindings: { items:h.reviewFindings.items.filter((f:any)=>f && typeof f.id === "string" && ["important","nit"].includes(f.severity)).map((f:any)=>({id:f.id,severity:f.severity,pass:"bugs",disposition:"open"})) } } : {}) });
        }
        tasks.push({ id: row.id, pii: signals.includes("pii") || signals.includes("pii_path"), ...(repoName(receipt?.repo) ? { repo: receipt.repo } : {}), ...(id(receipt?.pr) ? { pr: receipt.pr } : {}), history: clean });
      } catch { complete = false; }
    }
    return source(tasks, complete);
  } catch { return missing([]); }
  finally { db?.close(); }
}
/** Journal terminal retention is finite: these are retained rows, never whole-window delivery totals. */
export function dogfoodJournal(file: string, since: number, until: number): Source<{digests:number;held:number;rows:number}> {
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
    const rows = db.query(`SELECT state, CASE WHEN length(out_json) <= 262144 THEN
      (SELECT COUNT(*) FROM json_each(out_json) WHERE json_extract(value,'$.from')='digest') END AS digests
      FROM deliveries WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT 10001`).all(since,until) as {state:string;digests:number|null}[];
    return source({rows:Math.min(rows.length,10000),digests:rows.slice(0,10000).reduce((n,r)=>n+(r.digests??0),0),held:rows.slice(0,10000).filter(r=>r.state === "needs_review").length},rows.length<=10000 && rows.every(r=>r.digests!==null));
  } catch { return missing({digests:0,held:0,rows:0}); }
  finally {db?.close();}
}
const connection = (value: any): any[] | undefined => value?.pageInfo?.hasNextPage === false && Array.isArray(value.nodes) && value.nodes.length <= 100 ? value.nodes : undefined;
/** Reuse S10 cost readback; supplementary reads carry timestamps/ids only, never comment or issue bodies. */
export async function dogfoodPrs(repo: string, tasks: Source<DogfoodTask[]>, since: number, until: number, run: SdlcGh = sdlcGh): Promise<Source<DogfoodPr[]>> {
  if (!repoName(repo) || !tasks.available || !tasks.complete) return missing([]); // unknown privacy inventory forbids remote per-PR reads
  const deadline = performance.now() + 20000;
  const gh: SdlcGh = (args, timeout, cwd, cap) => performance.now() < deadline
    ? run(args, Math.max(1,Math.min(timeout ?? 5000,deadline-performance.now())),cwd,Math.min(cap ?? 128*1024,128*1024)) : Promise.resolve({code:1,stdout:""});
  const parse = async (args: string[]) => { try { const r = await gh(args); return r.code === 0 ? JSON.parse(r.stdout) : undefined; } catch { return undefined; } };
  const list = await parse(["pr","list","--repo",repo,"--state","merged","--search",`merged:>=${new Date(since).toISOString()}`,"--limit","100","--json","number,mergedAt,createdAt"]);
  if (!Array.isArray(list)) return missing([]);
  const hidden = new Set(tasks.data.filter(t => t.pii && (!t.repo || t.repo.toLowerCase() === repo.toLowerCase())).map(t => t.pr));
  const visible = list.filter(p => id(p?.number) && date(p.mergedAt) !== undefined && date(p.mergedAt)! <= until && !hidden.has(p.number));
  let complete = list.length < 100 && list.every(p => id(p?.number) && date(p.mergedAt) !== undefined) && visible.length <= MAX_PRS;
  // Read recent PRs first: their complete recorded head sets usually fit before
  // the shared deadline. Repository-wide CI volume never consumes this budget.
  visible.sort((a,b)=>date(b.mergedAt)!-date(a.mergedAt)!);
  const projection = "{total_count,workflow_runs:[.workflow_runs[]|{id,run_attempt,event,head_sha,created_at,conclusion,pull_requests:[.pull_requests[]|{number}]}]}";
  const validRun = (r:any) => r?.event === "pull_request" && id(r?.id) && id(r?.run_attempt) && typeof r?.head_sha === "string" && /^[a-f0-9]{40}$/.test(r.head_sha)
    && date(r.created_at) !== undefined && (r.conclusion === null || typeof r.conclusion === "string")
    && Array.isArray(r.pull_requests) && r.pull_requests.length <= 100 && r.pull_requests.every((p:any)=>id(p?.number));
  const sha = (v:unknown):v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
  let ciReads = 0;
  const rows: DogfoodPr[] = [];
  for (const item of visible.slice(0,MAX_PRS)) {
    let heads: string[] | undefined, runs: any[] = [], runsComplete = false;
    const cost = await readPrCostHistory(repo,item.number,async(args,t,c,cap) => {
      if (args.some(arg => arg.startsWith(`repos/${repo}/actions/workflows/check.yml/runs?`))) {
        if (!heads || heads.length>MAX_CI_HEADS || ciReads+heads.length>MAX_CI_READS) return {code:1,stdout:""};
        const collected:any[] = [], seen = new Set<number>();
        for (const head of heads) {
          ciReads++;
          const endpoint=`repos/${repo}/actions/workflows/check.yml/runs?per_page=100&event=pull_request&head_sha=${head}&created=${new Date(since).toISOString()}..${new Date(until).toISOString()}`;
          const part = await parse(["api",endpoint,"--jq",projection]);
          if (!part || !Number.isSafeInteger(part.total_count) || part.total_count<0 || !Array.isArray(part.workflow_runs)
            || part.total_count!==part.workflow_runs.length || part.workflow_runs.length>100
            || !part.workflow_runs.every((r:any)=>validRun(r) && r.head_sha===head)) return {code:1,stdout:""};
          for (const row of part.workflow_runs) {
            if (seen.has(row.id)) return {code:1,stdout:""};
            seen.add(row.id);collected.push(row);
          }
          if (collected.length>100) return {code:1,stdout:""};
        }
        runs=collected;runsComplete=true;
        return {code:0,stdout:JSON.stringify({total_count:runs.length,workflow_runs:runs.map((r:any)=>({id:r.id,run_attempt:r.run_attempt,head_sha:r.head_sha,pull_requests:r.pull_requests.map((p:any)=>p.number)}))})};
      }
      const reply = await gh(args,t,c,cap);
      try {
        const body = JSON.parse(reply.stdout), pr=body?.data?.repository?.pullRequest;
        const commits=connection(pr?.commits),reviews=connection(pr?.reviews);
        if (reply.code===0 && !body.errors && pr?.number===item.number && sha(pr.headRefOid) && commits && reviews
          && commits.every(n=>sha(n?.commit?.oid)) && reviews.every(n=>id(n?.databaseId) && sha(n?.commit?.oid))) {
          heads=[...new Set<string>([pr.headRefOid,...commits.map(n=>n.commit.oid),...reviews.map(n=>n.commit.oid)])];
        }
      } catch { /* Missing or incomplete recorded heads cannot certify CI. */ }
      return reply;
    });
    const row: DogfoodPr = cost ?? {repo,pr:item.number,state:"MERGED",mergedAt:date(item.mergedAt),complete:false};
    const linked = runsComplete ? runs.filter((r:any)=>date(r.created_at)!<=row.mergedAt!) : [];
    if (runsComplete) {
      const earliest=[...linked].sort((a,b)=>date(a.created_at)!-date(b.created_at)!)[0];
      if (date(item.createdAt)!>=since && date(item.createdAt)!<=until && earliest?.run_attempt===1
        && ["success","failure","cancelled","timed_out"].includes(earliest.conclusion)) row.firstPassCi=earliest.conclusion==="success";
      row.sameHeadReruns=linked.reduce((n,r)=>n+r.run_attempt-1,0);
    }
    const [owner,name] = repo.split("/");
    const detail = await parse(["api","graphql","-f",`query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{comments(first:1){nodes{createdAt author{login}}}}} timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){pageInfo{hasNextPage} nodes{... on CrossReferencedEvent{source{... on Issue{number createdAt labels(first:100){pageInfo{hasNextPage} nodes{name}}}}}}}}}}`,"-f",`owner=${owner}`,"-f",`name=${name}`,"-F",`number=${item.number}`]);
    const pr = detail?.errors ? undefined : detail?.data?.repository?.pullRequest;
    const threads = connection(pr?.reviewThreads), references = connection(pr?.timelineItems);
    if (threads && threads.every(t => date(t?.comments?.nodes?.[0]?.createdAt) !== undefined && typeof t.comments.nodes[0].author?.login === "string")) row.connectorThreads = threads.flatMap(t => /^(?:chatgpt-codex-connector|chatgpt-codex-connector\[bot\])$/.test(t.comments.nodes[0].author.login) ? [date(t.comments.nodes[0].createdAt)!] : []);
    if (references && references.every(r => id(r?.source?.number) && date(r.source.createdAt) !== undefined && connection(r.source.labels)?.every(label=>typeof label?.name === "string"))) row.bugIssues = [...new Map(references.flatMap(r => connection(r.source.labels)!.some(label => label.name === "bug") ? [[r.source.number,{id:r.source.number,at:date(r.source.createdAt)!}] as const] : [])).values()];
    if (!row.complete || !pr) complete = false;
    rows.push(row);
  }
  return source(rows,complete);
}
/** Row ordinals bind to this invocation's docs file; titles/state prose never enter the exported receipt. */
export function dogfoodFeatures(file: string): Source<FeatureEvidence[]> {
  const text = dogfoodLines(file,128*1024);
  const mappings: [RegExp,string[],string[]?][] = [
    [/Message bus/,["envelope","overflow"]], [/Task board/,["task"]], [/Overlap/,["overlap"]],
    [/WIP caps/,["task"],["ready held"]], [/Task sweep/,["task"],["idle sweep","escalated"]], [/Turn-free/,["cohort"]],
    [/Shared memory/,["memory_brief"]],
    [/Quota budgets/,["quota","budget_pause","budget_resume","quota_reset"]], [/Token usage/,["tokens","usage"]],
    [/Context gate/,["context_pressure"]], [/Permission modes/,["permission"]], [/PII routing/,["pii_screen"]],
    [/Settings reload/,["settings"]], [/Release authorization/,["release_authorization"]],
  ];
  const rows = text.data.filter(line=>line.startsWith("| ") && !line.startsWith("| Feature ") && !line.startsWith("| ---"));
  return {available:text.available,complete:text.complete,data:rows.map((row,index)=>{const rule=mappings.find(([re])=>re.test(row.split("|")[1] ?? ""));return {id:index+1,types:rule?.[1] ?? null,...(rule?.[2] ? {taskEvents:rule[2]} : {})};})};
}
export async function readDogfood(root: string, stateDir: string, since: number, until = Date.now(), run: SdlcGh = sdlcGh) {
  const tasks = dogfoodTasks(join(stateDir,"hub.db"));
  let repo = "";
  try { const r = await run(["repo","view","--json","nameWithOwner"],5000,root,8192); if (r.code === 0) repo = JSON.parse(r.stdout).nameWithOwner; } catch { /* unknown */ }
  const events = dogfoodEvents(dogfoodLines(join(stateDir,"events.jsonl")),since,until);
  const log = dogfoodLines(join(stateDir,"hub.log"));
  log.data = log.data.filter(line => {
    const at=date(line.slice(0,24));
    if (at === undefined) { log.complete = false; return false; }
    return at >= since && at <= until;
  });
  return dogfoodScorecard({since,until,tasks,events,log,journal:dogfoodJournal(join(stateDir,"hub.db"),since,until),prs:await dogfoodPrs(repo,tasks,since,until,run),features:dogfoodFeatures(join(root,"docs/dogfood.md"))});
}
