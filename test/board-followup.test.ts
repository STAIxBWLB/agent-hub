import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {supportsBoardReleaseFilter} from "../src/cli/board-read.ts";
import {renderBoard,renderBoardColumns,boardColumnModel} from "../src/cli/output.ts";
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


test("filtered terminal stages retain the visible snapshot alongside column placement",()=>{
 const row={id:1,state:"proposed",title:"visible",class:"implement",signals:[],deps:[],created:1,updated:1,owner:null,reviewer:null,refs:{},plan:{},started:false};
 const first=renderBoardColumns([row],{},120,5000,false,[row]);const later=renderBoardColumns([row],{},120,5000,false,[{...row,state:"approved",owner:"codex",reviewer:"claude"}]);
 expect(later).toEqual(first);
});


test("filtered plain board stages preserve visible rows from the first read",()=>{
 const row={id:1,state:"proposed",title:"visible",class:"implement",signals:[],deps:[],created:1,updated:1,owner:null,reviewer:null,refs:{},plan:{}};
 expect(renderBoard([row],120,5000,false,[{...row,state:"approved"}])).toEqual(renderBoard([row],120,5000,false,[row]));
});
test("column stages preserve cross-column prerequisite state from the first read",()=>{
 const before=[{id:1,state:"approved",title:"prerequisite",class:"implement",signals:[],created:1,updated:1,owner:null,reviewer:null,refs:{},plan:{}},{id:2,state:"proposed",title:"dependent",class:"implement",signals:[],deps:[1],created:1,updated:1,owner:null,reviewer:null,refs:{},plan:{}}];
 expect(renderBoardColumns(before,{},120,5000,false,[{...before[0]!,state:"backlog"},before[1]!])).toEqual(renderBoardColumns(before,{},120,5000,false,before));
});

test("release without a cut reports every outside approval as unknown",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ahub-board-cut-unset-")),board=new Board(":memory:"),bus=new Bus({batchMs:0}),tasks=new Tasks({board,bus,cwd:root,project:"cut",routing:()=>loadRouting(root),notify:()=>{}});
 try{await tasks.newRelease(USER,{name:"phase",goal:"safe",order:0});const ids:number[]=[];for(const event of ["done","legacy completion"]){const row=board.propose(USER,{title:event,class:"implement"});board.update(row.id,USER,"accepted",{state:"in_progress",owner:"codex"});board.update(row.id,USER,event,{state:"approved"});ids.push(row.id)}board.propose(USER,{title:"unfinished",class:"implement"});expect(tasks.releaseList(USER)[0]?.afterCut).toBeNull();expect(tasks.releaseList(USER)[0]?.afterCutUnknown).toEqual(ids);
 }finally{bus.closeJournal();board.close();rmSync(root,{recursive:true,force:true})}
});


test("release audit snapshots bound previews and scan each task history once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-release-audit-")), board = new Board(":memory:"), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ board, bus, cwd: root, project: "audit", routing: () => loadRouting(root), notify: () => {} });
  try {
    const releases: { id: number }[] = [];
    for (let i = 0; i < 16; i++) releases.push(await tasks.newRelease(USER, { name: "release-" + i, goal: "safe", order: i }));
    tasks.changeRelease(USER, { id: releases[0]!.id, revision: 0, cut: 1 });
    tasks.changeRelease(USER, { id: releases[1]!.id, revision: 0, cut: 2 });
    const own: number[] = [];
    for (let i = 0; i < 96; i++) {
      const row = board.propose(USER, { title: "audit work", class: "implement" });
      if (i < 8) { board.plan(row.id, USER, { release: releases[0]!.id }, 0); own.push(row.id); }
      board.update(row.id, USER, "accepted", { state: "in_progress", owner: "codex" });
      board.update(row.id, USER, i % 4 === 0 ? "legacy completion" : "done", { state: "approved" });
    }
    const rows = board.list(); let reads = 0;
    for (const row of rows) {
      const history = row.history.map(entry => entry.event === "done" ? { ...entry, at: 2 } : entry);
      Object.defineProperty(row, "history", { get: () => { reads++; return history; } });
    }
    board.list = () => rows;
    const result = tasks.releaseList(USER);
    const first = result.find(row => row.id === releases[0]!.id)!;
    expect(first.afterCutCount).toBe(66); expect(first.afterCutUnknownCount).toBe(22);
    expect(first.afterCut).toHaveLength(32); expect(first.afterCutUnknown).toHaveLength(22);
    expect((first.afterCut as number[]).some(id => own.includes(id))).toBe(false);
    expect(first.tasks).toHaveLength(8);
    expect(result.find(row => row.id === releases[1]!.id)?.afterCut).toEqual([]);
    const unset = result.find(row => row.id === releases[2]!.id)!;
    expect(unset.afterCut).toBeNull(); expect(unset.afterCutUnknownCount).toBe(96); expect(unset.afterCutUnknown).toHaveLength(32);
    expect(reads).toBeLessThanOrEqual(rows.length * 6);
    expect(result.every(row => (row.afterCutUnknown as number[]).length <= 32 && (row.afterCut === null || (row.afterCut as number[]).length <= 32))).toBe(true);
  } finally { bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); }
});
