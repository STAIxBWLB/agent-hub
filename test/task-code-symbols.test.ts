import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import type { ReviewBrief } from "../src/hub/review-brief.ts";
import { HOST_CODE_SYMBOLS, buildTaskCodeSymbols, parseTaskCodeSymbols, publicTaskCodeSymbols, taskCodeSymbolsDisjoint, type TaskCodeSymbols } from "../src/hub/task-code-symbols.ts";
const HEAD="a".repeat(40),BASE="b".repeat(40),OTHER="c".repeat(40),REPO="repo:fixture";
const accept=()=>true;
function brief(name="A.run"):ReviewBrief {
  return {head:HEAD,base:"origin/main",mergeBase:BASE,reviewable:[{path:"a.ts",status:"M"}],excluded:[],withheld:0,rules:[],rulesMissing:[],ruleGroups:[],unlisted:[],symbols:{state:"known",complete:true,planned:[],unplanned:[],unseen:[],files:[{path:"a.ts",symbols:[{name,kind:"fn",path:"a.ts",line:1,ambiguous:false,change:"unknown"}]}]}};
}
const receipt=(name="A.run")=>buildTaskCodeSymbols(brief(name),REPO,accept)!;
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});

test("task symbol builder stores only canonical metadata and explicit observed completeness",()=>{
  expect(receipt()).toEqual({head:HEAD,mergeBase:BASE,repositoryKey:REPO,state:"known",complete:true,countsFloor:true,symbols:[{id:"symbol:A.run@a.ts",path:"a.ts",name:"A.run",kind:"fn"}]});
  expect(JSON.stringify(receipt())).not.toMatch(/line|change|planned/);
  const absent=brief();delete absent.symbols!.complete;
  expect(buildTaskCodeSymbols(absent,REPO,accept)?.complete).toBe(false);
  expect(buildTaskCodeSymbols(brief(),REPO,accept,true)).toBeUndefined();
  expect(buildTaskCodeSymbols(undefined,REPO,accept)).toBeUndefined();
  const unknown=brief();unknown.symbols!.state="unknown";
  expect(buildTaskCodeSymbols(unknown,REPO,accept)).toMatchObject({state:"unknown",complete:false,symbols:[]});
});

test("filtering, ambiguity, withheld files and collisions prevent disjoint eligibility",()=>{
  const hidden=buildTaskCodeSymbols(brief(),REPO,text=>text!=="A.run")!;
  expect(hidden).toMatchObject({state:"known",complete:false,symbols:[]});
  const ambiguous=brief();ambiguous.symbols!.files[0]!.symbols[0]!.ambiguous=true;
  expect(buildTaskCodeSymbols(ambiguous,REPO,accept)?.complete).toBe(false);
  const withheld=brief();withheld.withheld=1;
  expect(buildTaskCodeSymbols(withheld,REPO,accept)?.complete).toBe(false);
  const duplicate=brief();duplicate.symbols!.files[0]!.symbols.push({...duplicate.symbols!.files[0]!.symbols[0]!});
  expect(buildTaskCodeSymbols(duplicate,REPO,accept)?.complete).toBe(false);
  expect(taskCodeSymbolsDisjoint(receipt("A.run"),receipt("B.run"),HEAD,HEAD,REPO,["a.ts"])).toBe(true);
  expect(taskCodeSymbolsDisjoint(receipt("run"),receipt("A.run"),HEAD,HEAD,REPO,["a.ts"])).toBe(false);
  expect(taskCodeSymbolsDisjoint(receipt("A.run"),receipt("run"),HEAD,HEAD,REPO,["a.ts"])).toBe(false);
});

test("symbol parser refuses malformed or oversized receipts and strips spans and foreign fields",()=>{
  const raw={...receipt(),source:"SECRET",symbols:receipt().symbols.map(s=>({...s,line:1,endLine:9,source:"SECRET"}))};
  expect(parseTaskCodeSymbols(raw)).toEqual(receipt());
  for(const bad of [{...receipt(),head:"short"},{...receipt(),complete:"yes"},{...receipt(),state:{toString:()=>"known"}},{...receipt(),symbols:[{...receipt().symbols[0],id:"forged"}]},{...receipt(),symbols:[{...receipt().symbols[0],path:"../outside"}]},{...receipt(),state:"unknown"},{...receipt(),symbols:Array(501).fill(receipt().symbols[0])},{...receipt(),repositoryKey:"x".repeat(513)}])expect(parseTaskCodeSymbols(bad)).toBeUndefined();
  const large=brief();large.symbols!.files[0]!.symbols=Array.from({length:501},(_,i)=>({...large.symbols!.files[0]!.symbols[0]!,name:`s${i}`}));
  expect(buildTaskCodeSymbols(large,REPO,accept)).toMatchObject({state:"unknown",complete:false,symbols:[]});
  expect(buildTaskCodeSymbols(large,REPO,()=>false)).toMatchObject({state:"unknown",complete:false,symbols:[]});
  const bytes={...receipt(),symbols:Array.from({length:500},(_,i)=>({id:`symbol:${"x".repeat(200)}${i}@a.ts`,name:`${"x".repeat(200)}${i}`,path:"a.ts",kind:"fn"}))};
  expect(parseTaskCodeSymbols(bytes)).toBeUndefined();
});

