import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { changedPaths, hasTree, initShadow, planUndo, repoGitArgs, repoGitEnv, repoOf, restore, snapshot } from "../src/hub/snapshots.ts";
import { snapshotBytes } from "../src/hub/projected-diff.ts";
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function root(){const dir=realPath(mkdtempSync(join(tmpdir(),"ahub-shadow-")));dirs.push(dir);return dir;}
test("shadow snapshots and raw undo work without creating .git or modifying the shadow HEAD/index (#259)",()=>{
  const dir=root();writeFileSync(join(dir,"paper.txt"),"before\n");expect(repoOf(dir)).toBeUndefined();expect(initShadow(dir)).toBe(true);expect(initShadow(dir)).toBe(false);
  const repo=repoOf(dir)!;expect(repo.shadow).toBe(true);expect(existsSync(join(dir,".git"))).toBe(false);
  const head=readFileSync(join(repo.dir,"HEAD")), hadIndex=existsSync(join(repo.dir,"index"));const before=snapshot(repo)!;expect(before).toBeDefined();expect(hasTree(repo,before)).toBe(true);
  writeFileSync(join(dir,"paper.txt"),"after\n");const after=snapshot(repo)!;expect(changedPaths(repo,before,after)).toEqual(["paper.txt"]);expect(snapshotBytes(repo,before,"paper.txt")?.toString()).toBe("before\n");
  const plan=planUndo(repo,{start_tree:before,end_tree:after,changed:["paper.txt"]});expect(plan.restore).toEqual(["paper.txt"]);restore(repo,before,plan.restore);expect(readFileSync(join(dir,"paper.txt"),"utf8")).toBe("before\n");
  expect(readFileSync(join(repo.dir,"HEAD"))).toEqual(head);expect(existsSync(join(repo.dir,"index"))).toBe(hadIndex);expect(existsSync(join(dir,".git"))).toBe(false);
});
test("shadow ignore policy excludes raw data and mandatory metadata even with user ignore negations (#259)",()=>{
  const dir=root();expect(initShadow(dir)).toBe(true);mkdirSync(join(dir,"large"));writeFileSync(join(dir,"large","raw.csv"),"raw-data");writeFileSync(join(dir,"paper.txt"),"paper");writeFileSync(join(dir,".agenthub/ignore"),"large/\n");writeFileSync(join(dir,".gitignore"),"!.agenthub/shadow.git/\n!.agenthub/shadow.git/**\n");
  const repo=repoOf(dir)!, tree=snapshot(repo)!;expect(tree).toBeDefined();const listing=hubGitSync(repoGitArgs(repo,["ls-tree","-r","--name-only",tree]),{encoding:"utf8",env:repoGitEnv(repo)});expect(listing.status).toBe(0);expect(listing.stdout).toContain("paper.txt");expect(listing.stdout).not.toContain("large/raw.csv");expect(listing.stdout).not.toContain("shadow.git");
});
test("shadow opt-in refuses an existing real Git project and preserves its repository selection (#259)",()=>{
  const dir=root();expect(hubGitSync(["init","--quiet"],{cwd:dir,encoding:"utf8"}).status).toBe(0);const before=repoOf(dir)!;expect(()=>initShadow(dir)).toThrow("already has a Git");expect(repoOf(dir)).toEqual(before);expect(existsSync(join(dir,".agenthub/shadow.git"))).toBe(false);
});
test("linked or shared shadow metadata is refused without following a different repository (#259)",()=>{
  const dir=root(), outside=root();expect(initShadow(outside)).toBe(true);mkdirSync(join(dir,".agenthub"));symlinkSync(join(outside,".agenthub/shadow.git"),join(dir,".agenthub/shadow.git"));expect(repoOf(dir)).toBeUndefined();expect(()=>initShadow(dir)).toThrow("invalid");
  rmSync(join(dir,".agenthub/shadow.git"));expect(initShadow(dir)).toBe(true);const repo=repoOf(dir)!;renameSync(join(repo.dir,"objects"),join(repo.dir,"saved-objects"));symlinkSync(join(outside,".agenthub/shadow.git/objects"),join(repo.dir,"objects"));expect(repoOf(dir)).toBeUndefined();
});
