import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONDUCTOR_SETTING_KEYS, OperationalAuthorityError, operationalRequestLabel, conductorOperation, operationalSetting, operationalRosterSetting } from "../src/hub/operational-authority.ts";
import { SETTINGS, settingRefusal } from "../src/hub/settings.ts";
import { authorizeConfigLeaf } from "../src/hub/config-apply.ts";
import { requireConductor } from "../src/hub/conductor.ts";
import { inspectSelectedOrphans, stopSelectedOrphan, exactOrphanCommand, type OrphanPorts } from "../src/hub/orphan-process.ts";
import { operationalView, redactBusEvent } from "../src/hub/operational-view.ts";
import { Board } from "../src/hub/board.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Bus, type BusEvent } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting, routingText } from "../src/hub/routing.ts";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { AcpPeer } from "../src/adapters/acp.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { drainCliAudits } from "../src/cli/identity-audit.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { readEvents } from "../src/hub/events.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";

const temp=()=>realPath(mkdtempSync(join(tmpdir(),"ahub-conductor-ops-")));
const CLI=join(import.meta.dir,"../src/cli/main.ts");

test("operational policy has exactly thirteen existing live keys and rejects every person setting",()=>{
  expect(CONDUCTOR_SETTING_KEYS).toHaveLength(13); // #933 added tasks.escalate_after
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
  for(const [cmd,args] of [["roster",["add","kimi"]],["roster",["remove","kimi","--yes"]],["stop",["pi"]],["queue",["show","x"]],["queue",["resolve","x"]],["queue",["discard","--peer","codex"]],["doctor",["--orphans","--kill"]],["logs",[]],["export",[]],["settings",["set","task_sweep.enabled","true"]]] as [string,string[]][]) {
    expect(conductorOperation(cmd,args)).toBeDefined();expect(classifyPeerCommand(cmd,args)).toBe("conductor");expect(classifyPeerCommand(cmd,[...args,"--as-user"])).toBe("console");
  }
  for(const [cmd,args] of [["restart",["--yes"]],["upgrade",["--yes","--to","0.18.1"]],["recovery",["resume"]],["recovery",["abort"]],["task",["unassign","1"]]] as [string,string[]][])expect(classifyPeerCommand(cmd,args)).toBe("conductor");
  for(const [cmd,args] of [["recovery-run",["op-1"]],["models",["start"]],["models",["stop"]],["pet",["--window"]],["permission",["pi","never-ask"]]] as [string,string[]][])expect(classifyPeerCommand(cmd,args)).toBe("console");
  expect(classifyPeerCommand("task",["cancel","1"])).toBe("allowed"); // #933: own task only, refused by Tasks.cancel otherwise
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

async function operationalFixture(piiPaths?:string[],options:{git?:boolean;deny?:string[]}={}) {
  const root=temp(),stateDir=join(root,".agenthub/state");mkdirSync(join(root,".agenthub"),{recursive:true});
  if(options.git){
    expect(hubGitSync(["init","-q"],{cwd:root,encoding:"utf8",timeout:1000}).status).toBe(0);
    writeFileSync(join(root,".agenthub/routing.toml"),routingText(root).replaceAll('pi_backend = "mlx"','pi_backend = "dgx"'));
  }
  const config={...(options.deny?{local:{...DEFAULT_CONFIG.local,deny:options.deny}}:{}),roles:{...DEFAULT_CONFIG.roles,codex:["conductor","planner"],claude:["implementer"]},planner:"codex",memory:{...DEFAULT_CONFIG.memory,enabled:false},inference:{...DEFAULT_CONFIG.inference,enabled:false},snapshots:{enabled:false,keep:20},pi:{...DEFAULT_CONFIG.pi,enabled:false,auto_start:false},mlx:{...DEFAULT_CONFIG.mlx,enabled:false},...(piiPaths?{pii:{paths:piiPaths}}:{})};
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
      const refused=await runOperationalCli(f.root,args,"claude");expect(refused.code).toBe(1);expect(refused.stderr).toMatch(/conductor/);expect(refused.stderr).toContain("console");
    }
    const recipient=new class extends BasePeer {async start(){} async stop(){} async deliver(){throw new Error("offline fixture must never deliver");}}("codex");
    f.daemon.bus.add(recipient);
    const env=newEnvelope("user","PRIVATE_BODY_CANARY",{to:["codex"],private:true});f.daemon.bus.publish(env);
    const row=f.daemon.bus.queueList("codex").find(r=>r.originals.some(e=>e.id===env.id))!;
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
    for(const args of [["models","start"],["models","stop"],["settings","set","permission_modes.codex","never-ask"]]){const result=await runOperationalCli(f.root,args);expect(result.code).toBe(1);expect(result.stderr).toContain("the person");}
    for(const args of [["task","unassign",String(task.id)],["restart","--yes"],["upgrade","--yes","--to","0.18.1"],["recovery","resume"],["recovery","abort"]]){const result=await runOperationalCli(f.root,args,"claude");expect(result.code).toBe(1);expect(result.stderr).toContain("conductor");}
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


test("non-conductor roster CLI refusal retains console guidance and requires the configured conductor",async()=>{
  const f=await operationalFixture();try {
    const result=await runOperationalCli(f.root,["roster","add","kimi"],"claude");
    expect(result.code).toBe(1);expect(result.stderr).toContain("conductor");expect(result.stderr).toContain("console");expect(f.daemon.bus.isRostered("kimi")).toBe(true);
  } finally {await f.close();}
},20000);

test("conductor roster RPC passes its live initiating authority into the awaited Tasks handoff",async()=>{
  const f=await operationalFixture(),board=new Board(join(f.stateDir,"hub.db"));
  const original=Tasks.prototype.reassignForRoster;
  let entered!:()=>void,release!:()=>void,captured:(()=>void)|undefined;
  const paused=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  let pending:Promise<any>|undefined;
  Tasks.prototype.reassignForRoster=async function(this:Tasks,peer,current){captured=current;entered();await paused;return original.call(this,peer,current);};
  try {
    const one=board.propose("user",{title:"first handoff remains",class:"implement"}),two=board.propose("user",{title:"second handoff remains",class:"implement"});
    board.update(one.id,"kimi","accepted",{owner:"kimi",reviewer:"claude",state:"in_progress"});board.update(two.id,"kimi","accepted",{owner:"kimi",reviewer:"claude",state:"in_progress"});
    const before=[board.get(one.id),board.get(two.id)];const lead=await f.connect("codex"),person=await f.connect();
    pending=lead.request({t:"settings_set",key:"roster.kimi",value:false,confirm:"kimi"},5000);pending.catch(()=>{});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([waiting,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("task handoff barrier not reached")),2000);})]);}finally{clearTimeout(timer);}
    expect(typeof captured).toBe("function");
    const file=join(f.root,".agenthub/config.local.json"),saved=JSON.parse(readFileSync(file,"utf8"));expect(saved.roster.kimi).toBe(false);
    writeFileSync(file,JSON.stringify({...saved,roles:{...DEFAULT_CONFIG.roles,codex:["planner"],claude:["conductor"]}}));
    let reload=await person.request({t:"settings_reload"});if(reload.confirmation)reload=await person.request({t:"settings_reload",confirm:reload.confirmation.token});expect(reload.ok).toBe(true);
    expect(()=>captured!()).toThrow("conductor");release();
    expect(await pending).toMatchObject({ok:true,saved:true,authorityEnded:true});
    expect([board.get(one.id),board.get(two.id)]).toEqual(before);
    expect(f.daemon.bus.queueList().flatMap(row=>row.originals).some(env=>env.kind==="task" && [String(one.id),String(two.id)].includes(env.refs?.task??""))).toBe(false);
  } finally {release();await pending?.catch(()=>{});Tasks.prototype.reassignForRoster=original;board.close();await f.close();}
},20000);


