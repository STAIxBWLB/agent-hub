import { afterEach, expect, test } from "bun:test";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig,sdlcReceipt,type SdlcGh } from "../src/hub/sdlc.ts";
import type { DeliveryTask } from "../src/hub/sdlc-queue.ts";
const A="a".repeat(40),B="b".repeat(40),BASE="c".repeat(40),MERGED="d".repeat(40);
const cleanups:(()=>void)[]=[],allCalls:string[][]=[];
afterEach(()=>{for(const fn of cleanups.splice(0).reverse())fn();});
interface World { head: string; draft: boolean; branch: string; state: "OPEN" | "MERGED"; review: "APPROVED" | "CHANGES_REQUESTED" | null; threads: number; requests: number | null; paths: string[]; checks: { name: string; conclusion?: string; status?: string }[] }
const pr = (patch: Partial<World> = {}): World => ({ head: A, draft: false, branch: "feat/786", state: "OPEN", review: null, threads: 0, requests: 0, paths: ["src/a.ts"], checks: [{ name: "gate", conclusion: "SUCCESS" }], ...patch });

function fakeGh(prs: Record<number, World>, options: { mergeExit?: number; mergeLands?: boolean; hold?: Promise<void>; /** Runs before each call is answered: how a test moves GitHub between two reads. */ onCall?: (args: string[], index: number) => void } = {}) {
  const calls: string[][] = [];
  const view = (n: number) => { const p = prs[n]!; return { headRefOid: p.head, headRefName: p.branch, isDraft: p.draft, baseRefName: "main", baseRefOid: BASE, state: p.state, changedFiles: p.paths.length, statusCheckRollup: p.checks, reviewDecision: p.review, ...(p.requests === null ? {} : { reviewRequests: Array.from({ length: p.requests }, () => ({ requestedReviewer: { __typename: "User" } })) }), files: p.paths.map(path => ({ path, changeType: "MODIFIED" })), mergeCommit: p.state === "MERGED" ? { oid: MERGED } : undefined }; };
  const run: SdlcGh = async args => {
    await options.hold;
    options.onCall?.(args, calls.length);
    calls.push(args); allCalls.push(args);
    if (args[0] === "pr" && args[1] === "merge") {
      const n = Number(args[2]);
      if (options.mergeLands !== false && (options.mergeExit ?? 0) === 0) prs[n]!.state = "MERGED";
      return { code: options.mergeExit ?? 0, stdout: "" };
    }
    const open = Object.entries(prs).filter(([, p]) => p.state === "OPEN").map(([n, p]) => ({ number: Number(n), headRefOid: p.head, baseRefName: "main", baseRefOid: BASE }));
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(open) };
    if (args[0] === "pr" && args[1] === "view") return prs[Number(args[2])] ? { code: 0, stdout: JSON.stringify(view(Number(args[2]))) } : { code: 1, stdout: "" };
    const finalQuery = args.find(arg => arg.startsWith("query=") && arg.includes("queue_p"));
    if (finalQuery) {
      const repository: Record<string, unknown> = {};
      for (const match of finalQuery.matchAll(/queue_p([0-9]+):/g)) {
        const n = Number(match[1]), p = prs[n]!;
        repository[`queue_p${n}`] = { headRefOid: p.head, state: p.state, isDraft: p.draft, baseRefName: "main", baseRefOid: BASE, changedFiles: p.paths.length, reviewDecision: p.review,
          reviewRequests: { nodes: Array.from({ length: p.requests ?? 0 }, () => ({ requestedReviewer: { __typename: "User" } })), pageInfo: { hasNextPage: false } }, reviewThreads: { nodes: Array.from({ length: p.threads }, () => ({ isResolved: false })), pageInfo: { hasNextPage: false } },
          statusCheckRollup: { contexts: { nodes: p.checks, pageInfo: { hasNextPage: false } } } };
      }
      for (const match of finalQuery.matchAll(/queue_i([0-9]+):issue\(number:([0-9]+)\)/g)) repository[`queue_i${match[1]}`] = { number: Number(match[2]), labels: { nodes: [], pageInfo: { hasNextPage: false } } };
      repository.pullRequests = { nodes: open, pageInfo: { hasNextPage: false } };
      return { code: 0, stdout: JSON.stringify({ data: { repository } }) };
    }
    const n = Number(args.at(-1)?.split("=")[1]), issueArg = args.find(arg => arg.startsWith("issue="));
    const p = prs[n];
    if (!p) return { code: 1, stdout: "" };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: p.head, reviewThreads: { nodes: Array.from({ length: p.threads }, () => ({ isResolved: false })), pageInfo: { hasNextPage: false } } },
      ...(issueArg ? { issue: { number: Number(issueArg.split("=")[1]), labels: { nodes: [], pageInfo: { hasNextPage: false } } } } : {}) } } }) };
  };
  return { run, calls, merges: () => calls.filter(c => c[0] === "pr" && c[1] === "merge") };
}

