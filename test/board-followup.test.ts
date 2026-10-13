import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {supportsBoardReleaseFilter} from "../src/cli/board-read.ts";
import {renderBoardColumns,boardColumnModel} from "../src/cli/output.ts";
import {Board} from "../src/hub/board.ts";
import {Bus} from "../src/hub/bus.ts";
import {Tasks} from "../src/hub/tasks.ts";
import {USER} from "../src/hub/envelope.ts";
import {loadRouting} from "../src/hub/routing.ts";
test("filtered board columns preserve visible row state from the first snapshot",()=>{
 const row={id:1,state:"proposed",title:"visible",class:"implement",signals:[],deps:[],created:1,updated:1,owner:null,reviewer:null,refs:{},plan:{},started:false};
 const model=boardColumnModel([row],{},[{...row,state:"in_progress",owner:"codex"}]);
 expect(model.columns.find(column=>column.id==="todo")!.ready.map(card=>card.id)).toEqual([1]);expect(model.columns.find(column=>column.id==="progress")!.ready).toEqual([]);
});
test("filtered board columns reject missing dependency context instead of inventing waiting",()=>{
 const row={id:2,state:"proposed",title:"visible",class:"implement",signals:[],deps:[1]};
 expect(()=>boardColumnModel([row],{},null)).toThrow("dependency context unavailable");
});
test("terminal board columns retain state mapping and dependency waiting (#263)",()=>{
 const tasks=[{id:1,state:"backlog",title:"future",class:"implement",signals:[]},{id:2,state:"proposed",title:"waiting",class:"implement",deps:[1],signals:[]},{id:3,state:"in_progress",title:"active",class:"implement",signals:[]},{id:4,state:"in_review",title:"review",class:"implement",signals:[]},{id:5,state:"approved",title:"done",class:"implement",signals:[]}];
 const complete=tasks.map(task=>({...task,created:1,updated:1,owner:null,reviewer:null,refs:{},plan:{}}));
 const text=renderBoardColumns(complete,{}).map(line=>line.map(span=>span.text).join("")).join("\n");
 for(const label of ["Backlog","To Do","In Progress","Review / QA","Done","Waiting","dependencies not approved"])expect(text).toContain(label);
 const filtered=renderBoardColumns([complete[1]!],{},undefined,Date.now(),false,complete).map(line=>line.map(span=>span.text).join("")).join("\n");expect(filtered).toContain("waiting");expect(filtered).not.toContain("future");
});
test("release cut flags use structured approval and preserve missing cut evidence (#263)",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ahub-board-cut-")),board=new Board(":memory:"),bus=new Bus({batchMs:0}),tasks=new Tasks({board,bus,cwd:root,project:"cut",routing:()=>loadRouting(root),notify:()=>{}});
 try{
  const release=await tasks.newRelease(USER,{name:"phase",goal:"safe",order:0});expect(tasks.releaseList(USER)[0]?.afterCut).toBeNull();
  tasks.changeRelease(USER,{id:release.id,revision:0,cut:1});
  const approved=board.propose(USER,{title:"outside",class:"implement"});board.update(approved.id,USER,"accepted",{state:"in_progress",owner:"codex"});board.update(approved.id,USER,"done",{state:"approved"});
  const unknown=board.propose(USER,{title:"unknown",class:"implement"});board.update(unknown.id,USER,"assigned",{state:"in_progress"});board.update(unknown.id,USER,"legacy completion",{state:"approved"});
  expect(tasks.releaseList(USER)[0]?.afterCut).toEqual([approved.id]);expect(tasks.releaseList(USER)[0]?.afterCutUnknown).toEqual([unknown.id]);
 }finally{bus.closeJournal();board.close();rmSync(root,{recursive:true,force:true});}
});


test("release filtering requires an explicit compatible daemon capability (#263)",()=>{
 expect(supportsBoardReleaseFilter({peers:{},protocol:16})).toBe(false);expect(supportsBoardReleaseFilter({boardReadCapabilities:{releaseFilter:false}})).toBe(false);expect(supportsBoardReleaseFilter({boardReadCapabilities:{releaseFilter:"true"}})).toBe(false);expect(supportsBoardReleaseFilter({boardReadCapabilities:{releaseFilter:true}})).toBe(true);
});