test("role-declined operational CLI records only refused audit and retains exact person guidance",async()=>{
  const f=await operationalFixture();try {
    const result=await runOperationalCli(f.root,["roster","add","kimi"],"claude");
    expect(result.code).toBe(1);expect(result.stderr).toContain("the person runs it in ahub console or a terminal");
    const events=readEvents(join(f.stateDir,"events.jsonl")).filter(e=>e.type==="agent_cli" && e.peer==="claude" && e.command==="roster add");
    const queued=drainCliAudits(f.stateDir).filter(e=>e.peer==="claude" && e.command==="roster add");
    expect(events.filter(e=>e.type==="agent_cli" && !e.refused)).toHaveLength(0);expect(queued.some(e=>e.outcome==="run")).toBe(false);
    expect(events.filter(e=>e.type==="agent_cli" && e.refused).length+queued.filter(e=>e.outcome==="refused").length).toBe(1);
    expect(readFileSync(join(f.stateDir,"hub.log"),"utf8")).not.toContain("claude ran ahub roster add");
  } finally {await f.close();}
},3000);

test("later operational parser refusal retains refused audit after accepted pre-effect authorization",async()=>{
  const f=await operationalFixture();try {
    const result=await runOperationalCli(f.root,["settings","set","research.enabled","true","--unknown"]);expect(result.code).toBe(1);
    const events=readEvents(join(f.stateDir,"events.jsonl")).filter(e=>e.type==="agent_cli" && e.peer==="codex" && e.command==="settings set");
    const queued=drainCliAudits(f.stateDir).filter(e=>e.peer==="codex" && e.command==="settings set");
    expect(events.some(e=>e.type==="agent_cli" && e.refused)||queued.some(e=>e.outcome==="refused")).toBe(true);expect(queued.some(e=>e.outcome==="run")).toBe(false);
    expect(()=>readFileSync(join(f.root,".agenthub/config.local.json"))).toThrow();
  } finally {await f.close();}
},3000);

