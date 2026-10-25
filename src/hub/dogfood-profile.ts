import type { DogfoodInput, Source } from "./dogfood.ts";
import { CLASSES } from "./board.ts";
import { PROFILE_NAMES, projectProfile, type ProfileName } from "./profiles.ts";
import { summarizeByTask } from "./report.ts";
import type { StampedEvent } from "./events.ts";

export interface ProfileHistory {
  at: number; event: string; criteria?: string[]; criteriaPrivate?: true; deliverables?: string[];
}
export interface ProfileTaskMetadata {
  profile: ProfileName; state?: string; class: string; alias: string | null; history: ProfileHistory[];
}
const complete = (s: Source<unknown>) => s.available && s.complete;
const number = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const peer = (s: string) => /^[a-z][a-z0-9-]{0,63}$/.test(s) && !Object.hasOwn(Object.prototype, s);
export const dogfoodProfileName = (s: unknown): s is ProfileName => typeof s === "string" && (PROFILE_NAMES as readonly string[]).includes(s);
const baseClass = (s: unknown): s is string => typeof s === "string" && (CLASSES as readonly string[]).includes(s);
const criterion = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z][A-Za-z0-9-]{0,47}$/.test(s);

/** One validation boundary for the profile consumer and its bounded collector. Unknown event types stay forward compatible. */
export function profileEventValid(value: unknown): boolean {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const e=value as Record<string,unknown>;
  if (e.v!==1 || typeof e.at!=="string" || !Number.isFinite(Date.parse(e.at)) || typeof e.type!=="string") return false;
  const optional = (key:string, valid:(value:unknown)=>boolean) => e[key]===undefined || valid(e[key]);
  const text = (value:unknown): value is string => typeof value==="string" && value.length>0;
  const peerId = (value:unknown) => typeof value==="string" && peer(value);
  const strings = (value:unknown) => Array.isArray(value) && value.every(v=>typeof v==="string");
  const bool = (value:unknown) => typeof value==="boolean";
  const oneOf = (value:unknown, choices:readonly string[]) => typeof value==="string" && choices.includes(value);
  const taskId = () => optional("task",positive);
  if (e.type==="task") {
    return positive(e.id) && baseClass(e.class) && text(e.event)
      && oneOf(e.state,["backlog","proposed","in_progress","in_review","approved","changes_requested","cancelled"])
      && optional("profile",dogfoodProfileName) && optional("profileClass",v=>typeof v==="string" && /^[a-z][a-z0-9_]{0,47}$/.test(v))
      // Older metadata projections may omit privacy; absence remains conservative at event-only binding.
      && optional("pii",bool) && optional("by",peerId)
      && optional("owner",v=>v===null || peerId(v)) && optional("reviewer",v=>v===null || peerId(v));
  }
  if (e.type==="overlap") {
    return positive(e.task) && optional("owner",peerId) && Array.isArray(e.others) && e.others.every(other=>{
      if (!other || typeof other!=="object" || Array.isArray(other)) return false;
      return positive(other.task) && strings(other.paths) && (other.owner===undefined || peerId(other.owner))
        && (other.symbols===undefined || strings(other.symbols));
    });
  }
  if (e.type==="conflict") {
    return taskId() && positive(e.other) && strings(e.paths) && bool(e.concurrent)
      && optional("peer",peerId) && optional("owner",peerId)
      && optional("turns",v=>Array.isArray(v) && v.length===2 && v.every(text));
  }
  if (e.type==="tokens" || e.type==="usage" || e.type==="turn_end") {
    if (!peerId(e.peer) || !taskId() || !optional("pii",bool)
      || !optional("attribution",v=>oneOf(v,["delivery","single_open","unattributed"]))) return false;
    if ((e.attribution==="delivery" || e.attribution==="single_open") && !positive(e.task)) return false;
    if (e.type==="tokens") return number(e.n);
    if (e.type==="turn_end") return number(e.ms) && optional("turn",text) && optional("snapshotMs",number) && optional("tokens",number) && optional("files",number);
    return text(e.id) && oneOf(e.source,["omniroute","claude_transcript","claude_result","codex_appserver","kimi_wire"])
      && ["inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","totalTokens","reasoningTokens"].every(key=>optional(key,number))
      && optional("measuredAt",v=>typeof v==="string" && Number.isFinite(Date.parse(v)));
  }
  if (e.type==="pii_screen") {
    return taskId() && oneOf(e.item,["task","summary","review note","handoff","note"]) && oneOf(e.label,["pii","clear"])
      && oneOf(e.source,["regex","screen","unknown","inherited"]) && optional("ms",number)
      && optional("category",v=>oneOf(v,["name","student_id","phone","address","grade","health","other"]))
      && optional("miss",v=>oneOf(v,["too long","off campus","timeout","unreadable","failed"]));
  }
  return true;
}