const config = (extra: Record<string, unknown> = {}) => sdlcConfig({ mode: "advise", required_checks: ["gate"], auto_merge: "on", ...extra });
const task = (id: number, n: number, over: Partial<DeliveryTask> = {}, receipt: Partial<NonNullable<DeliveryTask["receipt"]>> = {}): DeliveryTask => ({ id, after: [], private: false, receipt: { repo: "owner/repo", issue: id, pr: n, stage: "merge", reviewedHead: A, localHead: A, localResult: "passed", ...receipt }, ...over });

interface Options {autoMode?:"off"|"dry-run";mergeExit?:number;lands?:boolean;serverLandsOnFailure?:boolean;gone?:boolean;branch?:string;fork?:boolean;protected?:boolean;rules?:unknown;refHead?:string;deleteFails?:boolean;lag?:number;commitMissing?:boolean;readbackFails?:boolean;mergeThrowsAfterLanding?:boolean;casHeadMoves?:boolean;afterMergeRead?:()=>void;beforeDeleteRead?:()=>void;notifyFails?:boolean}
function fixture(o:Options={}) {
  const dir=mkdtempSync(join(tmpdir(),"ahub-merge-record-")),db=join(dir,"hub.db"),board=new Board(db),bus=new Bus({batchMs:0});
  const prs={1:pr()},gh=fakeGh(prs,{mergeExit:o.mergeExit,mergeLands:o.lands});
  const calls:string[][]=[],notices:string[]=[];let deleted=!!o.gone,lag=o.lag??0,observed=false;
  const branch=o.branch??"feat/recording";
  const metadata=(withRef:boolean)=>({data:{repository:{id:"R_fixture",nameWithOwner:"owner/repo",defaultBranchRef:{name:"main"},pullRequest:{state:"MERGED",headRefName:branch,headRefOid:A,headRepository:{nameWithOwner:o.fork?"other/repo":"owner/repo"},mergeCommit:{oid:MERGED}},...(withRef?{ref:deleted?null:{name:branch,prefix:"refs/heads/",target:{oid:o.refHead??A},branchProtectionRule:o.protected?{id:"protected"}:null}}:{})}}});
  const run:SdlcGh=async args=>{
    calls.push(args);
    const query=args.find(a=>a.startsWith("query="))??"";
    if(query.includes("updateRefs(")) {
      expect(query).toBe('query=mutation($repo:ID!,$ref:GitRefname!,$before:GitObjectID!,$after:GitObjectID!){updateRefs(input:{repositoryId:$repo,clientMutationId:"agent-hub-post-merge-cleanup",refUpdates:[{name:$ref,beforeOid:$before,afterOid:$after}]}){clientMutationId}}');
      expect(args.filter(a=>/^(repo|ref|before|after)=/.test(a))).toEqual(["repo=R_fixture",`ref=refs/heads/${branch}`,`before=${A}`,`after=${"0".repeat(40)}`]);
      expect(board.get(1)?.sdlc?.merge?.cleanup).toBe("claimed");
      expect(board.get(1)?.sdlc?.merge?.state).toBe("merged");
      if(o.casHeadMoves){o.refHead=B;return {code:0,stdout:JSON.stringify({errors:[{message:"PRIVATE_HEAD_CHANGED"}]})};}
      if(o.deleteFails)return {code:1,stdout:"PRIVATE_REMOTE_ERROR"};
      deleted=true;return {code:0,stdout:JSON.stringify({data:{updateRefs:{clientMutationId:"agent-hub-post-merge-cleanup"}}})};
    }
    if(query.includes("headRepository")) {if(query.includes("qualifiedName"))o.beforeDeleteRead?.();return {code:0,stdout:JSON.stringify(metadata(query.includes("qualifiedName")))};}
    if(args[0]==="api" && args[1]?.includes("/rules/branches/"))return {code:0,stdout:JSON.stringify(o.rules??[])};
    if(o.mergeThrowsAfterLanding && args[0]==="pr"&&args[1]==="merge"){prs[1].state="MERGED";throw new Error("PRIVATE_TRANSPORT_ERROR");}
    const r=await gh.run(args);
    if(o.serverLandsOnFailure && args[0]==="pr"&&args[1]==="merge")prs[1].state="MERGED";
    if(prs[1].state==="MERGED" && args[0]==="pr" && args[1]==="view") {
      if(!observed){observed=true;o.afterMergeRead?.();}
      if(o.readbackFails)return {code:1,stdout:"PRIVATE_READBACK_FAILURE"};
      const body=JSON.parse(r.stdout);
      if(lag-->0)body.state="OPEN";
      if(o.commitMissing)delete body.mergeCommit;
      return {code:r.code,stdout:JSON.stringify(body)};
    }
    return r;
  };
  const roles:Record<string,"conductor"[]>={claude:["conductor"]};
  const tasks=new Tasks({board,bus,roles,cwd:dir,project:"fixture",repository:"owner/repo",routing:()=>loadRouting(dir),notify:line=>{if(o.notifyFails)throw new Error("notification failed");notices.push(line);},sdlc:{config:()=>config({mode:"off",...(o.autoMode?{auto_merge:o.autoMode}:{})}),gh:run}});
  const t=board.propose(USER,{title:"PRIVATE_TITLE",detail:"PRIVATE_DETAIL",class:"implement"});
  board.update(t.id,USER,"accepted",{owner:USER,reviewer:USER,state:"in_progress"});board.update(t.id,USER,"done",{state:"in_review"});board.update(t.id,USER,"approved",{state:"approved"});
  tasks.recordLifecycle(USER,t.id,{repo:"owner/repo",pr:1,stage:"merge",reviewedHead:A,localHead:A,localResult:"passed"});
  cleanups.push(()=>{bus.closeJournal();board.close();rmSync(dir,{recursive:true,force:true});});
  return {tasks,board,bus,roles,calls,notices,db,run,deleted:()=>deleted,merges:()=>calls.filter(a=>a[0]==="pr"&&a[1]==="merge"),deletes:()=>calls.filter(a=>a.some(v=>v.includes("mutation(")&&v.includes("updateRefs(")))};
}

