import { sanitize } from "./envelope.ts";
import type { BusEvent } from "./bus.ts";
import { CLASSES, type Task } from "./board.ts";

export interface OperationalViewPorts {
  tasks: readonly Task[];
  isPii(task:Task):boolean;
  publicView(task:Task):Record<string,unknown>;
  publicMetadataText(text:string):boolean;
  redact(record:unknown):unknown;
}
/** Closed metadata receipts only. Unsupported nested records are withheld until given their own projection. */
const EVENT_FIELDS: Record<string,readonly string[]>={
  state:["peer","state"],hub_start:["instance"],native_thread:["peer","thread","fresh"],turn_start:["peer","turn"],native_turn_end:["peer","id"],
  task:["id","event","by","state","owner","reviewer","class","profile","profileClass","role","pii","reason","release","priority","plannedStart","due"],
  tokens:["peer","n","task","attribution","pii"],
  usage:["peer","source","id","task","attribution","pii","reasoningTokens","measuredAt","inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","totalTokens"],
  turn_end:["peer","turn","ms","tokens","files","snapshotMs","task","attribution","pii"],
  conduct:["peer","action","task","target"],agent_cli:["peer","command","refused","delegated"],
  pii_screen:["task","item","label","source","category","miss","ms"],
  overflow:["id","from","peer"],undeliverable:["id","from","peer"],stale:["id","from","peer","task"],quiet:["id","from","peers"],
  envelope:["id","from","to","priority","hop","kind","task","bytes","private","dropped"],
  memory_brief:["source","peer","task","native","fails","claudeMem"],
  fact:["peer","id","files","plans","unknown","named","bytes","via","ms","hookMs","rttMs","accepted","unanswered","probe","coverage"],
  fact_ack:["peer","id","via","ms"],permission_mode:["peer","from","to"],
  permission:["id","peer","event","latencyMs","surface","option"],
  supervision_turn:["peer","turn","tokens","ms"],hook_stats:["peer","n","startupMs","hubMs","maxStartupMs"],
  capability:["peer","state","via"],cohort:["id","event","silent","tasks","owners"],
  planning:["by","task","release","fields","revision"],context_pressure:["peer","source","measuredAt","used","window"],
  budget_pause:["peer","reason","window","resetsAt","by"],budget_resume:["peer","reason","window","resetsAt","by"],
  quota_reset:["peer","window","cause","resetsAt","used","previousUsed","previousResetsAt","measuredAt"],
};
const EVENT_REQUIRED:Record<string,readonly string[]>={
  state:["peer","state"],hub_start:["instance"],native_thread:["peer","thread","fresh"],turn_start:["peer","turn"],native_turn_end:["peer"],
  task:["id","event","by","state","owner","reviewer","class","pii"],tokens:["peer","n"],usage:["peer","source","id"],turn_end:["peer","turn","ms"],
  conduct:["peer","action"],agent_cli:["peer","command","refused"],pii_screen:["item","label","source"],
  overflow:["id","from","peer"],undeliverable:["id","from","peer"],stale:["id","from","peer"],quiet:["id","from","peers"],envelope:["id","from","priority","hop"],
  memory_brief:["peer","task","native","fails","claudeMem"],fact:["peer","id","files","plans","unknown","named","bytes","via"],fact_ack:["peer","id","via","ms"],
  permission_mode:["peer","from","to"],permission:["id","peer","event"],supervision_turn:["peer","turn"],hook_stats:["peer","n","startupMs","hubMs","maxStartupMs"],
  capability:["peer","state"],cohort:["id","event","silent","tasks","owners"],planning:["by","fields","revision"],context_pressure:["peer","source","measuredAt","used","window"],
  budget_pause:["peer","reason","window","resetsAt","by"],budget_resume:["peer","reason","window","resetsAt","by"],quota_reset:["peer","window","cause","used","previousUsed"],
};
const NUMBERS=new Set(["n","ms","tokens","files","snapshotMs","reasoningTokens","inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","totalTokens","hop","bytes","native","fails","claudeMem","plans","unknown","named","hookMs","rttMs","latencyMs","startupMs","hubMs","maxStartupMs","used","previousUsed","previousResetsAt","resetsAt","plannedStart","due","revision"]);
const BOOLEANS=new Set(["pii","private","fresh","refused","delegated","accepted","unanswered","probe","coverage","silent"]);
const TASK_EVENTS=new Set(["proposed","backlogged","backlog pulled","backlog returned","accepted","assigned","reassigned","unassigned","reserved","ready","blocked","declined","escalated","done","approved","changes_requested","cancelled","lifecycle"]);
const identifier=(value:unknown):value is string=>typeof value==="string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value);
const peerId=(value:unknown):value is string=>typeof value==="string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const oneOf=(value:unknown,values:readonly string[])=>typeof value==="string" && values.includes(value);
function metadataValue(type:string,key:string,value:unknown):boolean {
  if(value===null && ["plannedStart","due"].includes(key))return true;
  if(NUMBERS.has(key))return typeof value==="number" && Number.isFinite(value) && value>=0;
  if(BOOLEANS.has(key))return typeof value==="boolean";
  if(["peer","owner","reviewer","target","by"].includes(key))return value===null && ["owner","reviewer"].includes(key) || peerId(value);
  if(key==="from" || key==="to")return type==="permission_mode"?oneOf(value,["ask","ask-when-needed","never-ask"]):key==="to"?Array.isArray(value)&&value.length<=64&&value.every(peerId):peerId(value);
  if(["peers","owners"].includes(key))return Array.isArray(value)&&value.length<=64&&value.every(peerId);
  if(key==="tasks")return Array.isArray(value)&&value.length<=500&&value.every(positive);
  if(key==="task" || key==="release")return key==="release"&&value===null || positive(value) || key==="task"&&typeof value==="string"&&/^[1-9][0-9]*$/.test(value);
  if(key==="id")return type==="task" || type==="cohort"?positive(value):identifier(value);
  if(key==="class")return oneOf(value,CLASSES);
  if(key==="profile")return oneOf(value,["dev","research","writing","general"]);
  if(key==="profileClass")return typeof value==="string" && /^[a-z][a-z0-9_]{0,47}$/.test(value);
  if(key==="state")return type==="task"?oneOf(value,["backlog","proposed","in_progress","in_review","approved","changes_requested","cancelled"]):type==="capability"?oneOf(value,["verified","lost"]):oneOf(value,["idle","busy","paused","offline"]);
  if(key==="event")return type==="task"?typeof value==="string"&&TASK_EVENTS.has(value):type==="cohort"?oneOf(value,["formed","joined","lifted"]):oneOf(value,["requested","answered","expired","cancelled"]);
  if(key==="attribution")return oneOf(value,["delivery","single_open","unattributed"]);
  if(key==="label")return oneOf(value,["pii","clear"]);
  if(key==="item")return oneOf(value,["task","summary","review note","handoff","note"]);
  if(key==="category")return oneOf(value,["name","student_id","phone","address","grade","health","other"]);
  if(key==="miss")return oneOf(value,["too long","off campus","timeout","unreadable","failed"]);
  if(key==="source")return type==="pii_screen"?oneOf(value,["regex","screen","unknown","inherited"]):type==="usage"?oneOf(value,["omniroute","claude_transcript","claude_result","codex_appserver","kimi_wire"]):identifier(value);
  if(key==="measuredAt")return type==="context_pressure" || type==="quota_reset"?typeof value==="number"&&Number.isFinite(value):typeof value==="string"&&Number.isFinite(Date.parse(value));
  if(key==="window")return value===null || typeof value==="number"&&Number.isFinite(value)&&value>=0 || identifier(value);
  if(key==="priority")return value===null || typeof value==="number"&&Number.isFinite(value) || oneOf(value,["status","important","fyi"]);
  if(key==="fields")return Array.isArray(value)&&value.length<=32&&value.every(identifier);
  if(["action","command","reason"].includes(key))return typeof value==="string" && /^[a-z][a-z0-9_ .:-]{0,63}$/.test(value);
  return identifier(value);
}

