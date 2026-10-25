import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONDUCTOR_SETTING_KEYS, conductorOperation, operationalSetting, operationalRosterSetting } from "../src/hub/operational-authority.ts";
import { SETTINGS, settingRefusal } from "../src/hub/settings.ts";
import { authorizeConfigLeaf } from "../src/hub/config-apply.ts";
import { requireConductor } from "../src/hub/conductor.ts";
import { inspectSelectedOrphans, stopSelectedOrphan, exactOrphanCommand, type OrphanPorts } from "../src/hub/orphan-process.ts";
import { operationalView, redactBusEvent } from "../src/hub/operational-view.ts";
import { Board } from "../src/hub/board.ts";
import { Bus, type BusEvent } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { realPath } from "../src/hub/project.ts";
import { AcpPeer } from "../src/adapters/acp.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { readEvents } from "../src/hub/events.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";

const temp=()=>realPath(mkdtempSync(join(tmpdir(),"ahub-conductor-ops-")));
const CLI=join(import.meta.dir,"../src/cli/main.ts");

test("operational policy has exactly twelve existing live keys and rejects every person setting",()=>{
  expect(CONDUCTOR_SETTING_KEYS).toHaveLength(12);
  for(const key of CONDUCTOR_SETTING_KEYS) {
    const def=SETTINGS.find(d=>d.key===key)!;expect(def).toBeDefined();expect(operationalSetting(def)).toBe(true);expect(settingRefusal(def,true,"conductor")).toBeUndefined();
    expect(authorizeConfigLeaf({key,before:false,after:true,source:"config",sourceFile:"config.local.json",tracked:false,authority:"conductor",confirmed:true,guard:def}).allowed).toBe(true);
    expect(operationalSetting({...def,path:["permission_modes","codex"]})).toBe(false);
  }
  for(const def of SETTINGS.filter(d=>!CONDUCTOR_SETTING_KEYS.includes(d.key as never) && d.group!=="Roster"))expect(settingRefusal(def,null,"conductor")).toBeDefined();
  const roster=SETTINGS.find(d=>d.key==="roster.codex")!;expect(operationalRosterSetting(roster)).toBe(true);expect(operationalRosterSetting({...roster,applies:"restart"})).toBe(false);
  expect(authorizeConfigLeaf({key:"roles.codex",before:["conductor","implementer"],after:["implementer"],source:"config",tracked:false,authority:"conductor",confirmed:true}).allowed).toBe(false);
  for(const key of ["snapshots.keep","conductor.feed","pet.window","mlx.enabled","roles","tasks.wip_limits.codex"])expect(classifyPeerCommand("settings",["set",key,"true"])).toBe("console");
});

test("operational command classification preserves actor path and deferred person commands and live-test refusal",()=>{
  for(const [cmd,args] of [["roster",["add","kimi"]],["roster",["remove","kimi","--yes"]],["stop",["pi"]],["queue",["show","x"]],["queue",["resolve","x"]],["queue",["discard","--peer","codex"]],["task",["cancel","1"]],["doctor",["--orphans","--kill"]],["logs",[]],["export",[]],["settings",["set","task_sweep.enabled","true"]]] as [string,string[]][]) {
    expect(conductorOperation(cmd,args)).toBeDefined();expect(classifyPeerCommand(cmd,args)).toBe("conductor");expect(classifyPeerCommand(cmd,[...args,"--as-user"])).toBe("console");
  }
  for(const [cmd,args] of [["restart",["--yes"]],["recovery",["resume"]],["recovery",["abort"]],["task",["unassign","1"]],["models",["start"]],["models",["stop"]],["pet",["--window"]],["permission",["pi","never-ask"]]] as [string,string[]][])expect(classifyPeerCommand(cmd,args)).toBe("console");
  expect(liveTestRefusal("task",["cancel","1"])).toBe(true);expect(liveTestRefusal("permission",["pi","ask"])).toBe(false);
});

function orphanFixture() {
  let now=0,root:"missing"|"present"|"unknown"="missing",alive=true;
  const roles:Record<string,string[]>={codex:["conductor"]},signals:string[]=[];
  const selection={root:"/synthetic-gone-project",projectId:"project",instanceId:"instance",pid:10,executable:"bun",programs:["/package/src/cli/main.js"]};
  const registration={id:"project",root:selection.root,stateDir:"/synthetic-state",basePort:1234,instanceId:"instance",pid:20,pidSignature:"signed"};
  const ports:OrphanPorts={rootState:()=>root,liveness:(pid,signature)=>pid===20&&signature==="signed"&&alive?"live":"gone",command:()=>`bun /package/src/cli/main.js --project ${selection.root} daemon`,signal:(_pid,signal)=>{signals.push(signal);alive=false;},current:()=>requireConductor("codex",roles),now:()=>now,sleep:async ms=>{now+=ms;}};
  return {selection,registration,ports,roles,signals,setRoot:(value:typeof root)=>{root=value;}};
}

