import { expect, test } from "bun:test";
import { readMergeQueue, type DeliveryTask } from "../src/hub/sdlc-queue.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
const A = "a".repeat(40), B = "b".repeat(40), M = "c".repeat(40);
const config = sdlcConfig({ mode: "enforce", required_checks: ["gate"] });
const task = (id: number, pr: number, after: number[] = [], privateTask = false): DeliveryTask => ({ id, after, private: privateTask, receipt: { repo: "owner/repo", issue: id, pr, stage: "implement", reviewedHead: A, localHead: A, localResult: "passed" } });
function fake(options: { ids?: number[]; heads?: Record<number, string>; paths?: Record<number,string[]>; merged?: number[]; incomplete?: boolean } = {}) {
  const calls: string[][] = [], ids = options.ids ?? [1,2];
  const run: SdlcGh = async args => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(ids.map(number => ({ number, headRefOid: options.heads?.[number] ?? A, baseRefName: "main", baseRefOid: M }))) };
    if (args[0] === "pr") {
      const pr = Number(args[2]), paths = options.paths?.[pr] ?? ["src/shared.ts"], head = options.heads?.[pr] ?? A;
      return { code: 0, stdout: JSON.stringify({ headRefOid: head, isDraft: false, baseRefName: "main", baseRefOid: M, state: options.merged?.includes(pr) ? "MERGED" : "OPEN", changedFiles: paths.length + (options.incomplete ? 1 : 0), statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }], reviewDecision: "APPROVED", reviewRequests: [], files: paths.map(path => ({path})), mergeCommit: options.merged?.includes(pr) ? { oid: M } : undefined }) };
    }
    const number = Number(args.at(-1)?.split("=")[1]);
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: options.heads?.[number] ?? A, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
  };
  return { run, calls };
}
test("merge queue uses explicit dependency order and never guesses precedence from touching paths (#257)", async () => {
  const f = fake(), links = [task(1,1),task(2,2)];
  const unknown = await readMergeQueue("owner/repo",config,links,f.run);
  expect(unknown.conflicts).toEqual([{left:1,right:2,files:1,order:"person_required"}]); expect(unknown.rows.every(r => !r.ready)).toBe(true);
  const ordered = await readMergeQueue("owner/repo",config,[task(1,1),task(2,2,[1])],f.run);
  expect(ordered.order).toEqual([1,2]); expect(ordered.conflicts[0]?.order).toBe("dependency"); expect(ordered.rows[0]?.ready).toBe(true); expect(ordered.rows[1]?.ready).toBe(false); expect(ordered.rows[1]?.blockers).toContain("dependency PR is still open");
  expect(JSON.stringify(ordered)).not.toContain("src/shared.ts"); expect(f.calls.flat().join(" ")).not.toContain("body"); expect(f.calls.flat().join(" ")).not.toContain("merge --");
});
test("queue stale heads incomplete files private and unlinked work remain blocked (#257)", async () => {
  const old = await readMergeQueue("owner/repo",config,[task(1,1)],fake({ids:[1],heads:{1:B}}).run); expect(old.rows[0]?.ready).toBe(false); expect(old.rows[0]?.blockers).toContain("current head has not been reviewed");
  const incomplete = await readMergeQueue("owner/repo",config,[task(1,1)],fake({ids:[1],incomplete:true}).run); expect(incomplete.complete).toBe(false); expect(incomplete.rows[0]?.ready).toBe(false);
  const f = fake({ids:[1]}); const privateView = await readMergeQueue("owner/repo",config,[task(1,1,[],true)],f.run); expect(privateView.rows[0]?.private).toBe(true); expect(f.calls).toHaveLength(1); expect(privateView.rows[0]?.head).toBeUndefined();
  const unlinked = await readMergeQueue("owner/repo",config,[],fake({ids:[1]}).run); expect(unlinked.rows[0]?.ready).toBe(false); expect(unlinked.rows[0]?.blockers).toContain("issue identity missing");
});
test("dependency merge proof cycles and truncation retain their uncertainty (#257)", async () => {
  const merged = await readMergeQueue("owner/repo",config,[task(1,1),task(2,2,[1])],fake({ids:[2],merged:[1]}).run); expect(merged.rows[0]?.ready).toBe(true);
  const missing = await readMergeQueue("owner/repo",config,[task(2,2,[99])],fake({ids:[2]}).run); expect(missing.rows[0]?.ready).toBe(false);
  const cycle = await readMergeQueue("owner/repo",config,[task(1,1,[2]),task(2,2,[1])],fake().run); expect(cycle.complete).toBe(false); expect(cycle.order).toEqual([]);
  const truncated = await readMergeQueue("owner/repo",config,[],fake({ids:Array.from({length:17},(_,i)=>i+1)}).run); expect(truncated.truncated).toBe(true); expect(truncated.complete).toBe(false); expect(truncated.rows).toHaveLength(16);
  await expect(readMergeQueue("--bad/repo",config,[],fake().run)).rejects.toThrow("owner/repository");
});

