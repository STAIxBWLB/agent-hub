import { expect, test } from "bun:test";
import { readReleaseReadiness, type DocEvidence, type ReleaseGit } from "../src/hub/sdlc-release.ts";
import type { SdlcGh } from "../src/hub/sdlc.ts";
const H="a".repeat(40),T="b".repeat(40),C="c".repeat(40),X="d".repeat(40);
function fake(options:{version?:string;tag?:string;remote?:string;ancestor?:boolean;stale?:boolean;native?:string;race?:boolean}={}) {
 const calls:string[][]=[];let heads=0;
 const git:ReleaseGit=args=>{
  calls.push(args);
  if(args[0]==="rev-parse"&&args.at(-1)==="HEAD")return{code:0,stdout:options.race&&heads++>0?X:H};
  if(args[0]==="rev-parse")return{code:0,stdout:T};
  if(args[0]==="show")return{code:0,stdout:JSON.stringify({version:options.version??"1.2.4",private:"PRIVATE_PACKAGE_MARKER"})};
  if(args[0]==="merge-base")return{code:options.ancestor===false?1:0,stdout:""};
  return{code:0,stdout:C};
 };
 const gh:SdlcGh=async args=>{
  calls.push(args);
  if(args[0]==="release")return{code:0,stdout:JSON.stringify([{tagName:options.tag??"v1.2.3",isDraft:false,isPrerelease:(options.tag??"").includes("-"),publishedAt:"2026-10-11T00:00:00Z"}])};
  if(args[0]==="pr")return{code:0,stdout:JSON.stringify([{number:1,mergeCommit:{oid:C}}])};
  if(args.some(arg=>arg.includes("associatedPullRequests")))return{code:0,stdout:JSON.stringify({data:{repository:{c0:{oid:C,associatedPullRequests:{nodes:[{number:1,state:"MERGED",mergeCommit:{oid:C}}],pageInfo:{hasNextPage:false}}}}}})};
  if(args.some(arg=>arg.includes("releases(first:100"))) {
    const query = args.find(arg=>arg.startsWith("query=")) || "";
    const ledgers = Object.fromEntries([...query.matchAll(/ledger_([0-9]+):issue/g)].map(match=>[`ledger_${match[1]}`,{number:Number(match[1]),state:options.native??"CLOSED"}]));
    const repository = { ...ledgers, releases:{nodes:[{tagName:options.tag??"v1.2.3",isDraft:false}],pageInfo:{hasNextPage:false}}, ref:{target:{target:{oid:options.remote??T}}} };
    return {code:0,stdout:JSON.stringify({data:{repository}})};
  }
  if(args[0]==="issue")return{code:0,stdout:JSON.stringify({number:273,state:options.native??"CLOSED"})};
  return{code:0,stdout:JSON.stringify({data:{repository:{ref:{target:{target:{oid:options.remote??T}}}}}})};
 };
 const docs=async():Promise<DocEvidence>=>({schemaVersion:1,head:H,version:options.version??"1.2.4",documents:[{path:"README.md",state:options.stale?"stale":"fresh",verifiedAgainst:T,commits:options.stale?1:0,dirty:false}],errors:0,fresh:!options.stale});
 return{calls,readers:{git,gh,docs}};
}
test("release source evidence binds local remote tag ancestry head doc freshness and version without publishing (#257)",async()=>{
 const f=fake(),r=await readReleaseReadiness("fixture","owner/repo",[273],f.readers);
 expect(r).toMatchObject({head:H,version:"1.2.4",tag:"v1.2.3",tagCommit:T,commits:[C],mergedPrs:[{pr:1,commit:C}],sourceReady:true,native:"unverified",ready:false});
 expect(r.blockers).toEqual(["native acceptance and person release decision unverified"]);expect(JSON.stringify(r)).not.toContain("PRIVATE_PACKAGE_MARKER");
 expect(f.calls.flat().join(" ")).not.toMatch(/body|title|publish|push|create|tag -/);
});
test("release version advancement follows SemVer precedence including prereleases and build metadata (#257)", async () => {
 for(const [version,tag,expected] of [["1.3.0-rc.1","v1.2.3",true],["1.3.0-rc.2","v1.3.0-rc.1",true],["1.3.0","v1.3.0-rc.2",true],["1.3.0-rc.1","v1.3.0",false],["1.2.3+build.2","v1.2.3+build.1",false]] as const){
  expect((await readReleaseReadiness("fixture","owner/repo",[273],fake({version,tag}).readers)).sourceReady).toBe(expected);
 }
});
test("release predecessor read includes the published prerelease instead of stable-only latest (#257)", async () => {
 const f=fake({version:"1.3.0-rc.2",tag:"v1.3.0-rc.1"}),gh=f.readers.gh;
 f.readers.gh=async args=>args[0]==="release"&&args[1]==="view"?{code:0,stdout:JSON.stringify({tagName:"v1.2.3",isDraft:false,isPrerelease:false})}:gh(args);
 const report=await readReleaseReadiness("fixture","owner/repo",[273],f.readers);
 expect(report.sourceReady).toBe(true);expect(report.tag).toBe("v1.3.0-rc.1");expect(report.tagCommit).toBe(T);
 const request=f.calls.find(args=>args[0]==="release");expect(request?.slice(0,2)).toEqual(["release","list"]);expect(request).toContain("--exclude-drafts");expect(request).not.toContain("--exclude-pre-releases");
});
test("release merged PR coverage reads only post-tag commits despite over 100 historical PRs (#257)", async () => {
 const f=fake(), original=f.readers.gh;
 f.readers.gh=async args=>args[0]==="pr"?{code:0,stdout:JSON.stringify(Array.from({length:101},(_,i)=>({number:i+1,mergeCommit:{oid:T}})))}:original(args);
 const r=await readReleaseReadiness("fixture","owner/repo",[273],f.readers);
 expect(r.sourceReady).toBe(true);expect(r.mergedPrs).toEqual([{pr:1,commit:C}]);
 const queries=f.calls.flat().filter(arg=>arg.includes("associatedPullRequests"));expect(queries).toHaveLength(1);expect(queries[0]).toContain(`object(oid:"${C}")`);expect(queries[0]).not.toContain(`object(oid:"${T}")`);
 for(const malformed of [undefined,{oid:X,associatedPullRequests:{nodes:[],pageInfo:{hasNextPage:false}}},{oid:C,associatedPullRequests:{nodes:[],pageInfo:{hasNextPage:true}}}]){
  const bad=fake(), gh=bad.readers.gh;bad.readers.gh=async args=>args.some(arg=>arg.includes("associatedPullRequests"))?{code:0,stdout:JSON.stringify({data:{repository:{c0:malformed}}})}:gh(args);
  expect((await readReleaseReadiness("fixture","owner/repo",[273],bad.readers)).sourceReady).toBe(false);
 }
});
test("release mismatched tags stale docs old version open native ledger and changing heads remain blocked (#257)",async()=>{
 for(const options of [{remote:X},{ancestor:false},{stale:true},{version:"1.2.3"},{native:"OPEN"},{race:true}]){
  const r=await readReleaseReadiness("fixture","owner/repo",[273],fake(options).readers);expect(r.sourceReady).toBe(false);expect(r.ready).toBe(false);
 }
 const unspecified=await readReleaseReadiness("fixture","owner/repo",[],fake().readers);expect(unspecified.blockers).toContain("native verification ledger unspecified");
 const unavailable=await readReleaseReadiness("fixture","owner/repo",[273],{...fake().readers,gh:async()=>({code:1,stdout:"PRIVATE_ERROR_MARKER"})});expect(unavailable.sourceReady).toBe(false);expect(JSON.stringify(unavailable)).not.toContain("PRIVATE_ERROR_MARKER");
 await expect(readReleaseReadiness("fixture","--bad/repo",[],fake().readers)).rejects.toThrow("owner/repository");
});


