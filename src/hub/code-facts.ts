import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { childEnv, stopOwnedProcess, trackGroup } from "./child-process.ts";
import { hubGitEnv, hubGitSync } from "./git.ts";
import { foldSegment } from "./permission-mode.ts";
import { realPath } from "./project.ts";
import { releaseTrackedClean } from "./release-worktree.ts";

export interface CodeSymbol { name: string; kind: string; path: string; line: number; endLine?: number; ambiguous: boolean; change: "unknown" }
export type CodeFactResult<T> = { state: "known"; value: T } | { state: "unknown" };
export interface CodeLocation { repo: string; head: string; private?: boolean }
const unknown = (): {state:"unknown"} => ({state:"unknown"});
const SHA = /^[a-f0-9]{40}$/;
/** These host anchor spellings have no indexed-name lookup attestation in ripwire 0.6.7. */
export const unindexedSymbolSyntax = (name: string): boolean => /#|:|->/.test(name);
// Keep the owned group leader alive after the CLI exits, until the host has stopped every group member.
const LAUNCHER = String.raw`
const {writeSync,closeSync}=require("node:fs");
setInterval(()=>{},1000);
let code=null;
try { code=await Bun.spawn(process.argv.slice(1),{stdin:"ignore",stdout:"inherit",stderr:"ignore"}).exited; } catch {}
try { closeSync(1); } catch {}
writeSync(3,JSON.stringify({code})+"\n");
`;
const MAX_OUTPUT = 256 * 1024, MAX_SYMBOLS = 256, MAX_FILES = 4096, MAX_TREE_BYTES = 32 * 1024 * 1024;
const within = (root:string,file:string) => {const r=relative(root,file);return r !== ".." && !r.startsWith("../") && !isAbsolute(r);};
const text = (value:unknown,cap=512): value is string => typeof value === "string" && !!value && Buffer.byteLength(value)<=cap && !/[\p{Cc}\p{Cf}]/u.test(value);
const pathName = (value:unknown): value is string => text(value,2048) && !isAbsolute(value) && !value.includes("\\") && !value.split("/").some(p=>!p || [".","..",".git"].includes(foldSegment(p)));
const integer = (value:unknown) => typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
interface Xml { tag:string; attrs:Record<string,string>; children:Xml[] }
/** Small bounded XML data reader: no DTD, entities, processing instructions or external resources. */
function xml(raw:string): Xml {
  let root:Xml|undefined;const stack:Xml[]=[];let count=0;
  const decode=(s:string)=>s.replace(/&(amp|lt|gt|quot|apos);/g,(_,e:string)=>({amp:"&",lt:"<",gt:">",quot:'"',apos:"'"})[e]!);
  const tokens=raw.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g)??[];if(tokens.join("")!==raw)throw Error();
  for(const part of tokens) {
    if(part.startsWith("<!--"))continue;
    if(!part.startsWith("<")){if(part.trim())throw Error();continue;}
    if(part.startsWith("</")){if(!/^<\/[a-z][a-z0-9_-]*>$/.test(part)||stack.pop()?.tag!==part.slice(2,-1))throw Error();continue;}
    const m=/^<([a-z][a-z0-9_-]*)([\s\S]*?)(\/?)>$/.exec(part);if(!m || ++count>4096 || stack.length>16)throw Error();
    const attrs:Record<string,string>=Object.create(null);let rest=m[2]!;
    while(rest.trim()) {
      const a=/^\s+([a-z_][a-z0-9_-]*)="([^"<>]*)"/.exec(rest);if(!a || Object.hasOwn(attrs,a[1]!) || /&(?!amp;|lt;|gt;|quot;|apos;)/.test(a[2]!))throw Error();
      attrs[a[1]!]=decode(a[2]!);rest=rest.slice(a[0].length);
    }
    const node={tag:m[1]!,attrs,children:[] as Xml[]};
    if(stack.length)stack.at(-1)!.children.push(node);else {if(root)throw Error();root=node;}
    if(!m[3])stack.push(node);
  }
  if(!root || stack.length)throw Error();return root;
}
function cleanSymbol(name:unknown,kind:unknown,position:unknown,via?:unknown): CodeSymbol {
  if(via!==undefined && via!=="name" && via!=="resolved")throw Error();
  if(!text(name) || !text(kind,32) || !/^[a-z_]+$/.test(kind) || !text(position,2100))throw Error();
  const p=/^(.*):(\d+)$/.exec(position);if(!p || !pathName(p[1]) || !integer(p[2]) || Number(p[2])<1)throw Error();
  return {name,kind,path:p[1],line:Number(p[2]),ambiguous:via === "name",change:"unknown"};
}
function changed(raw:string,head:string,base:string,cwd:string): CodeSymbol[] {
  const root=xml(raw),a=root.attrs;
  if(root.tag!=="pr-context" || a.schema!=="ripwire.pr-context/v1" || !a.root || realPath(a.root)!==realPath(cwd) || !a.at || !head.startsWith(a.at) || a.at.length<9 || !a.base_sha || !base.startsWith(a.base_sha) || a.base_sha.length<9
    || a.anchor!=="merge-base" || a.direction!=="head-since-fork" || ![undefined,"0","false","none"].includes(a.truncated) || ![undefined,"0"].includes(a.trim_level) || ![undefined,"0","1","false","true"].includes(a.counts_floor))throw Error();
  const files=root.children.filter(n=>n.tag==="file");if(!integer(a.files)||Number(a.files)!==files.length)throw Error();
  const out:CodeSymbol[]=[];
  for(const file of files) {
    if(!pathName(file.attrs.p))throw Error();
    const group=file.children.find(n=>n.tag==="changed-symbols");if(!group || !integer(group.attrs.count))throw Error();
    const symbols=group.children.filter(n=>n.tag==="s");if(Number(group.attrs.count)!==symbols.length || !integer(file.attrs.symbols) || Number(file.attrs.symbols)<symbols.length)throw Error();
    for(const symbol of symbols) {
      if(![undefined,"0","false"].includes(symbol.attrs.capped))throw Error();
      const s=cleanSymbol(symbol.attrs.n,symbol.attrs.t,symbol.attrs.p,symbol.attrs.via);if(s.path!==file.attrs.p)throw Error();out.push(s);
    }
  }
  if(out.length>MAX_SYMBOLS)throw Error();return out;
}

