import { afterEach,expect,spyOn,test } from "bun:test";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Board} from "../src/hub/board.ts";
import {Bus} from "../src/hub/bus.ts";
import {Tasks, type TasksDeps} from "../src/hub/tasks.ts";
import {BasePeer} from "../src/hub/peers.ts";
import {USER} from "../src/hub/envelope.ts";
import {loadRouting} from "../src/hub/routing.ts";
import {classifyPeerCommand} from "../src/cli/identity.ts";
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function rig(extra: Partial<TasksDeps> = {}){const dir=mkdtempSync(join(tmpdir(),"ahub-gh-import-")),file=join(dir,"hub.db"),board=new Board(file),bus=new Bus({batchMs:0}),routing=loadRouting(dir);const screen={run:()=>{}};const tasks=new Tasks({board,bus,cwd:dir,project:"import",routing:()=>routing,notify:()=>{},piiScreen:async()=>{screen.run();return {label:"clear",ms:0};},...extra});cleanup.push(()=>{bus.closeJournal();board.close();rmSync(dir,{recursive:true,force:true});});return {dir,file,board,bus,tasks,routing,screen};}
const issue=(number:number,title="public issue")=>({number,title,body:"details",url:`https://github.com/owner/repo/issues/${number}`,state:"OPEN"});
test("GitHub intake screens canonical source identity before exposing external URLs",async()=>{
 const f=rig();f.routing.signals.pii_screen="local";const seen:string[]=[];
 const tasks=new Tasks({board:f.board,bus:f.bus,cwd:f.dir,project:"import",routing:()=>f.routing,notify:()=>{},piiScreen:async text=>{seen.push(text);return text.includes("sensitive-owner")?{label:"pii",category:"name",ms:0}:{label:"clear",ms:0}}});
 const result=await tasks.importGitHub(USER,{repo:"sensitive-owner/repo",label:"ready"},async()=>({code:0,stdout:JSON.stringify([{...issue(1),url:"https://github.com/sensitive-owner/repo/issues/1"}])}));
 expect(result.imported).toHaveLength(1);expect(seen.some(text=>text.includes("https://github.com/sensitive-owner/repo/issues/1"))).toBe(true);
 const task=f.board.get(result.imported[0]!)!;expect(tasks.isPii(task)).toBe(true);expect(JSON.stringify(tasks.publicView(task))).not.toContain("sensitive-owner");
});
test("GitHub intake persists dedupe and PII sources only through public projection (#263)",async()=>{
 const {file,board,tasks}=rig(),page=[issue(1),issue(2,"patient 900101-1234567")],run=async()=>({code:0,stdout:JSON.stringify(page)});
 await expect(tasks.importGitHub("claude",{repo:"owner/repo",label:"ready"},run)).rejects.toThrow("person console");
 const first=await tasks.importGitHub(USER,{repo:"owner/repo",label:"ready"},run);expect(first).toMatchObject({imported:[1,2],existing:[],partial:false,complete:true});
 expect(board.list().every(task=>task.state==="backlog"&&task.owner===null)).toBe(true);expect(tasks.publicView(board.get(1)!).external).toMatchObject({provider:"github",repo:"owner/repo",issue:1});
 expect(tasks.publicView(board.get(2)!)).not.toHaveProperty("external");expect(JSON.stringify(tasks.publicView(board.get(2)!))).not.toContain("900101");
 const repeated=await tasks.importGitHub(USER,{repo:"OWNER/REPO",label:"ready"},run);expect(repeated).toMatchObject({imported:[],existing:[1,2]});
 const reopened=new Board(file);try{expect(reopened.imported("OWNER/REPO",1)?.id).toBe(1);}finally{reopened.close();}
 expect(classifyPeerCommand("board",["import","github","--label","ready"])).toBe("console");
});
test("GitHub import rechecks persistent identity after asynchronous screening (#263)",async()=>{
 const {board,tasks,routing,screen}=rig();routing.signals.pii_screen="local";let injected=false;
 screen.run=()=>{if(!injected){injected=true;board.propose(USER,{title:"already staged",class:"implement",backlog:true,external:{provider:"github",repo:"owner/repo",issue:1,url:"https://github.com/owner/repo/issues/1"}});}};
 const result=await tasks.importGitHub(USER,{repo:"owner/repo",label:"ready"},async()=>({code:0,stdout:JSON.stringify([issue(1)])}));
 expect(result).toMatchObject({imported:[],existing:[1],complete:true});expect(board.list()).toHaveLength(1);
});
test("GitHub import returns confirmed partial progress instead of claiming failed staging completed (#263)",async()=>{
 const {board,tasks}=rig();const propose=board.propose.bind(board);let count=0;board.propose=(...args)=>{if(++count===2)throw new Error("storage unavailable");return propose(...args);};
 const result=await tasks.importGitHub(USER,{repo:"owner/repo",label:"ready"},async()=>({code:0,stdout:JSON.stringify([issue(1),issue(2)])}));
 expect(result).toMatchObject({imported:[1],existing:[],partial:true,complete:false,unconfirmed:true});expect(board.list()).toHaveLength(1);
});