test("signed orphan policy requires selected project positive disappearance and recorded ownership",async()=>{
  const f=orphanFixture();const inspected=inspectSelectedOrphans(f.selection,f.registration,undefined,f.ports);expect(inspected.candidates).toHaveLength(1);
  expect(await stopSelectedOrphan(inspected.candidates[0]!,f.selection,f.ports)).toBe("stopped");expect(f.signals).toEqual(["SIGTERM"]);
  expect(exactOrphanCommand(`bun evil.js --project ${f.selection.root} daemon`,f.selection)).toBe(false);
  const impostor=orphanFixture();impostor.ports.command=()=>`bun evil.js --project ${impostor.selection.root} daemon`;expect(inspectSelectedOrphans(impostor.selection,impostor.registration,undefined,impostor.ports).candidates).toEqual([]);expect(impostor.signals).toEqual([]);
  const unsigned=orphanFixture();expect(inspectSelectedOrphans(unsigned.selection,{...unsigned.registration,pidSignature:null},undefined,unsigned.ports)).toMatchObject({state:"unknown",candidates:[]});
  expect(inspectSelectedOrphans(unsigned.selection,{...unsigned.registration,root:"/other-project"},undefined,unsigned.ports).candidates).toEqual([]);
  unsigned.setRoot("unknown");expect(inspectSelectedOrphans(unsigned.selection,unsigned.registration,undefined,unsigned.ports).candidates).toEqual([]);
  unsigned.setRoot("present");expect(inspectSelectedOrphans(unsigned.selection,unsigned.registration,undefined,unsigned.ports).state).toBe("not_orphan");
  expect(exactOrphanCommand("bun /package/src/cli/main.js --project /synthetic-gone-project2 daemon",f.selection)).toBe(false);expect(exactOrphanCommand("bun /package/src/cli/main.js --project /has space daemon",{...f.selection,root:"/has space"})).toBe(false);
});

test("signed orphan rechecks real conductor policy and identity before escalation and never signals self",async()=>{
  const f=orphanFixture();const [candidate]=inspectSelectedOrphans(f.selection,f.registration,undefined,f.ports).candidates;
  f.ports.signal=(_pid,signal)=>f.signals.push(signal);f.ports.sleep=async()=>{f.roles.codex=[];};
  await expect(stopSelectedOrphan(candidate!,f.selection,f.ports)).rejects.toThrow("conductor role");expect(f.signals).toEqual(["SIGTERM"]);
  const self=orphanFixture();self.selection.pid=20;const own=inspectSelectedOrphans(self.selection,self.registration,undefined,self.ports).candidates[0]!;expect(await stopSelectedOrphan(own,self.selection,self.ports)).toBe("self");expect(self.signals).toEqual([]);
});