/** Private custom aliases never become grouping keys; public aliases remain bounded stored identifiers. */
export function dogfoodAlias(profile: ProfileName, base: string, raw: unknown, privateTask: boolean): string | null {
  if (raw == null) return baseClass(base) ? base : null;
  if (typeof raw !== "string" || !/^[a-z][a-z0-9_]{0,47}$/.test(raw) || Object.hasOwn(Object.prototype, raw)) return "withheld";
  if (Object.hasOwn(projectProfile(profile).classes, raw) && projectProfile(profile).classes[raw] === base) return raw;
  return privateTask ? "withheld" : raw;
}

type BoundTask = { id: number; pii: boolean; metadata: ProfileTaskMetadata; full: boolean };
function quantiles(values: number[]) {
  values.sort((a,b) => a-b);
  const at = (q: number) => values.length ? values[Math.ceil(values.length*q)-1]! : null;
  return { samples: values.length, p50: at(.5), p90: at(.9) };
}

/** Additive metadata projection. No PR, file, model or config execution and no telemetry inference from prose. */
export function profileScorecard(input: DogfoodInput) {
  // Do not trust a direct Source caller's completeness claim after a malformed consumed record.
  const validEvents=input.events.data.filter(profileEventValid);
  input={...input,events:{...input.events,data:validEvents,complete:input.events.complete && validEvents.length===input.events.data.length}};
  const inWindow = (at: number) => number(at) && at >= input.since && at <= input.until;
  const events = input.events.data.filter(e => inWindow(Date.parse(e.at)));
  const bindingLimit = 500;
  let bindingsTruncated = false;
  const observedProfiles = new Set<ProfileName>();
  const bound = new Map<number, BoundTask>();
  for (const task of input.tasks.data) {
    const m = task.profileMetadata;
    if (!positive(task.id) || !m || !dogfoodProfileName(m.profile) || !baseClass(m.class)) continue;
    if (m.history.some(h=>inWindow(h.at))) observedProfiles.add(m.profile);
    if (!bound.has(task.id) && bound.size>=bindingLimit) { bindingsTruncated=true; continue; }
    bound.set(task.id, {id: task.id, pii: task.pii, metadata: {...m, alias: dogfoodAlias(m.profile,m.class,m.alias,task.pii)}, full: complete(input.tasks)});
  }
  // Index at most 500 identities once. Beyond-cap profile names remain visible, but never aliases or task rows.
  const taskEvents = new Map<number, Extract<StampedEvent,{type:"task"}>[]>([...bound.keys()].map(id=>[id,[]]));
  let eventBindingsComplete = true;
  for (const e of events) {
    if (e.type!=="task") continue;
    if (dogfoodProfileName(e.profile)) observedProfiles.add(e.profile);
    if (!positive(e.id)) {eventBindingsComplete=false;continue;}
    if (!taskEvents.has(e.id)) {
      if (!dogfoodProfileName(e.profile) || !baseClass(e.class)) {eventBindingsComplete=false;continue;}
      if (taskEvents.size>=bindingLimit) {bindingsTruncated=true;eventBindingsComplete=false;continue;}
      taskEvents.set(e.id,[]);
    }
    taskEvents.get(e.id)!.push(e);
  }
  // Event windows prove recorded milestones, but cannot restore pre-window history or first-pass review.
  for (const [id, recorded] of taskEvents) {
    const existing = bound.get(id);
    if (existing) { if (recorded.some(e=>e.pii)) existing.pii=true; continue; }
    const e=recorded.find(e=>dogfoodProfileName(e.profile) && baseClass(e.class));
    if (!e || !dogfoodProfileName(e.profile)) {eventBindingsComplete=false;continue;}
    const privateTask=recorded.some(e=>e.pii!==false);
    const history=recorded.map(e=>({at:Date.parse(e.at),event:e.event}));
    bound.set(id,{id,pii:privateTask,full:false,metadata:{profile:e.profile,class:e.class,alias:dogfoodAlias(e.profile,e.class,e.profileClass,privateTask),history}});
  }
  const activeIds = new Set<number>();
  for (const e of events) {
    const id = e.type === "task" ? e.id : "task" in e ? e.task : undefined;
    if (positive(id) && bound.has(id)) {
      activeIds.add(id);
      if ("pii" in e && e.pii) bound.get(id)!.pii=true;
    }
    if (e.type === "overlap" && Array.isArray(e.others)) for (const other of e.others) if (other && bound.has(other.task)) activeIds.add(other.task);
    if (e.type === "conflict" && bound.has(e.other)) activeIds.add(e.other);
  }
  eventBindingsComplete &&= !bindingsTruncated;
  const eventsFull = complete(input.events) && eventBindingsComplete;
  const bindingsComplete = !bindingsTruncated && complete(input.tasks) && input.tasks.data.every(t=>bound.has(t.id));
  const edits = new Map<string, Map<string, number>>();
  const pair = (a:number,b:number) => [a,b].sort((x,y)=>x-y).join(":");
  for (const e of events) {
    if (e.type!=="conflict" || !positive(e.task) || !positive(e.other) || !Array.isArray(e.paths)) continue;
    const key=pair(e.task,e.other), paths=edits.get(key)??new Map<string,number>();
    for (const path of e.paths) if (typeof path==="string") paths.set(path,Math.max(paths.get(path)??0,Date.parse(e.at)));
    edits.set(key,paths);
  }
  const selectedProjectProfile = input.projectProfile && complete(input.projectProfile) && dogfoodProfileName(input.projectProfile.data) ? input.projectProfile.data : null;
  const active = [...bound.values()].filter(t => t.metadata.history.some(h => inWindow(h.at)) || activeIds.has(t.id));
  if (![...observedProfiles].some(profile=>profile!=="dev") && !active.some(t => t.metadata.profile !== "dev") && (selectedProjectProfile === null || selectedProjectProfile === "dev")) return {};
  const profiles = [...new Set([...observedProfiles,...active.map(t=>t.metadata.profile), ...(selectedProjectProfile && selectedProjectProfile!=="dev" ? [selectedProjectProfile] : [])])].sort();
  const rows = profiles.flatMap(profile => {
    const tasks = active.filter(t=>t.metadata.profile === profile);
    const groups: {alias: string|null; base: string|null; tasks: BoundTask[]}[] = [{alias:null,base:null,tasks}];
    for (const task of tasks) {
      const alias = dogfoodAlias(profile,task.metadata.class,task.metadata.alias,task.pii);
      const group = groups.find(g=>g.base === task.metadata.class && g.alias === alias);
      if (group) group.tasks.push(task); else groups.push({alias,base:task.metadata.class,tasks:[task]});
    }
    return groups.map(group => {
      const ids = new Set(group.tasks.map(t=>t.id));
      const full = bindingsComplete && group.tasks.every(t=>t.full);
      const history = group.tasks.flatMap(t=>t.metadata.history.filter(h=>inWindow(h.at)).map(h=>({...h,task:t})));
      const recorded = [...ids].flatMap(id=>taskEvents.get(id)??[]);
      const autoApprovals = recorded.filter(e=>e.event==="done" && e.state==="approved");
      const milestones = full ? history : recorded.map(e=>({at:Date.parse(e.at),event:e.event,task:bound.get(e.id)!}));
      const milestoneKnown = full || eventsFull;
      const scope = full ? "history" : eventsFull ? "recorded_events" : null;
      const count = (event: string) => milestoneKnown ? new Set(milestones.filter(h=>h.event===event || event==="proposed" && h.event==="backlog pulled").map(h=>h.task.id)).size : null;
      const approvalIds = new Set(milestones.filter(h=>h.event==="approved").map(h=>h.task.id));
      for (const e of autoApprovals) approvalIds.add(e.id);
      // A current approved state alone cannot date a reviewer-less done. Never place it in this window by guessing.
      const approvalUnknown = full && group.tasks.some(t=>t.metadata.state==="approved" && !t.metadata.history.some(h=>h.event==="approved") && !autoApprovals.some(e=>e.id===t.id));
      const leads: number[] = [], first: number[] = [];
      for (const task of group.tasks) {
        const all = task.metadata.history.filter(h=>h.at<=input.until).sort((a,b)=>a.at-b.at);
        const proposed = all.find(h=>h.event==="proposed" || h.event==="backlog pulled");
        const approval = all.findLast(h=>h.event==="approved" && inWindow(h.at));
        const automatic = autoApprovals.filter(e=>e.id===task.id).map(e=>Date.parse(e.at)).sort((a,b)=>b-a)[0];
        const approvedAt = approval?.at ?? automatic;
        if (proposed && approvedAt!==undefined && approvedAt>=proposed.at) leads.push(approvedAt-proposed.at);
        // An automatic completion is an approval transition, never a reviewer verdict or first-pass review sample.
        if (approval) { const verdict = all.find(h=>h.event==="approved" || h.event==="changes_requested"); if (verdict) first.push(Number(verdict.event==="approved")); }
      }
      const verdicts = milestones.filter(h=>h.event==="approved" || h.event==="changes_requested");
      const rounds = verdicts.length;
      const rejectionCount = verdicts.filter(h=>h.event==="changes_requested").length;
      const rejections = history.filter(h=>h.event==="changes_requested");
      const criteriaKnown = full && rejections.every(h=>h.criteria !== undefined);
      const criteria = new Map<string,number>(); let privateCriteria = 0;
      for (const h of rejections) {
        for (const id of h.criteria ?? []) {
          if (h.task.pii || h.criteriaPrivate) privateCriteria++; else if (criterion(id)) criteria.set(id,(criteria.get(id)??0)+1);
        }
      }
      const selected = events.filter(e => "task" in e && typeof e.task === "number" && ids.has(e.task));
      const overlaps = events.filter((e): e is Extract<StampedEvent,{type:"overlap"}> => e.type==="overlap" && positive(e.task) && Array.isArray(e.others) && (ids.has(e.task) || e.others.some(o=>o && ids.has(o.task))));
      const warnings = overlaps.flatMap(e=>e.others.filter(o=>o && positive(o.task) && (ids.has(e.task) || ids.has(o.task)) && Array.isArray(o.paths)).map(o=>({at:Date.parse(e.at),a:e.task,b:o.task,paths:o.paths,sections:Array.isArray(o.symbols) && o.symbols.some(s=>typeof s==="string" && s.startsWith("section "))})));
      // conflict is snapshot/fact edit evidence, not another overlap advisory. Concurrent snapshots do not assign authorship.
      const confirmed = new Set<string>();
      for (const warning of warnings) {
        const key=pair(warning.a,warning.b), edited=edits.get(key);
        if (warning.paths.some(p=>typeof p==="string" && (edited?.get(p)??0)>warning.at)) confirmed.add(key);
      }
      const snapshots = selected.flatMap(e=>e.type==="turn_end" && (e.attribution==="delivery" || e.attribution==="single_open") && number(e.snapshotMs) ? [e.snapshotMs] : []);
      const accounting = selected.filter(e => (e.type==="tokens" || e.type==="usage" || e.type==="turn_end") && peer(e.peer) && (e.attribution==="delivery" || e.attribution==="single_open") && (e.type!=="tokens" || number(e.n)));
      const report = summarizeByTask(accounting);
      const costs = [...ids].sort((a,b)=>a-b).map(task=>({task,peers:complete(input.events) && report.tasks[String(task)] ? Object.fromEntries(Object.entries(report.tasks[String(task)]!.peers).map(([id,p])=>[id,{tokens:p.tokens,input:p.usage.inputTokens,output:p.usage.outputTokens,cacheRead:p.usage.cacheReadTokens,cacheWrite:p.usage.cacheWriteTokens,total:p.usage.totalTokens,records:p.usage.records}])) : null}));
      const screened = selected.filter(e=>e.type==="pii_screen" && e.item==="note" && e.label==="pii" && (e.source==="screen" || e.source==="unknown"));
      const eventCount = (n:number) => full && complete(input.events) ? n : null;
      return {profile, alias:group.alias, baseClass:group.base, tasks:[...ids].sort((a,b)=>a-b),
        flow:{scope,autoApprovalTransitions:{scope:"recorded_events",value:eventsFull?new Set(autoApprovals.map(e=>e.id)).size:null},proposed:count("proposed"),accepted:count("accepted"),approved:milestoneKnown&&!approvalUnknown?approvalIds.size:null,cancelled:count("cancelled"),proposeToApproveMs:full&&!approvalUnknown?quantiles(leads):{samples:null,p50:null,p90:null},reviewRounds:milestoneKnown?rounds:null,firstPassApproval:full&&!approvalUnknown&&first.length?first.reduce((a,b)=>a+b,0)/first.length:null,escalations:count("escalated")},
        review:{changesRequested:milestoneKnown?rejectionCount:null,checklistItems:null,criteria:criteriaKnown?[...criteria].sort(([a],[b])=>a.localeCompare(b)).map(([id,count])=>({id,count})):null,privateCriteria:criteriaKnown?privateCriteria:null},
        overlap:{pathNotices:eventCount(warnings.filter(w=>w.paths.length).length),sectionNotices:eventCount(warnings.filter(w=>w.sections).length),observedPathEditPairs:eventCount(confirmed.size),sectionEditPairs:null},
        deliverables:{recordedCount:full&&history.some(h=>h.deliverables!==undefined)?group.tasks.reduce((n,t)=>n+new Set(history.filter(h=>h.task.id===t.id).flatMap(h=>h.deliverables??[])).size,0):null,changedSinceApproval:null,unknownStates:null},
        privacy:{privateTasks:full?group.tasks.filter(t=>t.pii).length:null,refusals:null,memoryNotesDropped:null,observedMemoryNoteScreenDrops:!bindingsTruncated&&complete(input.events)&&screened.length?screened.length:null,captureRowsDropped:null},
        undo:{requests:null,completed:null,guardRefused:null},snapshots:{budgetExhaustions:null,durationMs:!bindingsTruncated&&complete(input.events)?quantiles(snapshots):{samples:null,p50:null,p90:null}},profileErrors:{unknownAlias:null,otherProfileAlias:null},cost:{perTask:ids.size || bindingsComplete || eventsFull ? costs : null}};
    });
  });
  return {profile:{bindings:{limit:bindingLimit,retained:bound.size,complete:!bindingsTruncated},sources:{tasks:{available:input.tasks.available,complete:complete(input.tasks),bindingsComplete},events:{available:input.events.available,complete:complete(input.events),bindingsComplete:eventBindingsComplete},config:input.projectProfile?{available:input.projectProfile.available,complete:complete(input.projectProfile)}:null},rows}};
}