test("release final snapshot refuses a new predecessor moved tag or unavailable evidence (#257)", async () => {
  const baseline = fake(); expect((await readReleaseReadiness("fixture", "owner/repo", [273], baseline.readers)).sourceReady).toBe(true);
  for (const fault of ["new-release", "moved-tag", "missing", "invalid", "drafts"] as const) {
    const f = fake(), gh = f.readers.gh;
    f.readers.gh = async args => {
      const reply = await gh(args);
      if (!args.some(arg => arg.includes("releases(first:100"))) return reply;
      if (fault === "missing") return { code: 1, stdout: "PRIVATE_RELEASE_ERROR_MARKER" };
      const data = JSON.parse(reply.stdout), repo = data.data.repository;
      if (fault === "new-release") repo.releases.nodes.unshift({ tagName: "v1.2.4", isDraft: false });
      if (fault === "moved-tag") repo.ref.target.target.oid = X;
      if (fault === "invalid") repo.releases.nodes[0].isDraft = "false";
      if (fault === "drafts") { repo.releases.nodes = [{ tagName: "v1.2.4", isDraft: true }]; repo.releases.pageInfo.hasNextPage = true; }
      return { code: 0, stdout: JSON.stringify(data) };
    };
    const report = await readReleaseReadiness("fixture", "owner/repo", [273], f.readers);
    expect(report.sourceReady).toBe(false); expect(report.ready).toBe(false);
    expect(report.blockers).toContain("published release or remote tag changed or could not be reverified");
    expect(JSON.stringify(report)).not.toContain("PRIVATE_RELEASE_ERROR_MARKER");
  }
});


test("release final snapshot invalidates reopened missing or mismatched ledger identities (#257)", async () => {
  for (const kind of ["reopened", "missing", "identity"] as const) {
    const f = fake(), gh = f.readers.gh;
    f.readers.gh = async args => {
      const reply = await gh(args);
      if (!args.some(arg => arg.includes("releases(first:100"))) return reply;
      const data = JSON.parse(reply.stdout), repo = data.data.repository;
      if (kind === "reopened") repo.ledger_273.state = "OPEN";
      if (kind === "missing") delete repo.ledger_273;
      if (kind === "identity") repo.ledger_273.number = 274;
      return { code: 0, stdout: JSON.stringify(data) };
    };
    const report = await readReleaseReadiness("fixture", "owner/repo", [273], f.readers);
    expect(report.sourceReady).toBe(false); expect(report.ready).toBe(false);
    expect(report.liveIssues).toEqual([{ id: 273, state: kind === "reopened" ? "open" : "unknown" }]);
    expect(report.blockers).toContain("live issue states changed or could not be reverified");
  }
});
