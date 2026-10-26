import {mkdtempSync, mkdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const launcher=resolve(process.argv[2] ?? join(homedir(),'.pi/agent/bin/pi'));
const packageRoot=resolve(process.argv[3] ?? join(homedir(),'.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent'));
const extension=fileURLToPath(new URL('../../src/pi/extension.ts',import.meta.url));
const driver=fileURLToPath(new URL('./pi-140-native.mjs',import.meta.url));
import {PiToolReceipts} from '../../src/pi/tool-receipts.ts';
const home=mkdtempSync('/tmp/ahub-505-native-home.'); mkdirSync(join(home,'agent'));
const pkg=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
assert.equal(pkg.name,'@earendil-works/pi-coding-agent');assert.equal(pkg.version,'1.4.0');
const version=Bun.spawn([launcher,'--version'],{cwd:home,env:{HOME:home,PATH:process.env.PATH!,PI_CODING_AGENT_DIR:join(home,'agent')},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
const versionTimer=setTimeout(()=>version.kill(),10000);
const [versionCode,versionOut,versionErr]=await Promise.all([version.exited,new Response(version.stdout).text(),new Response(version.stderr).text()]);clearTimeout(versionTimer);
assert.equal(versionCode,0);assert.equal(versionOut.trim(),'1.4.0');assert.equal(versionErr,'');
const ledger=new PiToolReceipts(join(home,'hub.db'));
let effects=0, providers=0; const events:any[]=[];
const bridge=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const url=new URL(req.url); if(req.headers.get('authorization')!=='Bearer fixture')return new Response('forbidden',{status:403});
 if(url.pathname==='/commands') {await Bun.sleep(25);return Response.json({command:null});}
 const body=await req.json() as any;
 if(url.pathname==='/event'){events.push(body.type);return Response.json({ok:true});}
 if(url.pathname==='/budget')return Response.json({decisions:[]});
 if(url.pathname==='/tool') {
  const text=await ledger.execute(body.sessionId,body.toolCallId,body.name,body.args,async()=>{
   if(body.args.value==='deny')return 'error: fixture permission denied';
   effects++;return 'fixture success';
  });
  return Response.json({text,failed:text.startsWith('error:')});
 }
 providers++;return new Response('provider forbidden',{status:500});
}});
const env={HOME:home,PATH:process.env.PATH!,PI_CODING_AGENT_DIR:join(home,'agent'),HUB_EXTENSION:extension,PI_COMPAT_PACKAGE:packageRoot,
 AGENTHUB_PI_BRIDGE_URL:`http://127.0.0.1:${bridge.port}`,AGENTHUB_PI_BRIDGE_TOKEN:'fixture',AGENTHUB_PI_OWNER_TOKEN:'fixture',
 AGENTHUB_PI_TOOLS:JSON.stringify([{name:'compat_probe',description:'model-free fixture',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}}])};
const child=Bun.spawn(['node',driver],{cwd:home,env,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
const timer=setTimeout(()=>child.kill(),10000);
const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timer);
console.log(JSON.stringify({code,stdout,stderr,effects,providers,events,isolatedHome:home}));
const native=Bun.spawn([launcher,'--mode','rpc','--provider','agent-hub-local','--model','fixture','--no-builtin-tools','--no-skills','--no-prompt-templates','--no-extensions','--extension',env.HUB_EXTENSION,'--session-dir',join(home,'native-sessions')],{
 cwd:home,env:{...env,AGENTHUB_PI_RELAY_URL:`http://127.0.0.1:${bridge.port}/v1`,AGENTHUB_PI_RELAY_TOKEN:'fixture',AGENTHUB_PI_MODELS:JSON.stringify([{id:'fixture',name:'fixture'}])},stdin:'pipe',stdout:'pipe',stderr:'pipe'});
native.stdin.write(JSON.stringify({id:'probe',type:'get_state'})+'\n');
const nativeTimer=setTimeout(()=>native.kill(),10000);
let wire='';for await(const chunk of native.stdout){wire+=new TextDecoder().decode(chunk);if(wire.includes('"command":"get_state"')){native.kill();break;}}
await native.exited;clearTimeout(nativeTimer);const nativeErr=await new Response(native.stderr).text();
console.log(JSON.stringify({nativeRpc:wire,nativeStderr:nativeErr,providers,events}));
bridge.stop(true);await ledger.close();
assert.equal(code,0);assert.equal(stderr,'');
const result=JSON.parse(stdout);
assert.equal(result.extension,'loaded');assert.equal(result.first.isError,false);assert.deepEqual(result.first,result.replay);assert.equal(result.denied.isError,true);
assert.equal(effects,1);assert.equal(providers,0);assert.equal(nativeErr,'');
const state=wire.trim().split('\n').map(line=>JSON.parse(line)).find(item=>item.command==='get_state');
assert.equal(state?.success,true);assert.equal(state.data.messageCount,0);assert.ok(state.data.sessionId);assert.ok(state.data.sessionFile);
assert.ok(events.includes('session_start'));assert.ok(events.includes('session_shutdown'));
console.log('pi 1.4.0 model-free receipt: PASS');