test("public reads re-screen every field and never expose internal repository place keys",()=>{
  const projected=publicTaskCodeSymbols(receipt(),HEAD,REPO,accept)!;
  expect(projected.symbols).toHaveLength(1);expect(projected).not.toHaveProperty("repositoryKey");
  expect(publicTaskCodeSymbols(receipt(),OTHER,REPO,accept)).toBeUndefined();
  expect(publicTaskCodeSymbols(receipt(),HEAD,"other",accept)).toBeUndefined();
  expect(publicTaskCodeSymbols(receipt(),HEAD,REPO,accept,true)).toBeUndefined();
  expect(publicTaskCodeSymbols(receipt(),HEAD,REPO,text=>text!=="A.run")).toMatchObject({complete:false,symbols:[]});
  expect(publicTaskCodeSymbols(receipt(),HEAD,REPO,()=>{throw Error();})).toMatchObject({complete:false,symbols:[]});
});

test("disjointness requires current public complete observations and non-empty sets on every exact shared path",()=>{
  const left=receipt("A.first"),right=receipt("B.second");
  expect(taskCodeSymbolsDisjoint(left,right,HEAD,HEAD,REPO,["a.ts"])).toBe(true);
  const cases: Parameters<typeof taskCodeSymbolsDisjoint>[] = [[undefined,right,HEAD,HEAD,REPO,["a.ts"]],[left,right,OTHER,HEAD,REPO,["a.ts"]],[left,right,HEAD,HEAD,"other",["a.ts"]],[left,right,HEAD,HEAD,REPO,[]],[left,right,HEAD,HEAD,REPO,["a.ts","b.ts"]],[{...left,complete:false},right,HEAD,HEAD,REPO,["a.ts"]],[{...left,symbols:[]},right,HEAD,HEAD,REPO,["a.ts"]]];
  for (const args of cases) expect(taskCodeSymbolsDisjoint(...args)).toBe(false);
  expect(taskCodeSymbolsDisjoint(left,right,HEAD,HEAD,REPO,["a.ts"],true)).toBe(false);
  expect(taskCodeSymbolsDisjoint(left,right,HEAD,HEAD,REPO,["a.ts"],false,text=>text!=="A.first")).toBe(false);
  expect(taskCodeSymbolsDisjoint(left,right,HEAD,HEAD,REPO,["a.ts"],false,accept)).toBe(true);
});

function storage(){
  const root=mkdtempSync(join(tmpdir(),"ahub-task-symbols-")),file=join(root,"hub.db");let board=new Board(file);
  cleanups.push(()=>{board.close();rmSync(root,{recursive:true,force:true});});
  const task=board.propose("codex",{title:"symbols",class:"implement",refs:{repo:"o/r",commit:HEAD}});
  const patch=(value:TaskCodeSymbols|undefined)=>board.update(task.id,"codex","done",{codeSymbols:value},undefined,{},undefined,HOST_CODE_SYMBOLS);
  return {file,get board(){return board;},task,patch,reopen(){board.close();board=new Board(file);},corrupt(value:string){const db=new Database(file);try{db.query("INSERT INTO task_code_symbols(task,payload) VALUES(?,?) ON CONFLICT(task) DO UPDATE SET payload=excluded.payload").run(task.id,value);}finally{db.close();}}};
}

test("Board roundtrips host-only observations across restart without adding a separate history entry",()=>{
  const f=storage(),before=f.board.get(f.task.id)!.history.length,revision=f.board.statusRevision();
  expect(()=>f.board.update(f.task.id,"codex","done",{codeSymbols:receipt()})).toThrow("host authority");
  expect(f.board.get(f.task.id)!.history).toHaveLength(before);
  const saved=f.patch(receipt());expect(saved.codeSymbols).toEqual(receipt());expect(saved.history).toHaveLength(before+1);
  expect(f.board.statusRevision()).toBe(revision+1);
  f.reopen();expect(f.board.get(f.task.id)!.codeSymbols).toEqual(receipt());
  f.patch(undefined);expect(f.board.get(f.task.id)!.codeSymbols).toBeUndefined();
});