/** Shared by the daemon's existing console stream and operational projection tests. */
export function redactBusEvent(e:BusEvent):BusEvent {
  if (!("env" in e) || !e.env.private) return e;
  const {refs,...env}=e.env;
  const task=refs?.task && /^[0-9]+$/.test(refs.task)?refs.task:undefined;
  return {...e,env:{...env,...(task?{refs:{task}}:{}),body:`[private${task?`: task #${task}, see ahub task show ${task}`:""}]`}};
}
const WITHHELD="[withheld: private or unclassifiable operational record]";
const positive=(value:unknown):value is number=>Number.isSafeInteger(value) && (value as number)>0;

/** Bind the existing task/privacy projections once per read; no private title or path leaves this closure. */
export function operationalView(ports:OperationalViewPorts) {
  const tasks=new Map(ports.tasks.map(task=>[task.id,task]));
  const privateTitles:string[]=[];
  // ponytail: a complete privacy inventory is capped at 500 tasks; indexed scoped log records can extend it.
  let known=ports.tasks.length<=500;
  try {for(const task of ports.tasks.slice(0,500)) {const view=ports.publicView(task);if(ports.isPii(task) || view.title!==task.title) privateTitles.push(task.title);}} catch {known=false;}
  const safeTask=(id:number):boolean=>{
    const task=tasks.get(id);
    if (!task) return false;
    try {return !ports.isPii(task) && ports.publicView(task).title===task.title;} catch {return false;}
  };
  const safeText=(text:string):boolean=>{
    if (!known || Buffer.byteLength(text)>65536 || privateTitles.some(title=>title && text.includes(title))) return false;
    try {return ports.publicMetadataText(text);} catch {return false;}
  };
  const line=(value:unknown):string=>{
    if (typeof value!=="string" || !safeText(value)) return WITHHELD;
    for(const match of value.matchAll(/\btask\s+#?([1-9][0-9]*)\b/gi)) if(!safeTask(Number(match[1])))return WITHHELD;
    return sanitize(value);
  };
  const event=(value:unknown):Record<string,unknown>=>{
    const withheld={type:"withheld"};
    try {
      if (!value || typeof value!=="object" || Array.isArray(value)) return withheld;
      const raw=value as Record<string,unknown>;
      if(raw.v!==1 || typeof raw.at!=="string" || !Number.isFinite(Date.parse(raw.at)) || typeof raw.type!=="string")return withheld;
      const fields=EVENT_FIELDS[raw.type];
      if(!fields || !Object.hasOwn(EVENT_FIELDS,raw.type))return withheld;
      const allowed=new Set(["v","at","type",...fields]);
      if(Object.keys(raw).some(key=>!allowed.has(key)) || EVENT_REQUIRED[raw.type]!.some(key=>!Object.hasOwn(raw,key) || raw[key]===undefined))return withheld;
      if(fields.some(key=>raw[key]!==undefined && !metadataValue(raw.type as string,key,raw[key])))return withheld;
      if (raw.pii===true || raw.private===true) return withheld;
      const ids:unknown[]=[];
      if (raw.type==="task") ids.push(raw.id);
      if (raw.task!==undefined) ids.push(typeof raw.task==="string" && /^[1-9][0-9]*$/.test(raw.task)?Number(raw.task):raw.task);
      if (raw.type==="conflict") ids.push(raw.other);
      if (raw.type==="overlap") {
        if(!Array.isArray(raw.others))return withheld;
        for(const other of raw.others) {if(!other || typeof other!=="object")return withheld;ids.push(other.task);}
      }
      if(raw.type==="cohort") {if(!Array.isArray(raw.tasks))return withheld;ids.push(...raw.tasks);}
      if(ids.some(id=>!positive(id) || !safeTask(id)))return withheld;
      const redacted=ports.redact(value);
      if(!redacted || typeof redacted!=="object" || Array.isArray(redacted))return withheld;
      const projected=Object.fromEntries(["v","at","type",...fields].filter(key=>Object.hasOwn(redacted,key)).map(key=>[key,(redacted as Record<string,unknown>)[key]]));
      const text=JSON.stringify(projected);
      if(!safeText(text))return withheld;
      // Rebuild through JSON, then sanitize every rendered string, including metadata strings.
      return JSON.parse(text,(_key,item)=>typeof item==="string"?sanitize(item):item) as Record<string,unknown>;
    } catch {return withheld;}
  };
  return {line,event,complete:known};
}
