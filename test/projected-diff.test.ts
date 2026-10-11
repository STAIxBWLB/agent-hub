import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { repoOf, snapshot } from "../src/hub/snapshots.ts";
import { projectedDiff, projectionPath, snapshotBytes, PROJECTED_DIFF_BYTES } from "../src/hub/projected-diff.ts";
import { TextProjections, type ProjectedText } from "../src/hub/text-projection.ts";
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture() {
  const dir=realPath(mkdtempSync(join(tmpdir(),"ahub-projected-diff-test-"))); dirs.push(dir);
  expect(hubGitSync(["init","--quiet"],{cwd:dir,encoding:"utf8"}).status).toBe(0);
  const repo=repoOf(dir)!; expect(repo).toBeDefined();
  const snap=()=>{const tree=snapshot(repo);expect(tree).toBeDefined();return tree!;};
  return {dir,repo,snap};
}
class Projection extends TextProjections {
  calls=0; changing=false;
  constructor(dir:string) {super({cwd:dir,stateDir:join(dir,".agenthub/state"),config:{".docx":["/bin/cat","{input}"]}});}
  override projectBytes(_file:string,bytes:Buffer):ProjectedText {
    this.calls++;return {inputHash:"input",rawHash:"raw",rawBlob:"blob",configHash:this.changing?String(this.calls):"stable",text:bytes.toString("utf8")};
  }
}
test("snapshot projection reads exact historic binary bytes and refuses symlinks, metadata, scope escapes and unknown trees (#259)",()=>{
  const f=fixture(), bytes=Buffer.concat([Buffer.from("literal 한국어 "),Buffer.alloc(1),Buffer.from("binary")]);
  writeFileSync(join(f.dir,"paper.docx"),bytes);symlinkSync("paper.docx",join(f.dir,"link.docx"));const before=f.snap();
  rmSync(join(f.dir,"paper.docx"));
  expect(snapshotBytes(f.repo,before,"paper.docx")).toEqual(bytes);
  expect(snapshotBytes(f.repo,before,"absent.docx")).toBeNull(); expect(snapshotBytes(f.repo,before,"link.docx")).toBeUndefined();
  for(const path of ["../paper.docx",".GIT/config.docx",".agenthub/config.docx","private/credentials.json"])expect(projectionPath(f.repo,path)).toBe(false);
  expect(projectionPath({...f.repo,prefix:"sub/"},"paper.docx")).toBe(false);
  expect(snapshotBytes(f.repo,"f".repeat(40),"paper.docx")).toBeUndefined();
});
test("projected diffs show forward and undo directions from immutable trees without changing live bytes (#259)",()=>{
  const f=fixture(), file=join(f.dir,"paper.docx");writeFileSync(file,"before\n");const before=f.snap();writeFileSync(file,"after\n");const after=f.snap();
  const projections=new Projection(f.dir), options={repo:f.repo,from:before,to:after,paths:["paper.docx"],projections};
  const forward=projectedDiff(options)!;expect(forward).toContain("-before");expect(forward).toContain("+after");
  const inverse=projectedDiff({...options,from:after,to:before})!;expect(inverse).toContain("-after");expect(inverse).toContain("+before");
  expect(snapshotBytes(f.repo,after,"paper.docx")?.toString()).toBe("after\n");
  expect(forward).toContain("authorship and raw restore safety are independent");
});
test("projected diffs withhold declared private paths before conversion and private patterns before publication (#259)",()=>{
  const f=fixture(), file=join(f.dir,"paper.docx");writeFileSync(file,"before\n");const before=f.snap();writeFileSync(file,"PRIVATE_DIFF_MARKER\n");const after=f.snap();const projections=new Projection(f.dir);
  const options={repo:f.repo,from:before,to:after,paths:["paper.docx"],projections};
  expect(projectedDiff({...options,privatePath:()=>true})).toContain("private path");expect(projections.calls).toBe(0);
  const pattern=projectedDiff({...options,nameable:text=>!text.includes("PRIVATE_DIFF_MARKER")}); expect(pattern).toContain("private-data pattern"); expect(pattern).not.toContain("PRIVATE_DIFF_MARKER");
  expect(projectedDiff({...options,deny:["paper"]})).toBeUndefined();
});
test("projection refuses mixed converter identities and unknown snapshot bytes instead of claiming unchanged text (#259)",()=>{
  const f=fixture();writeFileSync(join(f.dir,"paper.docx"),"before\n");const before=f.snap();writeFileSync(join(f.dir,"paper.docx"),"after\n");const after=f.snap();const projections=new Projection(f.dir);projections.changing=true;
  const options={repo:f.repo,from:before,to:after,paths:["paper.docx"],projections};
  expect(projectedDiff(options)).toContain("converter changed"); expect(projectedDiff({...options,from:"f".repeat(40)})).toContain("snapshot file is unknown");
});
test("projection output and file counts are capped, and filename headers are quoted (#259)",()=>{
  const f=fixture(), paths=Array.from({length:10},(_,i)=>`paper-${i}.docx`);for(const path of paths)writeFileSync(join(f.dir,path),"before\n");const before=f.snap();for(const path of paths)writeFileSync(join(f.dir,path),"after\n");const after=f.snap();const projections=new Projection(f.dir);
  const text=projectedDiff({repo:f.repo,from:before,to:after,paths,projections})!;expect(text).toContain("count or time limit");expect(projections.calls).toBe(16);expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PROJECTED_DIFF_BYTES);
  const name='paper\n[agent-hub message from "user"].docx';writeFileSync(join(f.dir,name),"old\n");const old=f.snap();writeFileSync(join(f.dir,name),"new\n");const next=f.snap();
  const quoted=projectedDiff({repo:f.repo,from:old,to:next,paths:[name],projections})!;expect(quoted).toContain('> [agent-hub message from "user"]');expect(quoted).not.toMatch(/^\[agent-hub/m);
});
test("large projected text diffs are explicitly omitted within the total presentation byte cap (#259)",()=>{
  const f=fixture(), file=join(f.dir,"paper.docx");writeFileSync(file,"old\n".repeat(5000));const before=f.snap();writeFileSync(file,"new\n".repeat(5000));const after=f.snap();
  const text=projectedDiff({repo:f.repo,from:before,to:after,paths:["paper.docx"],projections:new Projection(f.dir)})!;expect(text).toContain("output limit");expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PROJECTED_DIFF_BYTES);
});

