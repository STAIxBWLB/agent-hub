import { lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { processLiveness, type Liveness } from "../pi/process-signature.ts";
import type { Project } from "./registry.ts";
import type { ControlDescriptor } from "./control-client.ts";

export interface OrphanSelection { root:string; projectId:string; instanceId:string; pid:number; executable:string; programs:readonly string[] }
export interface SignedOrphan { pid:number; signature:string; root:string; projectId:string; instanceId:string; self:boolean }
export interface OrphanPorts {
  rootState(root:string):"missing"|"present"|"unknown";
  liveness(pid:number,signature:string):Liveness;
  command(pid:number):string|undefined;
  signal(pid:number,signal:"SIGTERM"|"SIGKILL"):void;
  current():void;
  now():number;
  sleep(ms:number):Promise<unknown>;
}
export const orphanProcessPorts: OrphanPorts = {
  rootState(root) { try {lstatSync(root);return "present";} catch(error) {return ["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??"")?"missing":"unknown";} },
  liveness:processLiveness,
  command(pid) {const r=spawnSync("/bin/ps",["-p",String(pid),"-o","command="],{encoding:"utf8",timeout:2000,maxBuffer:65536});return r.status===0?r.stdout.trim()||undefined:undefined;},
  signal:(pid,signal)=>process.kill(pid,signal),current:()=>{throw new Error("conductor authority unavailable");},now:Date.now,sleep:ms=>Bun.sleep(ms),
};

/** Host-known Bun executable and hub entrypoint only; joined argv cannot prove paths containing whitespace. */
export function exactOrphanCommand(command:string|undefined,selection:Pick<OrphanSelection,"root"|"executable"|"programs">):boolean {
  if (!command || [selection.root,selection.executable,...selection.programs].some(word=>/\s/.test(word))) return false;
  const words=command.trim().split(/\s+/);
  return words[0]===selection.executable && selection.programs.includes(words[1]??"") && words[2]==="--project"
    && words[3]===selection.root && words[4]==="daemon" && (words.length===5 || words.length===6 && words[5]==="--unattended");
}
function owns(candidate:SignedOrphan,selection:OrphanSelection,ports:OrphanPorts):boolean {
  ports.current();
  return candidate.root===selection.root && candidate.projectId===selection.projectId && candidate.instanceId===selection.instanceId && ports.rootState(selection.root)==="missing"
    && ports.liveness(candidate.pid,candidate.signature)==="live" && exactOrphanCommand(ports.command(candidate.pid),selection)
    // Recheck the signature after argv inspection, immediately before the caller may signal.
    && ports.liveness(candidate.pid,candidate.signature)==="live";
}
/** Host-selected project only. Unsigned legacy pid files are never conductor signal authority. */
export function inspectSelectedOrphans(selection:OrphanSelection,registration:Project|undefined,control:ControlDescriptor|undefined,ports:OrphanPorts=orphanProcessPorts) {
  ports.current();
  const root=ports.rootState(selection.root);
  if (root!=="missing") return {state:root==="present"?"not_orphan" as const:"unknown" as const,candidates:[] as SignedOrphan[]};
  const proofs:{pid:number|null|undefined;signature:string|null|undefined}[]=[];
  if (registration?.root===selection.root && registration.id===selection.projectId && registration.instanceId===selection.instanceId) proofs.push({pid:registration.pid,signature:registration.pidSignature});
  if (control?.cwd===selection.root && control.projectId===selection.projectId && control.instanceId===selection.instanceId && control.pid===selection.pid) proofs.push({pid:control.pid,signature:control.pidSignature});
  let unknown=proofs.length===0;
  const candidates:SignedOrphan[]=[];
  for (const proof of proofs) {
    if (!Number.isSafeInteger(proof.pid) || proof.pid!<=0 || typeof proof.signature!=="string" || !proof.signature) {unknown=true;continue;}
    const prior=candidates.find(c=>c.pid===proof.pid);
    if (prior) {if(prior.signature!==proof.signature){unknown=true;candidates.splice(candidates.indexOf(prior),1);}continue;}
    const candidate={pid:proof.pid!,signature:proof.signature,root:selection.root,projectId:selection.projectId,instanceId:selection.instanceId,self:proof.pid===selection.pid};
    if (owns(candidate,selection,ports)) candidates.push(candidate); else if(ports.liveness(candidate.pid,candidate.signature)!=="gone") unknown=true;
  }
  return {state:unknown?"unknown" as const:"ready" as const,candidates};
}
/** A self candidate is returned for the daemon's existing reply-then-lifecycle-stop path, never self-signalled. */
export async function stopSelectedOrphan(candidate:SignedOrphan,selection:OrphanSelection,ports:OrphanPorts=orphanProcessPorts):Promise<"stopped"|"self"|"unknown"> {
  if (!owns(candidate,selection,ports)) return "unknown";
  if (candidate.pid===selection.pid) return "self";
  for (const [signal,wait] of [["SIGTERM",3000],["SIGKILL",2000]] as const) {
    if (!owns(candidate,selection,ports)) return ports.liveness(candidate.pid,candidate.signature)==="gone"?"stopped":"unknown";
    try {ports.signal(candidate.pid,signal);} catch {return ports.liveness(candidate.pid,candidate.signature)==="gone"?"stopped":"unknown";}
    const until=ports.now()+wait;
    while (ports.now()<until) {ports.current();const alive=ports.liveness(candidate.pid,candidate.signature);if(alive==="gone")return "stopped";if(alive!=="live")return "unknown";await ports.sleep(100);}
  }
  return ports.liveness(candidate.pid,candidate.signature)==="gone"?"stopped":"unknown";
}
