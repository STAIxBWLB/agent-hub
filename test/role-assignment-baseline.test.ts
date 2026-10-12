import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Board} from "../src/hub/board.ts";
import {Bus} from "../src/hub/bus.ts";
import {Tasks} from "../src/hub/tasks.ts";
import {BasePeer} from "../src/hub/peers.ts";
import {USER,type Envelope} from "../src/hub/envelope.ts";
import {loadRouting} from "../src/hub/routing.ts";
class Peer extends BasePeer{async start(){this.setState("idle");}async stop(){this.setState("offline");}async deliver(_envs:Envelope[]){} }
test("default five-peer review assignments retain original 1cbbc57 notice bytes (#295)",async()=>{
 const expected:Record<string,string>=JSON.parse(readFileSync(new URL("fixtures/assignment-notices-1cbbc57.json",import.meta.url),"utf8"));
 for(const [owner,body]of Object.entries(expected)){
  const root=mkdtempSync(join(tmpdir(),"ahub-role-notice-baseline-")),board=new Board(":memory:"),bus=new Bus({batchMs:0}),captured:Envelope[]=[];bus.tap(event=>{if(event.t==="envelope"&&event.env.kind==="task")captured.push(event.env);});
  const routing=loadRouting(root);routing.classes.review={peers:routing.classes.review?.peers??[],...routing.classes.review,local_allowed:true};
  const tasks=new Tasks({board,bus,cwd:root,project:"baseline",routing:()=>routing,notify:()=>{}}),peer=new Peer(owner);bus.add(peer);await peer.start();
  try{await tasks.propose(USER,{title:"baseline task",detail:"stable details",class:"review",owner,refs:{paths:["src/main.ts"]}});expect(captured).toHaveLength(1);expect(captured[0]?.body).toBe(body);}
  finally{bus.closeJournal();board.close();rmSync(root,{recursive:true,force:true});}
 }
});