test("merged facts are durable before the one CAS delete and owner notice, and repeat invocation writes nothing",async()=>{
  const f=fixture();const result=await f.tasks.guardedMerge(USER,1);
  expect(result).toMatchObject({ran:true,result:{state:"merged",exit:0,mergeCommit:MERGED,cleanup:"deleted"}});
  expect(f.board.get(1)?.sdlc?.merge).toMatchObject({repo:"owner/repo",pr:1,head:A,state:"merged",exit:0,mergeCommit:MERGED,cleanup:"deleted",ownerNotice:"sent"});
  expect(f.deletes()).toHaveLength(1);
  const mutationIndex=f.calls.findIndex(a=>a.some(v=>v.includes("mutation(")&&v.includes("updateRefs(")));
  expect(f.calls[mutationIndex-1]![1]).toContain("/rules/branches/");
  expect(f.calls.every(a=>a[0]==="pr"||a[0]==="api")).toBe(true);
  const argv=f.deletes()[0]!;
  expect(argv).toContain("ref=refs/heads/feat/recording");expect(argv).toContain(`before=${A}`);expect(argv).toContain(`after=${"0".repeat(40)}`);
  const query=argv.find(a=>a.startsWith("query="))!;expect(query).toContain("refUpdates:[{name:$ref,beforeOid:$before,afterOid:$after}]");expect(query).not.toContain("force");
  expect(f.notices.join("\n")).not.toMatch(/PRIVATE_|feat\/recording/);
  expect(f.notices.some(v=>v.includes("Remove your local worktree and local branch"))).toBe(true);
  const before=f.calls.length;expect((await f.tasks.guardedMerge(USER,1)).ran).toBe(false);expect(f.calls).toHaveLength(before);
  const restarted=new Tasks({board:f.board,bus:f.bus,cwd:"/fixture",project:"fixture",repository:"owner/repo",routing:()=>loadRouting("/fixture"),notify:()=>{},sdlc:{config:()=>config({mode:"off"}),gh:f.run}});
  expect((await restarted.guardedMerge(USER,1)).ran).toBe(false);expect(f.calls).toHaveLength(before);
  expect(f.merges()).toHaveLength(1);expect(argv.join(" ")).not.toMatch(/--admin|--delete-branch|updateRef\(/);
});

test("nonzero merge exit still cleans after authoritative merged readback and lag reads stay bounded",async()=>{
  const f=fixture({mergeExit:1,lands:false});
  // Simulate an acknowledged provider-side merge despite the CLI losing its success response.
  const nonzero=fixture({mergeExit:1,serverLandsOnFailure:true});
  expect((await nonzero.tasks.guardedMerge(USER,1)).result).toMatchObject({state:"merged",exit:1,cleanup:"deleted"});
  expect(nonzero.deletes()).toHaveLength(1);
  const thrown=fixture({mergeThrowsAfterLanding:true});
  expect((await thrown.tasks.guardedMerge(USER,1)).result).toMatchObject({state:"merged",exit:1,cleanup:"deleted"});
  const world=fixture({lag:2});
  const result=await world.tasks.guardedMerge(USER,1);
  expect(result.result).toMatchObject({state:"merged",mergeCommit:MERGED,cleanup:"deleted"});
  expect(world.calls.filter(a=>a[0]==="pr"&&a[1]==="view")).toHaveLength(6);
  expect((await f.tasks.guardedMerge(USER,1)).result).toMatchObject({state:"not_merged",exit:1,cleanup:"skipped"});
  expect(f.deletes()).toHaveLength(0);
});

test("already gone unsafe protected fork default or moved head branches are never deleted",async()=>{
  for(const [o,cleanup,reason] of [
    [{gone:true},"already_gone",undefined],[{fork:true},"skipped","identity_changed"],[{branch:"main"},"skipped","default_branch"],
    [{protected:true},"skipped","protected_branch"],[{rules:[{type:"deletion"}]},"skipped","protected_branch"],[{rules:{}},"skipped","metadata_unknown"],[{refHead:B},"skipped","head_changed"],[{branch:"../main"},"skipped","metadata_unknown"],
  ] as [Options,string,string|undefined][]) {
    const f=fixture(o),r=await f.tasks.guardedMerge(USER,1);
    expect(r.result?.cleanup).toBe(cleanup);if(reason)expect(r.result?.reason).toBe(reason);expect(f.deletes()).toHaveLength(0);
  }
});

test("uncertain cleanup and notification claims are durable and are never automatically repeated",async()=>{
  for(const o of [{deleteFails:true},{notifyFails:true}]) {
    const f=fixture(o);await f.tasks.guardedMerge(USER,1);
    expect(f.board.get(1)?.sdlc?.merge).toMatchObject(o.deleteFails?{cleanup:"unknown",reason:"delete_unconfirmed"}:{ownerNotice:"unknown"});
    const n=f.calls.length;await f.tasks.guardedMerge(USER,1);expect(f.calls).toHaveLength(n);
  }
});

test("readback without merged commit records observed facts but cannot clean",async()=>{
  const f=fixture({commitMissing:true}),r=await f.tasks.guardedMerge(USER,1);
  expect(r.result).toMatchObject({state:"merged",cleanup:"skipped",reason:"missing_commit"});expect(f.deletes()).toHaveLength(0);
});

test("tool receipts cannot forge host merge results and artifact or reviewed-head relinks clear them",()=>{
  expect(()=>sdlcReceipt({merge:{state:"merged"}})).toThrow("externally observed");
  const f=fixture();const old=f.board.get(1)!.sdlc!;
  const record={repo:"owner/repo",pr:1,head:A,at:1,state:"merged" as const,exit:0,cleanup:"not_started" as const,ownerNotice:"not_started" as const};
  expect(sdlcReceipt({pr:2},{...old,merge:record}).merge).toBeUndefined();
  expect(sdlcReceipt({reviewedHead:B},{...old,merge:record}).merge).toBeUndefined();
});


test("artifact privacy and conductor changes across awaited cleanup reads retain old facts without stale attachment or cleanup",async()=>{
  let relink!:ReturnType<typeof fixture>;
  relink=fixture({beforeDeleteRead:()=>relink.tasks.recordLifecycle(USER,1,{repo:"owner/repo",pr:2,stage:"merge"})});
  await relink.tasks.guardedMerge(USER,1);
  expect(relink.board.get(1)?.sdlc?.pr).toBe(2);expect(relink.board.get(1)?.sdlc?.merge).toBeUndefined();expect(relink.deletes()).toHaveLength(0);
  expect(relink.board.get(1)?.history.some(h=>h.event==="merge result (detached)"&&h.note?.includes(MERGED))).toBe(true);
  expect(relink.notices.some(n=>n.includes("Remove your local"))).toBe(false);
  let hidden!:ReturnType<typeof fixture>;
  hidden=fixture({afterMergeRead:()=>hidden.board.update(1,USER,"private",{signals:["pii"]})});
  await hidden.tasks.guardedMerge(USER,1);
  expect(hidden.deletes()).toHaveLength(0);expect(hidden.board.get(1)?.sdlc?.merge).toBeUndefined();
  expect(JSON.stringify(hidden.tasks.publicView(hidden.board.get(1)!,true))).not.toMatch(/PRIVATE_|owner\/repo|aaaaaaaa|dddddddd/);
  let revoked!:ReturnType<typeof fixture>;
  revoked=fixture({beforeDeleteRead:()=>{delete revoked.roles.claude;}});
  await revoked.tasks.guardedMerge("claude",1);
  expect(revoked.deletes()).toHaveLength(0);expect(revoked.notices.some(n=>n.includes("Remove your local"))).toBe(false);
});

test("failed or unknown merge readback records bounded outcomes and never attempts cleanup",async()=>{
  for(const o of [{lands:false},{mergeExit:2,lands:false},{readbackFails:true}]) {
    const f=fixture(o),r=await f.tasks.guardedMerge(USER,1);
    expect(r.result?.state).toBe(o.readbackFails?"unknown":"not_merged");
    expect(f.board.get(1)?.sdlc?.merge?.state).toBe(o.readbackFails?"unknown":"not_merged");
    expect(f.deletes()).toHaveLength(0);expect(f.notices.some(n=>n.includes("Remove your local"))).toBe(false);
    expect(JSON.stringify(f.tasks.publicView(f.board.get(1)!,true))).not.toContain("PRIVATE_READBACK_FAILURE");
  }
});

test("CAS mismatch preserves the branch and records uncertain deletion without retry",async()=>{
  const f=fixture({casHeadMoves:true}),r=await f.tasks.guardedMerge(USER,1);
  expect(r.result).toMatchObject({state:"merged",cleanup:"skipped",reason:"head_changed"});
  expect(f.deleted()).toBe(false);expect(f.deletes()).toHaveLength(1);
  await f.tasks.guardedMerge(USER,1);expect(f.deletes()).toHaveLength(1);
});

test("a durable cleanup or owner-notice claim survives restart as uncertain without repeating effects",async()=>{
  for(const stage of ["cleanup","notice"] as const) {
    const f=fixture();await f.tasks.guardedMerge(USER,1);
    const record=f.board.get(1)!.sdlc!.merge!;
    f.board.update(1,USER,"fixture interrupted stage",{sdlc:{...f.board.get(1)!.sdlc!,merge:{...record,cleanup:stage==="cleanup"?"claimed":record.cleanup,ownerNotice:stage==="notice"?"claimed":"not_started"}}});
    const after=f.calls.length;
    const restarted=new Tasks({board:f.board,bus:f.bus,cwd:"/fixture",project:"fixture",routing:()=>loadRouting("/fixture"),notify:()=>{},sdlc:{config:()=>config({mode:"off"}),gh:f.run}});
    const r=await restarted.guardedMerge(USER,1);
    expect(r).toMatchObject({ran:false,decision:"refused"});expect(f.calls).toHaveLength(after);
    expect(f.board.get(1)!.sdlc!.merge![stage==="cleanup"?"cleanup":"ownerNotice"]).toBe("claimed");
  }
});

test("known not-merged failures permit explicit command retry but never an automatic retry",async()=>{
  const options:Options={lands:false},f=fixture(options);
  expect((await f.tasks.guardedMerge(USER,1)).result?.state).toBe("not_merged");
  const calls=f.calls.length;
  expect((await f.tasks.guardedMerge(USER,1,{trigger:"review"})).ran).toBe(false);expect(f.calls).toHaveLength(calls);
  expect((await f.tasks.guardedMerge(USER,1,{trigger:"command"})).ran).toBe(true);expect(f.merges()).toHaveLength(2);
});

test("on-mode gate refusal records only bounded gate facts and off or dry-run writes no history",async()=>{
  const f=fixture();f.board.update(1,USER,"privacy",{signals:["pii"]});
  const result=await f.tasks.guardedMerge(USER,1);
  expect(result.ran).toBe(false);expect(f.board.get(1)?.sdlc?.merge).toBeUndefined();
  const refusal=f.board.get(1)?.history.findLast(h=>h.event==="merge refused");expect(refusal).toMatchObject({withheld:true});expect(refusal?.note).toContain("private task");
  const before=f.board.get(1)!.history.length;
  await f.tasks.guardedMerge(USER,1,{dryRun:true});expect(f.board.get(1)!.history).toHaveLength(before);
  for(const autoMode of ["off","dry-run"] as const) {
    const untouched=fixture({autoMode}),length=untouched.board.get(1)!.history.length;
    await untouched.tasks.guardedMerge(USER,1);expect(untouched.board.get(1)!.history).toHaveLength(length);
    expect(untouched.merges()).toHaveLength(0);expect(untouched.deletes()).toHaveLength(0);
  }
});

test("synchronous claim-write observers cannot revoke authority privacy or artifact identity and still allow CAS or owner notice",async()=>{
  for(const stage of ["cleanup","notice"] as const)for(const flip of ["authority","privacy","identity"] as const) {
    const f=fixture();let flipped=false;
    f.board.onChange=(task,h)=>{
      const r=task.sdlc?.merge;
      if(flipped || h.event!=="merge result" || (stage==="cleanup"?r?.cleanup:r?.ownerNotice)!=="claimed")return;
      flipped=true;
      if(flip==="authority")delete f.roles.claude;
      else if(flip==="privacy")f.board.update(1,USER,"private",{signals:["pii"]});
      else f.tasks.recordLifecycle(USER,1,{repo:"owner/repo",pr:2,stage:"merge"});
    };
    await f.tasks.guardedMerge("claude",1);
    expect(flipped).toBe(true);expect(f.deletes()).toHaveLength(stage==="cleanup"?0:1);
    expect(f.notices.some(n=>n.includes("Remove your local"))).toBe(false);
    if(flip==="identity"){expect(f.board.get(1)!.sdlc!.pr).toBe(2);expect(f.board.get(1)!.sdlc!.merge).toBeUndefined();}
  }
});

test("owner notice uses actual current publicView and refuses a role revoked during that projection",async()=>{
  const f=fixture(),project=f.tasks.publicView.bind(f.tasks);let projected=false;
  f.tasks.publicView=(task,full)=>{const view=project(task,full);projected=true;delete f.roles.claude;return view;};
  await f.tasks.guardedMerge("claude",1);
  expect(projected).toBe(true);expect(f.deletes()).toHaveLength(1);
  expect(f.notices.some(n=>n.includes("Remove your local"))).toBe(false);
});

test("initial artifact identity fences local head observed head and refs commit drift throughout cleanup",async()=>{
  for(const field of ["localHead","head","commit"] as const) {
    let f!:ReturnType<typeof fixture>;
    f=fixture({beforeDeleteRead:()=>{
      if(field==="localHead")f.tasks.recordLifecycle(USER,1,{localHead:B});
      else if(field==="head")f.board.update(1,USER,"observed head",{sdlc:{...f.board.get(1)!.sdlc!,head:B,merge:undefined}});
      else f.board.update(1,USER,"refs commit",{refs:{commit:B},sdlc:{...f.board.get(1)!.sdlc!,merge:undefined}});
    }});
    await f.tasks.guardedMerge(USER,1);
    expect(f.deletes()).toHaveLength(0);expect(f.board.get(1)?.sdlc?.merge).toBeUndefined();
    expect(f.notices.some(n=>n.includes("Remove your local"))).toBe(false);
    expect(f.board.get(1)!.history.some(h=>h.event==="merge result (detached)"&&h.note?.includes(MERGED))).toBe(true);
    if(field==="localHead")expect(f.board.get(1)!.sdlc!.localHead).toBe(B);
    else if(field==="head")expect(f.board.get(1)!.sdlc!.head).toBe(B);
    else expect(f.board.get(1)!.refs.commit).toBe(B);
  }
});
