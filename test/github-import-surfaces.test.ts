import {afterEach,expect,test} from "bun:test";
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DEFAULT_CONFIG,startDaemon} from "../src/hub/daemon.ts";
import {ControlClient} from "../src/hub/control-client.ts";
const ENTRY=join(import.meta.dir,"../src/cli/main.ts");
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
async function cli(root:string,args:string[],markers:Record<string,string>={}){
 const file=join(root,`cli-${crypto.randomUUID()}.ts`);writeFileSync(file,`for(const key of Object.keys(process.env))if(key.startsWith("AGENTHUB_")||["CODEX_THREAD_ID","CLAUDECODE","CLAUDE_CODE_SESSION_ID"].includes(key))delete process.env[key];Object.assign(process.env,${JSON.stringify(markers)},{AGENTHUB_HOME:${JSON.stringify(join(root,"home"))}});process.argv=[process.execPath,${JSON.stringify(ENTRY)},...${JSON.stringify(args)}];await import(${JSON.stringify(ENTRY)});`);
 const child=Bun.spawn([process.execPath,file],{cwd:root,stdin:"ignore",stdout:"pipe",stderr:"pipe"}),timer=setTimeout(()=>child.kill("SIGKILL"),5000);
 try{const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,stdout,stderr};}finally{clearTimeout(timer);}
}
test("GitHub import real CLI and console use fake readonly gh in the selected project (#263)",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ahub-import-surfaces-")),bin=join(root,"bin"),log=join(root,"gh-calls.jsonl"),stateDir=join(root,".agenthub/state");mkdirSync(bin);
 const fake=join(bin,"gh");writeFileSync(fake,`#!${process.execPath}\nimport {appendFileSync} from "node:fs";const args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify({args,cwd:process.cwd()})+"\\n");if(args[0]==="repo"&&args[1]==="view")console.log(JSON.stringify({nameWithOwner:"owner/repo"}));else if(args[0]==="issue"&&args[1]==="list")console.log(JSON.stringify([{number:1,title:"imported work",body:"details",url:"https://github.com/owner/repo/issues/1",state:"OPEN"}]));else process.exit(9);`);chmodSync(fake,0o755);
 const priorPath=process.env.PATH;cleanup.push(()=>{if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;rmSync(root,{recursive:true,force:true});});process.env.PATH=bin+":"+(priorPath??"");
 const daemon=await startDaemon({cwd:root,stateDir,controlPort:0,codexAppPort:0,codexProxyPort:0,config:{...DEFAULT_CONFIG,memory:{...DEFAULT_CONFIG.memory,enabled:false},inference:{...DEFAULT_CONFIG.inference,enabled:false},batch_ms:0}});
 const person=await ControlClient.connect(stateDir,{role:"console"}),other=await ControlClient.connect(stateDir,{role:"tools",peer:"codex"});
 try{
  expect(await other.request({t:"task",op:"github_import",args:{label:"ready"}})).toMatchObject({ok:false});
  const result=await cli(root,["board","import","github","--label","ready"]);expect(result.code).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({imported:[1],existing:[],complete:true});
  const repeated=await person.request({t:"task",op:"github_import",args:{repo:"owner/repo",label:"ready"}});expect(JSON.parse(repeated.text)).toMatchObject({imported:[],existing:[1]});
  const refused=await cli(root,["board","import","github","--label","ready"],{CODEX_THREAD_ID:"fixture"});expect(refused.code).toBe(1);
  const calls=readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line));expect(calls).toHaveLength(3);expect(calls.every(call=>call.cwd===root&&["repo","issue"].includes(call.args[0])&&["view","list"].includes(call.args[1]))).toBe(true);
 }finally{other.close();person.close();await daemon.stop();}
},20_000);