test("conductor setting and roster writes name the actual peer and preserve the person's undo bytes and stale-digest refusal",async()=>{
  const f=await operationalFixture();try {
    const person=await f.connect(),lead=await f.connect("codex");
    expect((await person.request({t:"settings_set",key:"approvals.notify",value:false})).ok).toBe(true);
    const undo=join(f.stateDir,"settings-undo.json"),before=readFileSync(undo);
    expect((await lead.request({t:"settings_set",key:"research.enabled",value:true})).ok).toBe(true);expect(readFileSync(undo)).toEqual(before);
    expect((await lead.request({t:"settings_set",key:"roster.kimi",value:false,confirm:"kimi"})).ok).toBe(true);expect(readFileSync(undo)).toEqual(before);
    const changed=readEvents(join(f.stateDir,"events.jsonl")).filter(e=>e.type==="settings" && ["research.enabled","roster.kimi"].includes(e.key));
    expect(changed).toHaveLength(2);expect(changed.every(e=>e.type==="settings" && e.source==="conductor" && e.peer==="codex")).toBe(true);
    expect(readFileSync(join(f.stateDir,"hub.log"),"utf8")).toContain("(conductor codex)");
    const refused=await person.request({t:"settings_undo"});expect(refused.ok).toBe(false);expect(refused.error).toContain("changed since");expect(readFileSync(undo)).toEqual(before);
    expect(JSON.parse(readFileSync(join(f.root,".agenthub/config.local.json"),"utf8")).research.enabled).toBe(true);
  } finally {await f.close();}
},3000);

test("bare operational op refuses before admission and complete privacy inventory works beyond 500 tasks",async()=>{
  const f=await operationalFixture();const board=new Board(join(f.stateDir,"hub.db"));try {
    const lead=await f.connect("codex"),before=readEvents(join(f.stateDir,"events.jsonl")).length;
    const refused=await lead.request({t:"conductor_operational",op:"queue show"});expect(refused.ok).toBe(false);
    expect(readEvents(join(f.stateDir,"events.jsonl")).slice(before).some(e=>e.type==="agent_cli" && !e.refused)).toBe(false);
    for(let i=0;i<501;i++)board.propose("user",{title:`metadata row ${i}`,class:"plan"});
    appendFileSync(join(f.stateDir,"hub.log"),"PUBLIC_501_TASK_MARKER\n");
    const shown=await lead.request({t:"conductor_operational",op:"logs"});expect(shown.ok).toBe(true);expect(shown.complete).toBe(true);expect(shown.lines).toContain("PUBLIC_501_TASK_MARKER");
  } finally {board.close();await f.close();}
},3000);