test("public operational projection uses actual Tasks privacy and never emits private bodies paths or unsafe records",()=>{
  const root=temp(),board=new Board(join(root,"hub.db")),bus=new Bus({batchMs:0});
  try {
    const tasks=new Tasks({board,bus,cwd:root,project:"fixture",routing:()=>loadRouting(root),notify:()=>{}});
    const pub=board.propose("user",{title:"public fixture",class:"implement"});const priv=board.propose("user",{title:"PRIVATE_TITLE_CANARY",class:"implement",signals:["pii_path"],refs:{paths:["PRIVATE_PATH_CANARY"]}});
    const view=operationalView({tasks:board.list(),isPii:t=>tasks.isPii(t),publicView:t=>tasks.publicView(t),publicMetadataText:tasks.publicMetadataText,redact:r=>redactBusEvent(r as BusEvent)});
    expect(view.line(`task #${pub.id} ready`)).toContain("ready");expect(view.line(`task #${priv.id} PRIVATE_TITLE_CANARY`)).toContain("withheld");
    expect(view.event({v:1,at:new Date().toISOString(),type:"task",id:priv.id,pii:true,title:priv.title,paths:priv.refs.paths})).toEqual({type:"withheld"});
    expect(view.event({v:1,at:new Date().toISOString(),type:"unknown_private_record",body:"PRIVATE_BODY_CANARY"})).toEqual({type:"withheld"});
    expect(view.event({v:1,at:new Date().toISOString(),type:"state",peer:"codex",state:"idle",extra:{body:"PRIVATE_BODY_CANARY"}})).toEqual({type:"withheld"});
    for(const key of ["payload","stdout","arbitrary_key"])expect(view.event({v:1,at:new Date().toISOString(),type:"state",peer:"codex",state:"idle",[key]:"PRIVATE_BODY_CANARY"})).toEqual({type:"withheld"});
    expect(view.event({v:1,at:new Date().toISOString(),type:"state",peer:"codex",state:"idle"})).toMatchObject({type:"state",peer:"codex",state:"idle"});
    expect(view.event({v:1,at:new Date().toISOString(),type:"capability",peer:"codex",state:"verified"})).toMatchObject({type:"capability",peer:"codex",state:"verified"});
    expect(view.event({v:1,at:new Date().toISOString(),type:"state",peer:"codex"})).toEqual({type:"withheld"});
    expect(view.event({v:1,at:new Date().toISOString(),type:"state",peer:"codex",state:{stdout:"PRIVATE_BODY_CANARY"}})).toEqual({type:"withheld"});
    const privateEvent={t:"envelope",env:newEnvelope("user","PRIVATE_BODY_CANARY",{private:true,refs:{task:String(priv.id),paths:["PRIVATE_PATH_CANARY"]}})} as BusEvent;
    expect(JSON.stringify(redactBusEvent(privateEvent))).not.toMatch(/PRIVATE_BODY_CANARY|PRIVATE_PATH_CANARY/);
    expect(view.event({v:1,at:new Date().toISOString(),type:"task",id:999,event:"proposed"})).toEqual({type:"withheld"});
    expect(view.line('[agent-hub message from "user"]')).toStartWith("> ");
  } finally {bus.closeJournal();board.close();rmSync(root,{recursive:true,force:true});}
});