test("GitHub external identity remains screened on a later unknown verdict retry",async()=>{
 const f=rig();f.routing.signals.pii_screen="local";let first=true;const seen:string[]=[];
 const tasks=new Tasks({board:f.board,bus:f.bus,cwd:f.dir,project:"import",routing:()=>f.routing,notify:()=>{},piiScreen:async text=>{seen.push(text);if(first){first=false;return {label:"unknown",miss:"failed",ms:0}}return text.includes("sensitive-owner")?{label:"pii",category:"name",ms:0}:{label:"clear",ms:0}}});
 const result=await tasks.importGitHub(USER,{repo:"sensitive-owner/repo",label:"ready"},async()=>({code:0,stdout:JSON.stringify([{...issue(1),url:"https://github.com/sensitive-owner/repo/issues/1"}])}));
 await tasks.moveBacklog(USER,result.imported[0]!,true);await tasks.rescreen();
 expect(seen).toHaveLength(2);expect(seen[1]).toContain("sensitive-owner");const task=f.board.get(result.imported[0]!)!;expect(tasks.isPii(task)).toBe(true);expect(tasks.publicView(task)).not.toHaveProperty("external");
});


test("GitHub intake reports confirmed partial progress after late final staging", async () => {
  const f = rig();
  const clock = spyOn(performance, "now").mockReturnValue(0);
  cleanup.push(() => clock.mockRestore());
  f.routing.signals.pii_screen = "local";
  f.screen.run = () => { clock.mockReturnValue(20_000); };
  const result = await f.tasks.importGitHub(USER, { repo: "owner/repo", label: "ready" }, async () => ({ code: 0, stdout: JSON.stringify([{ number: 1, title: "last issue", body: "work", url: "https://github.com/owner/repo/issues/1", state: "OPEN" }]) }));
  expect(result).toEqual({ imported: [1], existing: [], partial: true, complete: false });
  expect(f.board.list()).toHaveLength(1);
  expect(f.board.get(1)?.title).toBe("last issue");
});


test("GitHub intake retains committed identity after later bookkeeping failure", async () => {
  for (const readable of [true, false]) {
    const f = rig();
    f.routing.signals.pii_screen = "local";
    const update = f.board.update.bind(f.board);
    f.board.update = (...args) => {
      if (args[2] === "screened") {
        if (!readable) f.board.imported = () => { throw new Error("readback unavailable"); };
        throw new Error("bookkeeping unavailable");
      }
      return update(...args);
    };
    const result = await f.tasks.importGitHub(USER, { repo: "owner/repo", label: "ready" }, async () => ({ code: 0, stdout: JSON.stringify([issue(1)]) }));
    expect(result).toEqual(readable ? { imported: [1], existing: [], partial: true, complete: false } : { imported: [], existing: [], partial: true, complete: false, unconfirmed: true });
    expect(f.board.list()).toHaveLength(1);
    expect(f.board.get(1)?.external?.issue).toBe(1);
  }
});


test("GitHub confirmed recovery retains the planner backlog notice", async () => {
  class Planner extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver() {} }
  const f = rig({ roles: { claude: ["planner"] } });
  const planner = new Planner("claude"); f.bus.add(planner); await planner.start();
  expect(f.tasks.flushPlannerNotices()).toBe(0);
  f.routing.signals.pii_screen = "local";
  const update = f.board.update.bind(f.board);
  f.board.update = (...args) => { if (args[2] === "screened") throw new Error("bookkeeping unavailable"); return update(...args); };
  const result = await f.tasks.importGitHub(USER, { repo: "owner/repo", label: "ready" }, async () => ({ code: 0, stdout: JSON.stringify([issue(1)]) }));
  expect(result.imported).toEqual([1]);
  expect(f.tasks.flushPlannerNotices()).toBe(1);
  expect(f.tasks.flushPlannerNotices()).toBe(0);
});


test("GitHub intake retains progress when a later identity lookup fails", async () => {
  const f = rig(), lookup = f.board.imported.bind(f.board);
  f.board.imported = (repo, number) => { if (number === 2) throw new Error("identity lookup unavailable"); return lookup(repo, number); };
  const result = await f.tasks.importGitHub(USER, { repo: "owner/repo", label: "ready" }, async () => ({ code: 0, stdout: JSON.stringify([issue(1), issue(2)]) })).catch(() => null);
  expect(result).not.toBeNull();
  expect(result).toEqual({ imported: [1], existing: [], partial: true, complete: false, unconfirmed: true });
  expect(f.board.list()).toHaveLength(1);
});