for(const mode of ["missing","stale","silent"] as const)test(`operational ${mode} control refuses promptly and keeps a refused audit`,async()=>{
  const root=temp(),stateDir=join(root,".agenthub/state");mkdirSync(stateDir,{recursive:true});writeFileSync(join(root,".agenthub/config.json"),"{}");
  let server:ReturnType<typeof Bun.serve>|undefined;
  try {
    if(mode!=="missing") {
      server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:(req,server)=>server.upgrade(req,{data:undefined})?undefined:new Response("no"),websocket:{message(sock,message){const request=JSON.parse(String(message));if(mode==="silent" && request.t==="hello")sock.send(JSON.stringify({rid:request.rid,t:"welcome",projectId:"fixture",instanceId:"fixture",cwd:root,protocol:PROTOCOL,features:[]}));}}});
      writeFileSync(join(stateDir,"control-token"),"fixture-token");writeFileSync(join(stateDir,"status.json"),JSON.stringify({cwd:root,controlPort:server.port,protocol:PROTOCOL,projectId:"fixture",instanceId:"fixture",pid:mode==="stale"?99999999:process.pid,pidSignature:mode==="stale"?"synthetic-stale":processSignature(process.pid)}));
    }
    const started=Date.now(),result=await runOperationalCli(root,["logs"]);expect(result.code).toBe(1);expect(result.stderr).toContain("the person runs it in ahub console or a terminal");expect(result.stderr).toContain("conductor authorization unavailable");expect(result.stderr).not.toContain("requires the explicit conductor role");expect(Date.now()-started).toBeLessThan(mode==="silent"?4500:2500);
    const audits=drainCliAudits(stateDir);expect(audits.filter(e=>e.command==="logs")).toHaveLength(1);expect(audits.every(e=>e.outcome==="refused")).toBe(true);
  } finally {server?.stop(true);rmSync(root,{recursive:true,force:true});}
},5000);


test("conductor setting reason uses actual private-path and secret metadata policy without changing person undo",async()=>{
  const f=await operationalFixture(["private"]);try {
    mkdirSync(join(f.root,"private"));writeFileSync(join(f.root,"private/notes.md"),"fixture private content");
    const person=await f.connect(),lead=await f.connect("codex");expect((await person.request({t:"settings_set",key:"approvals.notify",value:false})).ok).toBe(true);
    const local=join(f.root,".agenthub/config.local.json"),undo=join(f.stateDir,"settings-undo.json"),before=readFileSync(local),receipt=readFileSync(undo);
    for(const reason of ["private/notes.md","token: abcdefgh12345"]) {
      const result=await lead.request({t:"settings_set",key:"research.enabled",value:true,reason});expect(result.ok).toBe(false);expect(result.error).toContain("reason withheld");expect(result.error).not.toContain(reason);
      expect(readFileSync(local)).toEqual(before);expect(readFileSync(undo)).toEqual(receipt);expect(readFileSync(join(f.stateDir,"events.jsonl"),"utf8")).not.toContain(reason);
    }
    expect((await lead.request({t:"settings_set",key:"research.enabled",value:true,reason:"public operational reason"})).ok).toBe(true);
    expect(readFileSync(undo)).toEqual(receipt);const event=readEvents(join(f.stateDir,"events.jsonl")).findLast(e=>e.type==="settings" && e.key==="research.enabled");expect(event).toMatchObject({source:"conductor",peer:"codex",reason:"public operational reason"});
  } finally {await f.close();}
},3000);