test("Board rejects malformed, mismatched-head and private observations before writing",()=>{
  const f=storage(),before=f.board.get(f.task.id)!.history.length;
  expect(()=>f.patch({...receipt(),head:OTHER})).toThrow("head or privacy");
  expect(()=>f.patch({...receipt(),symbols:[{id:"bad",name:"bad",path:"a.ts",kind:"fn"}]})).toThrow("invalid task");
  expect(f.board.get(f.task.id)!.history).toHaveLength(before);
  f.board.update(f.task.id,"user","screened",{signals:["pii_path"]});
  expect(()=>f.patch(receipt())).toThrow("head or privacy");
  expect(f.board.get(f.task.id)!.codeSymbols).toBeUndefined();
});

test("Board drops old evidence on effective head, repository and PII changes",()=>{
  for(const patch of [{refs:{commit:OTHER}},{refs:{repo:"other/repo"}},{refs:{paths:["/another/repo/a.ts"]}},{signals:["pii"]},{signals:["pii_path"]}]){
    const f=storage();f.patch(receipt());f.board.update(f.task.id,"user","changed",patch);
    expect(f.board.get(f.task.id)!.codeSymbols).toBeUndefined();
  }
});


test("Board retains keyed unknowns and refuses corrupt optional readback without breaking the task",()=>{
  const f=storage();
  const unknown:TaskCodeSymbols={...receipt(),state:"unknown",complete:false,symbols:[]};
  f.patch(unknown);f.reopen();expect(f.board.get(f.task.id)!.codeSymbols).toEqual(unknown);
  for(const raw of ["not-json",JSON.stringify({...receipt(),head:OTHER}),JSON.stringify({...receipt(),symbols:[{...receipt().symbols[0],id:"bad"}]})," ".repeat(64*1024+1)]){
    f.corrupt(raw);expect(f.board.get(f.task.id)!.codeSymbols).toBeUndefined();
    expect(f.board.get(f.task.id)!.title).toBe("symbols");
  }
});


test("builder refuses non-reviewable and duplicate file rows instead of certifying inventory",()=>{
  const foreign=brief();foreign.symbols!.files[0]!.path="outside.ts";
  foreign.symbols!.files[0]!.symbols[0]!.path="outside.ts";
  expect(buildTaskCodeSymbols(foreign,REPO,accept)).toMatchObject({state:"unknown",complete:false,symbols:[]});
  const duplicate=brief();duplicate.symbols!.files.push({...duplicate.symbols!.files[0]!,symbols:[]});
  expect(buildTaskCodeSymbols(duplicate,REPO,accept)).toMatchObject({state:"unknown",complete:false,symbols:[]});
});


test("legacy task SELECT cannot expose separate symbol payload and new reads retain it",()=>{
  const f=storage();f.patch(receipt());
  const db=new Database(f.file);try{
    const legacy=db.query("SELECT * FROM tasks WHERE id=?").get(f.task.id);
    expect(legacy).not.toHaveProperty("code_symbols");
    expect(JSON.stringify(legacy)).not.toContain(REPO);
    expect(JSON.stringify(legacy)).not.toContain("symbol:A.run@a.ts");
  }finally{db.close();}
  expect(f.board.get(f.task.id)!.codeSymbols).toEqual(receipt());
  expect(f.board.list()[0]!.codeSymbols).toEqual(receipt());
});

test("symbol storage failure rolls back task history and status revision atomically",()=>{
  const f=storage(),before=f.board.get(f.task.id)!,revision=f.board.statusRevision();
  const db=new Database(f.file);try{
    db.run("CREATE TRIGGER refuse_symbol BEFORE INSERT ON task_code_symbols BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END");
  }finally{db.close();}
  expect(()=>f.patch(receipt())).toThrow("fixture refusal");
  expect(f.board.get(f.task.id)).toEqual(before);
  expect(f.board.statusRevision()).toBe(revision);
});

test("external issue lookup uses the bounded metadata projection",()=>{
  const f=storage();
  const task=f.board.propose("codex",{title:"imported symbols",class:"implement",refs:{repo:"o/r",commit:HEAD},external:{provider:"github",repo:"o/r",issue:684,url:"https://github.com/o/r/issues/684"}});
  f.board.update(task.id,"codex","done",{codeSymbols:receipt()},undefined,{},undefined,HOST_CODE_SYMBOLS);
  expect(f.board.imported("O/R",684)!.codeSymbols).toEqual(receipt());
});


test("startup discards observations of tasks made private by an older writer",()=>{
  const f=storage();f.patch(receipt());
  const db=new Database(f.file);try{db.query("UPDATE tasks SET signals=? WHERE id=?").run('["pii"]',f.task.id);}finally{db.close();}
  f.reopen();expect(f.board.get(f.task.id)!.codeSymbols).toBeUndefined();
  const check=new Database(f.file);try{expect(check.query("SELECT COUNT(*) AS n FROM task_code_symbols WHERE task=?").get(f.task.id)).toEqual({n:0});}finally{check.close();}
});