/** Sole optional ripwire boundary. No model/config-selected command, no raw output in results or errors. */
export class CodeFacts {
  private readonly cache=new Map<string,Promise<CodeFactResult<unknown>>>();
  private busy=false;
  private closing=false;
  private pending?:Promise<CodeFactResult<unknown>>;
  private cancelActive?:()=>void;
  private failedChild?:ReturnType<typeof spawn>;
  private retained?:{tree:{cwd:string;close:()=>void};child:ReturnType<typeof spawn>};
  async close():Promise<void> {
    this.closing=true;this.cancelActive?.();await this.pending;
    if(this.retained){
      try{await stopOwnedProcess(this.retained.child,{group:true,termMs:50,killMs:500});this.retained.tree.close();this.retained=undefined;}
      catch{throw Error("code facts cleanup unconfirmed");}
    }
  }
  constructor(private readonly options:{env?:NodeJS.ProcessEnv;timeoutMs?:number}={}) {}
  private git(repo:string,args:string[]) {
    return hubGitSync(["-C",repo,...args],{encoding:"utf8",env:hubGitEnv(childEnv(),{repositoryIsolation:true}),timeout:5000,maxBuffer:1024*1024});
  }
  private value(repo:string,args:string[]):string {const r=this.git(repo,args);if(r.status!==0)throw Error();return r.stdout.trim();}
  private nativeEnv(cwd:string):NodeJS.ProcessEnv {
    const env=hubGitEnv(childEnv(this.options.env ?? process.env),{repositoryIsolation:true});
    const filters=this.git(cwd,["config","--name-only","--get-regexp","^filter\\..*\\.(clean|smudge|process|required)$"]);
    if(filters.status!==0 && filters.status!==1)throw Error();
    const keys=filters.stdout.trim()?filters.stdout.trim().split("\n"):[];
    if(keys.length>128 || keys.some(key=>!/^filter\.[A-Za-z0-9_.-]+\.(clean|smudge|process|required)$/.test(key)))throw Error();
    const config=["core.fsmonitor=false","core.hooksPath=/dev/null","diff.external=","core.pager=cat",...keys.map(key=>`${key}=${key.endsWith(".required")?"false":""}`)];
    env.GIT_CONFIG_GLOBAL="/dev/null";env.GIT_CONFIG_NOSYSTEM="1";env.GIT_ATTR_NOSYSTEM="1";env.GIT_PAGER="cat";delete env.GIT_EXTERNAL_DIFF;
    env.GIT_CONFIG_COUNT=String(config.length);
    config.forEach((item,index)=>{const at=item.indexOf("=");env[`GIT_CONFIG_KEY_${index}`]=item.slice(0,at);env[`GIT_CONFIG_VALUE_${index}`]=item.slice(at+1);});
    return env;
  }
  private async run(bin:string,args:string[],cwd:string):Promise<{code:number;out:string}> {
    if(this.closing)return {code:1,out:""};
    return new Promise(resolve=>{
      let child:ReturnType<typeof spawn>;
      try{child=spawn(process.execPath,["-e",LAUNCHER,"--",bin,...args],{cwd,env:this.nativeEnv(cwd),detached:true,stdio:["ignore","pipe","ignore","pipe"]});}catch{resolve({code:1,out:""});return;}
      let size=0,done=false,failed=false,control="";const parts:Buffer[]=[];
      let ended=false;const outputEnd=new Promise<void>(resolveEnd=>child.stdout!.once("end",()=>{ended=true;resolveEnd();}));
      const finish=async(code:number|null)=>{
        if(done)return;done=true;clearTimeout(timer);if(code===null)failed=true;
        if(code!==null && !ended)await Promise.race([outputEnd,Bun.sleep(500)]);
        if(!ended)code=null;
        try{await stopOwnedProcess(child,{group:true,termMs:50,killMs:500});}catch{this.failedChild=child;code=null;}
        if(this.cancelActive===cancel)this.cancelActive=undefined;
        resolve({code:failed?1:code??1,out:!failed && code!==null?Buffer.concat(parts).toString("utf8"):""});
      };
      const cancel=()=>{void finish(null);};this.cancelActive=cancel;
      const timer=setTimeout(cancel,Math.max(1,Math.min(5000,this.options.timeoutMs ?? 5000)));
      child.once("spawn",()=>trackGroup(child));
      child.stdout!.on("data",(b:Buffer)=>{if(failed)return;if(size+b.length>MAX_OUTPUT){failed=true;void finish(null);return;}parts.push(b);size+=b.length;});
      child.stdio[3]!.on("data",(b:Buffer)=>{
        if(done)return;control+=b.toString("utf8");if(control.length>64){void finish(null);return;}
        if(!control.endsWith("\n"))return;
        try{const message=JSON.parse(control);if(Object.keys(message).length!==1 || !(message.code===null || Number.isSafeInteger(message.code)&&message.code>=0&&message.code<=255))throw Error();void finish(message.code);}catch{void finish(null);}
      });
      child.once("error",()=>{void finish(null);});child.once("close",()=>{void finish(null);});
    });
  }
  private tree(repo:string,head:string):{cwd:string;close:()=>void} {
    const inventory=this.value(repo,["ls-tree","-rz","--full-tree",head]);
    const entries=inventory ? inventory.split("\0").filter(Boolean).map(line=>{
      const m=/^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);if(!m || !pathName(m[3]))throw Error();return {mode:m[1]!,oid:m[2]!,name:m[3]!};
    }):[];
    // ponytail: regular-file trees only, <=4096 entries/32 MiB/4 MiB per file. Symlink/gitlink trees stay unknown; a verified materializer is the upgrade.
    if(entries.length>MAX_FILES)throw Error();
    // Always materialize: tracked-clean owner trees can still contain untracked or ignored analysis inputs.
    const parent=mkdtempSync(join(tmpdir(),"ahub-code-facts-")),cwd=join(parent,"tree");let registered=false;
    const close=()=>{
      let failed=false;
      if(registered){const r=this.git(repo,["worktree","remove","--force",cwd]);failed=r.status!==0;}
      rmSync(parent,{recursive:true,force:true});if(failed)throw Error();
    };
    try{
      if(this.git(repo,["worktree","add","--detach","--no-checkout",cwd,head]).status!==0)throw Error();registered=true;
      if(this.git(cwd,["read-tree",head]).status!==0)throw Error();
      // --batch needs explicit object ids; no working-tree filters or checkout hooks are invoked.
      const result=hubGitSync(["-C",repo,"cat-file","--batch"],{input:entries.map(e=>e.oid).join("\n")+"\n",encoding:"latin1",env:hubGitEnv(childEnv(),{repositoryIsolation:true}),timeout:5000,maxBuffer:MAX_TREE_BYTES+1024*1024});
      if(result.status!==0)throw Error();
      const bytes=Buffer.from(result.stdout,"latin1");let offset=0,total=0;
      for(const entry of entries){
        const end=bytes.indexOf(10,offset);if(end<0)throw Error();const m=/^([a-f0-9]{40}) blob (\d+)$/.exec(bytes.subarray(offset,end).toString("ascii"));
        if(!m || m[1]!==entry.oid || !integer(m[2]))throw Error();const size=Number(m[2]);total+=size;offset=end+1;
        if(size>4*1024*1024 || total>MAX_TREE_BYTES || offset+size>=bytes.length || bytes[offset+size]!==10)throw Error();
        const file=join(cwd,entry.name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes.subarray(offset,offset+size));chmodSync(file,entry.mode==="100755"?0o755:0o644);offset+=size+1;
      }
      if(offset!==bytes.length || !releaseTrackedClean(cwd,args=>{const r=this.git(cwd,args);return{code:r.status??1,stdout:r.stdout};}))throw Error();
      return{cwd,close};
    }catch{close();throw Error();}
  }
  private query<T>(at:CodeLocation,key:string,read:(cwd:string,bin:string)=>Promise<T>):Promise<CodeFactResult<T>> {
    if(this.closing || this.retained || at.private || !SHA.test(at.head))return Promise.resolve(unknown());
    let repo:string;try{repo=realPath(at.repo);}catch{return Promise.resolve(unknown());}
    const id=JSON.stringify([repo,at.head,key]),hit=this.cache.get(id);if(hit)return (hit as Promise<CodeFactResult<T>>).then(value=>structuredClone(value));
    if(this.busy)return Promise.resolve(unknown());
    this.busy=true;this.failedChild=undefined;
    const job=(async()=>{
      let tree:ReturnType<CodeFacts["tree"]>|undefined;let answer:CodeFactResult<T>=unknown();
      try{
        const found=Bun.which("ripwire",{PATH:(this.options.env??process.env).PATH});if(!found)throw Error();const bin=realPath(found);if(within(repo,bin))throw Error();
        tree=this.tree(repo,at.head);
        const version=await this.run(bin,["--version"],tree.cwd);if(version.code!==0 || !/^ripwire 0\.6\.7(?:\s|$)/.test(version.out))throw Error();
        const value=await read(tree.cwd,bin);
        if(this.value(tree.cwd,["rev-parse","HEAD"])!==at.head || !releaseTrackedClean(tree.cwd,args=>{const r=this.git(tree!.cwd,args);return{code:r.status??1,stdout:r.stdout};}))throw Error();
        answer={state:"known",value};
      }catch{/* Optional derived evidence is unknown, never a review refusal. */}
      finally{if(tree && this.failedChild){this.retained={tree,child:this.failedChild};answer=unknown();}else try{tree?.close();}catch{answer=unknown();}this.busy=false;}
      return answer;
    })();
    this.pending=job;this.cache.set(id,job);
    if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value!);
    void job.then(answer=>{if(answer.state==="unknown" && this.cache.get(id)===job)this.cache.delete(id);});
    return job.then(value=>structuredClone(value));
  }
  changedSymbols(repo:string,base:string,head:string,options:Omit<CodeLocation,"repo"|"head">={}):Promise<CodeFactResult<CodeSymbol[]>> {
    if(!SHA.test(base))return Promise.resolve(unknown());
    return this.query({...options,repo,head},`changed:${base}`,async(cwd,bin)=>{const r=await this.run(bin,[cwd,`--pr-context=${base}`,"--no-cache"],cwd);if(r.code!==0)throw Error();return changed(r.out,head,base,cwd);});
  }
  enclosing(repo:string,head:string,file:string,line:number,options:Omit<CodeLocation,"repo"|"head">={}):Promise<CodeFactResult<CodeSymbol[]>> {
    if(!pathName(file)||!Number.isSafeInteger(line)||line<1)return Promise.resolve(unknown());
    return this.query({...options,repo,head},`at:${file}:${line}`,async(cwd,bin)=>{
      const r=await this.run(bin,[cwd,`--at=${file}:${line}`,"--no-cache"],cwd);if(r.code!==0)throw Error();const node=xml(r.out),a=node.attrs;
      if(node.tag!=="at" || a.schema!=="ripwire.at/v1" || a.p!==file || Number(a.l)!==line || !integer(a.chain)||Number(a.chain)!==node.children.length || node.children.length>32)throw Error();
      return node.children.map(n=>{if(n.tag!=="s" || !integer(n.attrs.l)||!integer(n.attrs.el)||Number(n.attrs.el)<line || Number(n.attrs.l)>line)throw Error();return {...cleanSymbol(n.attrs.n,n.attrs.t,`${file}:${n.attrs.l}`,n.attrs.via),endLine:Number(n.attrs.el)};});
    });
  }
  private async relations(cwd:string,bin:string,symbol:string,kind:"callers"|"callees"):Promise<{defs:number;items:CodeSymbol[];countsFloor:boolean}> {
    const r=await this.run(bin,[cwd,`--${kind}=${symbol}`,"--json","--no-cache"],cwd);if(r.code!==0)throw Error();const v=JSON.parse(r.out);
    if(v.of!==symbol || !Number.isSafeInteger(v.defs)||v.defs<1 || !Number.isSafeInteger(v.count)||v.count<0 || !Array.isArray(v[kind])||v.count!==v[kind].length || v.count>MAX_SYMBOLS || realPath(v.root)!==realPath(cwd) || ![0,1,false,true].includes(v.counts_floor)
      || !Number.isSafeInteger(v.hop_tested)||v.hop_tested<0||!Number.isSafeInteger(v.hop_untested)||v.hop_untested<0
      || !Number.isSafeInteger(v.graph_ambiguous)||v.graph_ambiguous<0||!Number.isSafeInteger(v.graph_unresolved)||v.graph_unresolved<0)throw Error();
    return {defs:v.defs,countsFloor:!!v.counts_floor,items:v[kind].map((s:Record<string,unknown>)=>({...cleanSymbol(s.n,s.t,s.p,s.via),ambiguous:s.via==="name" || v.defs>1 || v.graph_ambiguous>0}))};
  }
  exists(repo:string,head:string,symbol:string,options:Omit<CodeLocation,"repo"|"head">={}):Promise<CodeFactResult<{exists:boolean;ambiguous:boolean}>> {
    if(!text(symbol))return Promise.resolve(unknown());
    return this.query({...options,repo,head},`exists:${symbol}`,async(cwd,bin)=>{const r=await this.run(bin,[cwd,`--callers=${symbol}`,"--no-cache"],cwd);
      if(r.code!==0){const n=xml(r.out);if(n.tag==="callers" && n.attrs.schema==="ripwire.callers/v1" && n.attrs.of===symbol && n.attrs.found==="0") {
        // ponytail: ripwire 0.6.7 can miss a qualified name whose bare method exists. Require a CLI/schema qualified-lookup attestation before trusting its absence.
        if(symbol.includes(".") || unindexedSymbolSyntax(symbol))throw Error();
        return{exists:false,ambiguous:false};
      }throw Error();}
      const n=xml(r.out);if(n.tag!=="callers" || n.attrs.schema!=="ripwire.callers/v1" || n.attrs.of!==symbol || !integer(n.attrs.defs)||Number(n.attrs.defs)<1)throw Error();return{exists:true,ambiguous:n.attrs.via==="name" || Number(n.attrs.defs)>1};});
  }
  neighbours(repo:string,head:string,symbol:string,depth=1,options:Omit<CodeLocation,"repo"|"head">={}):Promise<CodeFactResult<{callers:CodeSymbol[];callees:CodeSymbol[];hiddenAmbiguous:number;countsFloor:boolean}>> {
    if(depth!==1 || !text(symbol))return Promise.resolve(unknown());
    return this.query({...options,repo,head},`neighbours:${symbol}:1`,async(cwd,bin)=>{
      const incoming=await this.relations(cwd,bin,symbol,"callers"),outgoing=await this.relations(cwd,bin,symbol,"callees"),callers=incoming.items,callees=outgoing.items;
      return {countsFloor:incoming.countsFloor || outgoing.countsFloor,callers:callers.filter(s=>!s.ambiguous),callees:callees.filter(s=>!s.ambiguous),hiddenAmbiguous:[...callers,...callees].filter(s=>s.ambiguous).length};
    });
  }
}