test("operational authority marker is explicit and ordinary conductor domain errors retain their reason",async()=>{
  expect(new OperationalAuthorityError("fence")).toBeInstanceOf(Error);expect(new OperationalAuthorityError("fence").code).toBe("AHUB_OPERATIONAL_AUTHORITY");
  expect(operationalRequestLabel({t:"conductor_operational",op:"queue show"})).toBe("unknown");
  const f=await operationalFixture();try{
    const lead=await f.connect("codex"),other=await f.connect("claude");
    const missing=await lead.request({t:"queue",op:"show",id:"missing"});expect(missing).toMatchObject({ok:false,error:"delivery not found",authorityRefused:false});expect(missing).not.toHaveProperty("refusalAudited");
    const stopped=await lead.request({t:"peer_stop",peer:"kimi"});expect(stopped.ok).toBe(false);expect(stopped.authorityRefused).toBe(false);expect(stopped.error).not.toContain("explicit conductor role");expect(stopped.error).not.toContain("the person runs");
    const denied=await other.request({t:"queue",op:"show",id:"missing"});expect(denied).toMatchObject({ok:false,authorityRefused:true,refusalAudited:true});expect(String(denied.error).split("the person runs it in ahub console or a terminal")).toHaveLength(2);
    const protectedSetting=await lead.request({t:"settings_set",key:"permission_modes.codex",value:"never-ask"});expect(protectedSetting).toMatchObject({ok:false,authorityRefused:true,authorityScope:"person",refusalAudited:true});expect(protectedSetting.error).toContain("this setting is reserved for the person");expect(protectedSetting.error).toContain("the person runs it in ahub console or a terminal");expect(protectedSetting.error).not.toContain("explicit conductor role");
    const scopeAudit=readEvents(join(f.stateDir,"events.jsonl")).filter(row=>row.type==="agent_cli" && row.peer==="codex" && row.command==="settings set" && row.refused);expect(scopeAudit).toHaveLength(1);
  }finally{await f.close();}
});

test("settings preview queue inspection and authorization read create no admission event or conduct notice",async()=>{
  const f=await operationalFixture();try{
    const lead=await f.connect("codex"),file=join(f.stateDir,"events.jsonl"),before=readEvents(file).length,log=readFileSync(join(f.stateDir,"hub.log"),"utf8");
    expect((await lead.request({t:"conductor_operational",op:"authorize",command:"settings set"})).ok).toBe(true);
    expect((await lead.request({t:"settings_preview",key:"snapshots.enabled",value:true})).ok).toBe(true);
    expect((await lead.request({t:"queue",op:"show",id:"missing"})).error).toBe("delivery not found");
    const reads=readEvents(file).slice(before);expect(reads.some(row=>row.type==="agent_cli" || row.type==="conduct")).toBe(false);expect(readFileSync(join(f.stateDir,"hub.log"),"utf8")).toBe(log);
    expect((await lead.request({t:"settings_set",key:"snapshots.enabled",value:true})).ok).toBe(true);
    expect(readEvents(file).slice(before).some(row=>row.type==="agent_cli" && row.command==="settings set" && !row.refused)).toBe(true);
  }finally{await f.close();}
});

test("operational inventory classifies once and explicitly names incomplete privacy coverage",()=>{
  const root=temp(),board=new Board(join(root,"hub.db")),bus=new Bus({batchMs:0});try{
    const tasks=new Tasks({board,bus,cwd:root,project:"fixture",routing:()=>loadRouting(root),notify:()=>{}}),task=board.propose("user",{title:"ordinary",class:"plan"});let projections=0;
    const ports={tasks:board.list(),isPii:tasks.isPii,publicView:(row:typeof task)=>{projections++;return tasks.publicView(row);},publicMetadataText:tasks.publicMetadataText,redact:(row:unknown)=>redactBusEvent(row as BusEvent)};
    const view=operationalView(ports);for(let n=0;n<10;n++)expect(view.line(`task #${task.id} ordinary`)).toContain("ordinary");expect(projections).toBe(1);
    const missing=operationalView({...ports,publicView:()=>{throw new Error("unavailable projection");}});expect(missing.complete).toBe(false);expect(missing.incompleteReason).toBe("privacy inventory unavailable");expect(missing.line("ordinary")).toContain("withheld");
  }finally{bus.closeJournal();board.close();rmSync(root,{recursive:true,force:true});}
});