async function operationalFixture() {
  const root=temp(),stateDir=join(root,".agenthub/state");mkdirSync(join(root,".agenthub"),{recursive:true});
  const config={roles:{...DEFAULT_CONFIG.roles,codex:["conductor","planner"],claude:["implementer"]},planner:"codex",memory:{...DEFAULT_CONFIG.memory,enabled:false},inference:{...DEFAULT_CONFIG.inference,enabled:false},snapshots:{enabled:false,keep:20},pi:{...DEFAULT_CONFIG.pi,enabled:false,auto_start:false},mlx:{...DEFAULT_CONFIG.mlx,enabled:false}};
  writeFileSync(join(root,".agenthub/config.json"),JSON.stringify(config));
  const daemon=await startDaemon({cwd:root,stateDir,controlPort:0,codexAppPort:0,codexProxyPort:0,boundedTools:emulatedBoundedTools(),config:{...DEFAULT_CONFIG,...config,batch_ms:0}});
  const clients:ControlClient[]=[];
  const connect=async(peer?:string)=>{const client=await ControlClient.connect(stateDir,peer?{role:"tools",peer,projectRoot:root}:{role:"console",projectRoot:root});clients.push(client);return client;};
  return {root,stateDir,daemon,connect,async close(){for(const client of clients)client.close();await daemon.stop();rmSync(root,{recursive:true,force:true});}};
}
async function runOperationalCli(root:string,args:string[],peer="codex") {
  const wrapper=join(root,`cli-${crypto.randomUUID()}.ts`);
  const markers=["AGENTHUB_PEER_ID","CLAUDECODE","CLAUDE_CODE_SESSION_ID","CODEX_THREAD_ID","AGENTHUB_STATE_DIR","AGENTHUB_PROJECT_DIR","AGENTHUB_UNATTENDED","AGENTHUB_RECOVERY_OPERATION"];
  writeFileSync(wrapper,`for(const key of ${JSON.stringify(markers)})delete process.env[key];process.env.AGENTHUB_PEER_ID=${JSON.stringify(peer)};process.env.AGENTHUB_HOME=${JSON.stringify(join(root,"home"))};process.argv=[process.execPath,${JSON.stringify(CLI)},...${JSON.stringify(args)}];await import(${JSON.stringify(CLI)});`);
  const child=Bun.spawn([process.execPath,wrapper],{cwd:root,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const timer=setTimeout(()=>child.kill("SIGKILL"),5000);
  try {const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,stdout,stderr};}finally{clearTimeout(timer);rmSync(wrapper,{force:true});}
}

test("operational daemon RPC keeps tools actor, rejects non-conductors and person controls, and retains CLI audit",async()=>{
  const f=await operationalFixture();try {
    const lead=await f.connect("codex"),other=await f.connect("claude");
    const requests=[{t:"conductor_operational",op:"authorize",command:"roster add"},{t:"conductor_operational",op:"logs"},{t:"conductor_operational",op:"export"},{t:"conductor_operational",op:"orphans"},{t:"peer_stop",peer:"kimi"},{t:"queue",op:"show",id:"missing"},{t:"settings_preview",key:"snapshots.enabled",value:true},{t:"settings_set",key:"snapshots.enabled",value:false}];
    for(const request of requests) {const denied=await other.request(request);expect(denied.ok).toBe(false);expect(String(denied.error)).toMatch(/conductor|operational/);}
    for(const request of requests.filter(r=>r.t!=="queue" && r.t!=="peer_stop"))expect((await lead.request(request)).ok).toBe(true);
    for(const request of [{t:"settings_set",key:"permission_modes.codex",value:"never-ask"},{t:"settings_reload"},{t:"settings_undo"},{t:"kill"},{t:"recovery",op:"abort"},{t:"permission",peer:"codex",mode:"never-ask"}])expect((await lead.request(request)).ok).toBe(false);
    const audits=readEvents(join(f.stateDir,"events.jsonl")).filter(e=>e.type==="agent_cli" && e.peer==="codex" && !e.refused);
    expect(audits.some(e=>e.type==="agent_cli" && e.command==="logs")).toBe(true);expect(audits.some(e=>e.type==="agent_cli" && e.command==="settings set")).toBe(true);
    expect(readFileSync(join(f.stateDir,"hub.log"),"utf8")).toContain("conductor codex:");
  } finally {await f.close();}
},20000);

test("operational CLI roster settings queue logs export and doctor work as conductor and retain public projections",async()=>{
  const f=await operationalFixture();const board=new Board(join(f.stateDir,"hub.db"));try {
    const privateTask=board.propose("user",{title:"PRIVATE_TITLE_CANARY",class:"plan",signals:["pii_path"]});
    appendFileSync(join(f.stateDir,"hub.log"),`task #${privateTask.id} PRIVATE_TITLE_CANARY\npublic operational marker\n`);
    appendFileSync(join(f.stateDir,"events.jsonl"),JSON.stringify({v:1,at:new Date().toISOString(),type:"task",id:privateTask.id,event:"proposed",class:"plan",pii:true,title:"PRIVATE_TITLE_CANARY",body:"PRIVATE_BODY_CANARY"})+"\n");
    for(const args of [["roster","add","kimi"],["roster","remove","kimi","--yes"],["settings","set","task_sweep.enabled","false"],["doctor","--orphans","--kill","--json"],["logs"],["export"]]) {
      const result=await runOperationalCli(f.root,args);expect(result.code,result.stderr).toBe(0);expect(result.stdout).not.toMatch(/PRIVATE_TITLE_CANARY|PRIVATE_BODY_CANARY/);
      const refused=await runOperationalCli(f.root,args,"claude");expect(refused.code).toBe(1);expect(refused.stderr).toMatch(/conductor/);
    }
    const env=newEnvelope("user","PRIVATE_BODY_CANARY",{to:["codex"],private:true});f.daemon.bus.publish(env);
    const row=f.daemon.bus.queueList("codex").find(r=>r.originals.some(e=>e.id===env.id)) ?? f.daemon.bus.queueList("codex").find(r=>r.state==="queued")!;
    expect(row).toBeDefined();
    const shown=await runOperationalCli(f.root,["queue","show",row.id,"--json"]);expect(shown.code,shown.stderr).toBe(0);expect(shown.stdout).not.toContain("PRIVATE_BODY_CANARY");
    const resolved=await runOperationalCli(f.root,["queue","resolve",row.id,"--action","discard","--reason","fixture discard"]);expect(resolved.code,resolved.stderr).toBe(0);
    f.daemon.bus.publish(newEnvelope("user","ordinary queue body",{to:["codex"]}));
    const discarded=await runOperationalCli(f.root,["queue","discard","--peer","codex","--reason","fixture discard","--yes"]);expect(discarded.code,discarded.stderr).toBe(0);
  } finally {board.close();await f.close();}
},20000);

test("operational CLI stop uses owned adapter lifecycle and task cancel preserves peer instead of person",async()=>{
  const f=await operationalFixture(),board=new Board(join(f.stateDir,"hub.db"));const peer=new AcpPeer("kimi",{cmd:[process.execPath,join(import.meta.dir,"fakes/acp-server.ts")],cwd:f.root,watchdogMs:1000});
  try {
    await peer.start();f.daemon.bus.add(peer);
    const denied=await runOperationalCli(f.root,["stop","kimi"],"claude");expect(denied.code).toBe(1);expect(peer.state).not.toBe("offline");
    const stopped=await runOperationalCli(f.root,["stop","kimi"]);expect(stopped.code,stopped.stderr).toBe(0);expect(peer.state).toBe("offline");
    const task=board.propose("codex",{title:"synthetic unaccepted backlog",class:"plan",backlog:true});
    const cancelled=await runOperationalCli(f.root,["task","cancel",String(task.id),"--reason","fixture cancellation"]);expect(cancelled.code,cancelled.stderr).toBe(0);expect(board.get(task.id)!.history.findLast(h=>h.event==="cancelled")?.by).toBe("codex");
    for(const args of [["task","unassign",String(task.id)],["models","start"],["models","stop"],["restart","--yes"],["recovery","resume"],["settings","set","permission_modes.codex","never-ask"]]){const result=await runOperationalCli(f.root,args);expect(result.code).toBe(1);expect(result.stderr).toContain("the person");}
  } finally {await peer.stop();board.close();await f.close();}
},20000);

test("operational daemon audit failure refuses a settings effect before any write",async()=>{
  const f=await operationalFixture();try {
    const lead=await f.connect("codex"),events=join(f.stateDir,"events.jsonl"),before=readFileSync(join(f.root,".agenthub/config.json"),"utf8");
    // Appending to a directory fails without touching the caller's project or any account configuration.
    rmSync(events,{force:true});mkdirSync(events);
    const result=await lead.request({t:"settings_set",key:"snapshots.enabled",value:true});expect(result.ok).toBe(false);expect(result.error).toContain("audit");
    expect(readFileSync(join(f.root,".agenthub/config.json"),"utf8")).toBe(before);expect(()=>readFileSync(join(f.root,".agenthub/config.local.json"))).toThrow();
    rmSync(events,{recursive:true,force:true});
  } finally {await f.close();}
},20000);

test("committed roster write is acknowledged after awaited role revocation and later role or membership operations refuse",async()=>{
  const f=await operationalFixture();const peer=new AcpPeer("kimi",{cmd:[process.execPath,join(import.meta.dir,"fakes/acp-server.ts")],cwd:f.root,watchdogMs:1000});
  let release!:()=>void;const paused=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const stopping=new Promise<void>(resolve=>{entered=resolve;});
  const originalStop=peer.stop.bind(peer);let pending:Promise<any>|undefined;
  try {
    await peer.start();f.daemon.bus.add(peer);
    const lead=await f.connect("codex"),person=await f.connect();
    const self=await lead.request({t:"settings_set",key:"roster.codex",value:false,confirm:"codex"});expect(self.ok).toBe(false);expect(self.error).toContain("holds the conductor role");
    peer.stop=async reason=>{entered();await paused;return originalStop(reason);};
    pending=lead.request({t:"settings_set",key:"roster.kimi",value:false,confirm:"kimi"},10000);pending.catch(()=>{});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([stopping,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("owned stop barrier not reached")),3000);})]);}finally{clearTimeout(timer);}
    const local=join(f.root,".agenthub/config.local.json"),saved=JSON.parse(readFileSync(local,"utf8"));expect(saved.roster.kimi).toBe(false);
    writeFileSync(local,JSON.stringify({...saved,roles:{...DEFAULT_CONFIG.roles,codex:["planner"],claude:["conductor"]}}));
    let reloaded=await person.request({t:"settings_reload"});if(reloaded.confirmation)reloaded=await person.request({t:"settings_reload",confirm:reloaded.confirmation.token});expect(reloaded.ok).toBe(true);
    release();const result=await pending;expect(result).toMatchObject({ok:true,saved:true,authorityEnded:true});
    expect((await lead.request({t:"settings_set",key:"snapshots.enabled",value:true})).ok).toBe(false);
    expect((await person.request({t:"settings_set",key:"roster.codex",value:false,confirm:"codex"})).ok).toBe(true);
    const offRoster=await lead.request({t:"conductor_operational",op:"logs"});expect(offRoster.ok).toBe(false);expect(offRoster.error).toContain("off roster");
  } finally {release();await pending?.catch(()=>{});peer.stop=originalStop;await peer.stop();await f.close();}
},20000);