test("gsd-lite queue readiness uses current board phase views and keeps absent or failed views unknown (#257)", async () => {
 const c=sdlcConfig({mode:"enforce",workflow:"gsd-lite",required_checks:["gate"]}),t=task(1,1);
 t.receipt!.phase={id:"delivery",head:A,tasks:[],criteria:[{id:"check",required:true,result:"verified",refs:["sha256:"+"f".repeat(64)]}]};
 t.phase={workflow:"gsd-lite",ready:true,blockers:[],id:"delivery"};
 expect((await readMergeQueue("owner/repo",c,[t],fake({ids:[1]}).run)).rows[0]?.ready).toBe(true);
 t.phase=undefined;expect((await readMergeQueue("owner/repo",c,[t],fake({ids:[1]}).run)).rows[0]?.blockers).toContain("phase board evidence unknown");
 t.phase={workflow:"gsd-lite",ready:false,blockers:["phase child tasks not approved"]};expect((await readMergeQueue("owner/repo",c,[t],fake({ids:[1]}).run)).rows[0]?.ready).toBe(false);
});
test("truncated open PR coverage blocks every otherwise ready queue row (#257)", async () => {
 const ids=Array.from({length:17},(_,i)=>i+1), paths=Object.fromEntries(ids.map(id=>[id,[`src/unique-${id}.ts`]]));
 const report=await readMergeQueue("owner/repo",config,ids.map(id=>task(id,id)),fake({ids,paths}).run);
 expect(report.truncated).toBe(true);expect(report.rows).toHaveLength(16);
 expect(report.rows.every(row=>!row.ready)).toBe(true);
 expect(report.rows.every(row=>row.blockers.includes("open PR coverage truncated; touching order unknown"))).toBe(true);
 const complete=await readMergeQueue("owner/repo",config,[task(1,1)],fake({ids:[1],paths}).run);expect(complete.rows[0]?.ready).toBe(true);
});
test("unknown or private peer PR file coverage blocks ordinary readiness without private reads (#257)", async () => {
 const paths={1:["src/one.ts"],2:["src/two.ts"]};
 for(const unknown of ["files","base"]){
  const f=fake({paths}),run:SdlcGh=async args=>{const result=await f.run(args);if(args[0]==="pr"&&args[1]==="view"&&args[2]==="2"){const row=JSON.parse(result.stdout);if(unknown==="files")row.changedFiles=2;else delete row.baseRefName;return{code:0,stdout:JSON.stringify(row)}}return result};
  const incomplete=await readMergeQueue("owner/repo",config,[task(1,1),task(2,2)],run);
  expect(incomplete.rows[0]?.ready).toBe(false);expect(incomplete.rows[0]?.blockers).toContain("open PR file coverage incomplete; touching order unknown");
 }
 const privateFake=fake({paths}),privateView=await readMergeQueue("owner/repo",config,[task(1,1),task(2,2,[],true)],privateFake.run);
 expect(privateView.rows[0]?.ready).toBe(false);expect(privateView.rows[1]?.private).toBe(true);
 expect(privateFake.calls.filter(args=>args[0]==="pr"&&args[1]==="view").map(args=>args[2])).toEqual(["1"]);
});
test("queue completeness includes verified target branches beyond complete file pagination (#257)", async () => {
 const f=fake({ids:[1]}),run:SdlcGh=async args=>{const result=await f.run(args);if(args[0]==="pr"&&args[1]==="view"){const row=JSON.parse(result.stdout);delete row.baseRefName;return{code:0,stdout:JSON.stringify(row)}}return result};
 const unknown=await readMergeQueue("owner/repo",config,[task(1,1)],run);
 expect(unknown.complete).toBe(false);expect(unknown.rows[0]?.ready).toBe(false);
 const known=await readMergeQueue("owner/repo",config,[task(1,1)],fake({ids:[1]}).run);expect(known.complete).toBe(true);
});
test("touching PRs and their dependents stay unordered until a person supplies dependency order (#257)", async () => {
 const paths={1:["src/shared.ts"],2:["src/shared.ts"],3:["src/child.ts"],4:["src/independent.ts"]};
 const report=await readMergeQueue("owner/repo",config,[task(1,1),task(2,2),task(3,3,[1]),task(4,4)],fake({ids:[1,2,3,4],paths}).run);
 expect(report.order).toEqual([4]);expect(report.unordered).toEqual([1,2,3]);expect(report.complete).toBe(false);expect(report.rows.find(row=>row.pr===4)?.ready).toBe(true);
 const ordered=await readMergeQueue("owner/repo",config,[task(1,1),task(2,2,[1])],fake({paths}).run);
 expect(ordered.order).toEqual([1,2]);expect(ordered.unordered).toBeUndefined();expect(ordered.complete).toBe(true);
 const truncated=await readMergeQueue("owner/repo",config,[],fake({ids:Array.from({length:17},(_,i)=>i+1)}).run);expect(truncated.order).toEqual([]);
});
test("open PR identity readback fence invalidates added removed or unavailable sets (#257)", async () => {
 for(const final of [{code:0,stdout:"[]"},{code:0,stdout:JSON.stringify([{number:1,headRefOid:A,baseRefName:"main",baseRefOid:M},{number:2,headRefOid:A,baseRefName:"main",baseRefOid:M}])},{code:1,stdout:"PRIVATE_LIST_ERROR_MARKER"},{code:0,stdout:JSON.stringify([{number:1,headRefOid:A,baseRefName:"main",baseRefOid:M},{number:1,headRefOid:A,baseRefName:"main",baseRefOid:M}])}]){
  let lists=0;const f=fake({ids:[1]}),run:SdlcGh=args=>args[0]==="pr"&&args[1]==="list"&&++lists>1?Promise.resolve(final):f.run(args);
  const report=await readMergeQueue("owner/repo",config,[task(1,1)],run);
  expect(report.complete).toBe(false);expect(report.rows[0]?.ready).toBe(false);expect(report.order).toEqual([]);expect(report.unordered).toEqual([1]);expect(report.rows[0]?.blockers).toContain("open PR set changed or could not be reverified");expect(JSON.stringify(report)).not.toContain("PRIVATE_LIST_ERROR_MARKER");
 }
 const paths={1:["src/one.ts"],2:["src/two.ts"]},f=fake({paths});let lists=0;
 const run:SdlcGh=args=>args[0]==="pr"&&args[1]==="list"&&++lists>1?Promise.resolve({code:0,stdout:JSON.stringify([{number:2,headRefOid:A,baseRefName:"main",baseRefOid:M},{number:1,headRefOid:A,baseRefName:"main",baseRefOid:M}])}):f.run(args);
 expect((await readMergeQueue("owner/repo",config,[task(1,1),task(2,2)],run)).complete).toBe(true);
});
test("case-insensitive repository identities retain linked holders and merged dependencies (#257)", async () => {
 const predecessor=task(1,1),holder=task(2,2,[1]);predecessor.receipt!.repo="Owner/Repo";holder.receipt!.repo="OWNER/REPO";
 const report=await readMergeQueue("owner/repo",config,[predecessor,holder],fake({ids:[2],merged:[1]}).run);
 expect(report.rows[0]?.tasks).toEqual([2]);expect(report.rows[0]?.ready).toBe(true);expect(report.complete).toBe(true);
 predecessor.receipt!.repo="Owner/Other";
 expect((await readMergeQueue("owner/repo",config,[predecessor,holder],fake({ids:[2],merged:[1]}).run)).rows[0]?.ready).toBe(false);
});
test("final queue snapshot refuses changed heads even when open PR identities stay the same (#257)", async () => {
 const f=fake({paths:{1:["src/one.ts"],2:["src/two.ts"]}});let lists=0;
 const run:SdlcGh=args=>args[0]==="pr"&&args[1]==="list"&&++lists>1?Promise.resolve({code:0,stdout:JSON.stringify([{number:1,headRefOid:B,baseRefName:"main",baseRefOid:M},{number:2,headRefOid:A,baseRefName:"main",baseRefOid:M}])}):f.run(args);
 const report=await readMergeQueue("owner/repo",config,[task(1,1),task(2,2)],run);
 expect(report.complete).toBe(false);expect(report.order).toEqual([]);expect(report.rows.every(row=>!row.ready)).toBe(true);expect(report.unordered).toEqual([1,2]);
});
test("final queue snapshot rejects retargets and advancing bases without a head change (#257)", async () => {
 for(const target of [{baseRefName:"release",baseRefOid:M},{baseRefName:"main",baseRefOid:B}]){
  const f=fake({ids:[1]});let lists=0;
  const run:SdlcGh=args=>args[0]==="pr"&&args[1]==="list"&&++lists>1?Promise.resolve({code:0,stdout:JSON.stringify([{number:1,headRefOid:A,...target}])}):f.run(args);
  const report=await readMergeQueue("owner/repo",config,[task(1,1)],run);
  expect(report.complete).toBe(false);expect(report.order).toEqual([]);expect(report.rows[0]?.ready).toBe(false);
 }
});


test("private and mixed queue holders never expose board associations (#257)", async () => {
  for (const holders of [[task(937, 1, [], true)], [task(938, 1), task(937, 1, [], true)]]) {
    const f = fake({ ids: [1] });
    const report = await readMergeQueue("owner/repo", config, holders, f.run);
    expect(report.rows[0]).toMatchObject({ pr: 1, private: true, tasks: [], ready: false, after: [] });
    expect(JSON.stringify(report)).not.toContain("937"); expect(JSON.stringify(report)).not.toContain("938");
    expect(f.calls).toHaveLength(1);
  }
  const ordinary = await readMergeQueue("owner/repo", config, [task(938, 1)], fake({ ids: [1] }).run);
  expect(ordinary.rows[0]?.tasks).toEqual([938]);
});
