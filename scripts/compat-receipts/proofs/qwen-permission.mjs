// Parameterized promotion of receipt749 permission producer d777feb9; all native callback assertions retained.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export async function runQwenPermissionProof(options) {
const {SubAgentTracker, toPermissionOptions, resolvePermissionOutcome} = await import(options.moduleUrl);
const captured=[];const responded=[];const updates=[];
const tool={displayName:'hub_task_show (agent-hub MCP Server)',kind:'other',build:args=>({getDescription:()=>JSON.stringify(args),toolLocations:()=>[]})};
const ctx={sessionId:'fixture-session',config:{getToolRegistry:()=>({getTool:()=>tool})},sendUpdate:async u=>updates.push(u)};
const client={requestPermission:async params=>{captured.push(params);return{outcome:{outcome:'selected',optionId:'proceed_once'}}}};
const tracker=new SubAgentTracker(ctx,client,'fixture-parent','fixture-subagent',()=>{});
const event={subagentId:'sub',round:1,callId:'fixture-call',name:'mcp__agent-hub__hub_task_show',confirmationDetails:{type:'mcp',toolName:'hub_task_show',serverName:'agent-hub',title:'fixture permission'},respond:async (...args)=>responded.push(args)};
tracker.toolStates.set(tracker.toolKey(event),{tool,args:{task:373}});
await tracker.createApprovalHandler(new AbortController().signal)(event);
assert.equal(captured.length,1);const p=captured[0];
assert.equal(p.sessionId,'fixture-session');assert.equal(p.toolCall.toolCallId,'fixture-call');assert.equal(p.toolCall.status,'pending');assert.deepEqual(p.toolCall.rawInput,{task:373});assert.equal(p.toolCall._meta.toolName,event.name);
assert.equal(p.options.find(o=>o.kind==='allow_once').optionId,'proceed_once');assert.equal(p.options.find(o=>o.kind==='reject_once').optionId,'cancel');assert.equal(responded[0][0],'proceed_once');
assert.equal(resolvePermissionOutcome({outcome:{outcome:'cancelled'}},p.options),'cancel');
assert.throws(()=>resolvePermissionOutcome({outcome:{outcome:'selected',optionId:'not-offered'}},p.options),/unoffered/);
assert.deepEqual(p.options.map(o=>[o.optionId,o.kind]),[['proceed_always_project','allow_always'],['proceed_always_user','allow_always'],['proceed_once','allow_once'],['cancel','reject_once']]);
const cancelledResponses=[];
const cancelledEvent={...event,callId:'fixture-cancel',respond:async(...args)=>cancelledResponses.push(args)};
const cancellingTracker=new SubAgentTracker(ctx,{requestPermission:async params=>{captured.push(params);return {outcome:{outcome:'cancelled'}};}},'fixture-parent','fixture-cancel-subagent',()=>{});
cancellingTracker.toolStates.set(cancellingTracker.toolKey(cancelledEvent),{tool,args:{task:373}});
await cancellingTracker.createApprovalHandler(new AbortController().signal)(cancelledEvent);
assert.equal(cancelledResponses.length,1);assert.equal(cancelledResponses[0][0],'cancel');
const result={schemaVersion:1,passed:true,permissionRequests:captured.length,exactOptions:true,allowOnce:true,cancelledRespond:cancelledResponses[0][0],unofferedRejected:true,captured,responded,cancelledResponses,updates};
fs.writeFileSync(options.output,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
return result;
}
if (process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  const result=await runQwenPermissionProof(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));
  console.log(JSON.stringify({passed:result.passed,permissionRequests:result.permissionRequests,exactOptions:result.exactOptions,cancelledRespond:result.cancelledRespond,unofferedRejected:result.unofferedRejected}));
}
