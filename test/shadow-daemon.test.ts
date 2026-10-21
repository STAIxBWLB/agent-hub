import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { init } from "../src/cli/init.ts";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Turns } from "../src/hub/snapshots.ts";
const cleanup:(()=>unknown)[]=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
class Peer extends BasePeer {async start(){this.setState("idle");}async stop(){this.setState("offline");}async deliver(){}turn(){this.setState("busy");this.setState("idle");}}
async function fixture(shadow:boolean){
  const dir=realPath(mkdtempSync(join(tmpdir(),"ahub-shadow-daemon-")));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));init(dir,"research",shadow);writeFileSync(join(dir,"paper.txt"),"paper\n");
  const routing=join(dir,".agenthub/routing.toml");writeFileSync(routing,readFileSync(routing,"utf8").replace(/^pi_backend = "mlx"$/gm,'pi_backend = "dgx"'));
  const config=loadConfig(dir);config.memory.enabled=false;config.inference.enabled=false;config.mlx.enabled=false;config.coordination="turn-free";
  const state=join(dir,".agenthub/state"),daemon=await startDaemon({cwd:dir,stateDir:state,config,controlPort:0,codexAppPort:0,codexProxyPort:0,snapshotClock:()=>0/* #661: held, so a slow runner cannot spend the shared snapshot budget (#576) */});cleanup.push(()=>daemon.stop());
  const peer=new Peer("codex");daemon.bus.add(peer);await peer.start();const client=await ControlClient.connect(state,{role:"tools",peer:"codex"});cleanup.push(()=>client.close());return{dir,state,daemon,peer,client};
}
test("non-dev projects without Git/shadow disable facts and snapshots with one notice (#259)",async()=>{
  const f=await fixture(false);const reply=await f.client.request({t:"facts",phase:"pre",sessionId:"test",tool:"Read",input:{file_path:join(f.dir,"paper.txt")}});expect(reply.ok).toBe(true);expect(reply.text).toBeUndefined();expect(reply.id).toBeUndefined();
  f.peer.turn();const log=readFileSync(join(f.state,"hub.log"),"utf8");expect(log.match(/project has no Git or shadow repository/g)).toHaveLength(1);expect(log).toContain("facts, snapshots and undo are off");
  const turns=new Turns(join(f.state,"hub.db"),true);try{expect(()=>turns.list()).toThrow("no such table");}finally{turns.close();}expect(existsSync(join(f.dir,".git"))).toBe(false);
});
test("shadow research daemon records real turn trees while keeping .git absent (#259)",async()=>{
  const f=await fixture(true);f.peer.turn();const turns=new Turns(join(f.state,"hub.db"),true);try{const rows=turns.list("codex");expect(rows).toHaveLength(1);expect(rows[0]?.start_tree).toBeTruthy();expect(rows[0]?.end_tree).toBeTruthy();}finally{turns.close();}
  expect(readFileSync(join(f.state,"hub.log"),"utf8")).not.toContain("project has no Git or shadow repository");expect(existsSync(join(f.dir,".git"))).toBe(false);
});