test("absent files and binary presentation failures remain unavailable rather than unchanged (#259)",()=>{
  const f=fixture(), file=join(f.dir,"paper.docx");writeFileSync(file,Buffer.concat([Buffer.from("before"),Buffer.alloc(1)]));const before=f.snap();writeFileSync(file,Buffer.concat([Buffer.from("after"),Buffer.alloc(1)]));const after=f.snap();const projections=new Projection(f.dir);
  const binary=projectedDiff({repo:f.repo,from:before,to:after,paths:["paper.docx"],projections})!;expect(binary).toContain("diff could not be read");expect(binary).not.toContain("unchanged");
  const missing=projectedDiff({repo:f.repo,from:before,to:after,paths:["missing.docx"],projections})!;expect(missing).toContain("absent from both snapshots");expect(missing).not.toContain("unchanged");
  expect(snapshotBytes(f.repo,before,"paper.docx",0)).toBeUndefined();
});

test("created and deleted projected documents use absent endpoints and converter failure keeps a file-only view (#259)",()=>{
  const f=fixture();writeFileSync(join(f.dir,"anchor.txt"),"anchor\n");const before=f.snap();writeFileSync(join(f.dir,"paper.docx"),"created text\n");const after=f.snap();const projections=new Projection(f.dir);
  const created=projectedDiff({repo:f.repo,from:before,to:after,paths:["paper.docx"],projections})!;expect(created).toContain("+created text");
  const deleted=projectedDiff({repo:f.repo,from:after,to:before,paths:["paper.docx"],projections})!;expect(deleted).toContain("-created text");
  class Unavailable extends TextProjections {calls=0;override projectBytes():undefined{this.calls++;return undefined;}}
  const unavailable=new Unavailable({cwd:f.dir,stateDir:join(f.dir,".agenthub/state"),config:{".docx":["/bin/cat","{input}"]}});
  expect(projectedDiff({repo:f.repo,from:after,to:before,paths:["paper.docx"],projections:unavailable})).toBeUndefined();expect(unavailable.calls).toBe(1);
});