test("daemon operational cache invalidates on task privacy and live PII routing reload while paths stay restart-bound",async()=>{
  const deniedPath="custom-deny/file.txt",f=await operationalFixture(undefined,{git:true,deny:[deniedPath]}),board=new Board(join(f.stateDir,"hub.db")),original=Tasks.prototype.publicView;let projections=0;
  Tasks.prototype.publicView=function(...args){projections++;return original.apply(this,args);};
  try{
    const lead=await f.connect("codex"),person=await f.connect(),file=join(f.stateDir,"hub.log"),path="new-private/file.txt",title="CACHE_TASK_TITLE";
    const task=board.propose("user",{title,class:"plan"}),pathTask=board.propose("user",{title:"INNOCUOUS_PATH_TASK_TITLE",class:"plan",refs:{paths:[path]}}),deniedTask=board.propose("user",{title:"DENIED_REF_TASK_TITLE",class:"plan",refs:{paths:[deniedPath]}});appendFileSync(file,`task #${task.id} ${title}\ntask #${pathTask.id} INNOCUOUS_PATH_TASK_TITLE\ntask #${deniedTask.id} DENIED_REF_TASK_TITLE\n${path}\n${deniedPath}\n`);
    const first=await lead.request({t:"conductor_operational",op:"logs"});expect(first.lines.some((line:string)=>line.includes(title))).toBe(true);expect(first.lines).toContain(path);expect(first.lines).not.toContain(deniedPath);expect(first.lines.some((line:string)=>line.includes("DENIED_REF_TASK_TITLE"))).toBe(false);
    expect(first.lines.some((line:string)=>line.includes("INNOCUOUS_PATH_TASK_TITLE"))).toBe(true);const before=projections;await lead.request({t:"conductor_operational",op:"logs"});expect(projections).toBe(before);
    board.update(task.id,"user","fixture privacy",{signals:["pii_path"]});
    const privateTask=await lead.request({t:"conductor_operational",op:"logs"});expect(privateTask.lines.some((line:string)=>line.includes(title))).toBe(false);expect(privateTask.lines).toContain(path);
    const configFile=join(f.root,".agenthub/config.local.json");writeFileSync(configFile,JSON.stringify({pii:{paths:[path]}}));
    let reloaded=await person.request({t:"settings_reload"});if(reloaded.confirmation!==undefined)reloaded=await person.request({t:"settings_reload",confirm:reloaded.confirmation.token});expect(reloaded.ok).toBe(true);expect(reloaded.rejected).toEqual([]);expect(reloaded.pendingRestart.some((row:{key:string})=>row.key==="pii" || row.key==="pii.paths")).toBe(true);
    const retained=await lead.request({t:"conductor_operational",op:"logs"});expect(retained.lines).toContain(path);expect(retained.lines.some((line:string)=>line.includes("INNOCUOUS_PATH_TASK_TITLE"))).toBe(true);
    // pii.paths retains native startup bounds. Exercise the live routing policy instead of forcing a restart key into effect.
    const patterns=[...loadRouting(f.root).signals.pii_patterns,"new-private/file[.]txt|INNOCUOUS_PATH_TASK_TITLE"];
    writeFileSync(join(f.root,".agenthub/routing.toml"),routingText(f.root).replace(/^pii_patterns\s*=.*$/m,`pii_patterns = ${JSON.stringify(patterns)}`));
    let routingReload=await person.request({t:"settings_reload"});if(routingReload.confirmation!==undefined)routingReload=await person.request({t:"settings_reload",confirm:routingReload.confirmation.token});expect(routingReload.ok,String(routingReload.error)).toBe(true);
    const privatePath=await lead.request({t:"conductor_operational",op:"logs"});expect(privatePath.lines).not.toContain(path);expect(privatePath.lines.some((line:string)=>line.includes(title))).toBe(false);expect(privatePath.lines.some((line:string)=>line.includes("INNOCUOUS_PATH_TASK_TITLE"))).toBe(false);expect(projections).toBeGreaterThan(before);
  }finally{Tasks.prototype.publicView=original;board.close();await f.close();}
});
