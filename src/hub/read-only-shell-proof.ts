import { accessSync, constants, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { guardPath, type ShellExecutionCheck } from "../local/tools.ts";
import { hostExecutable } from "./host-executable.ts";
import { hubGitArgv, hubGitEnv } from "./git.ts";
import { realPath } from "./project.ts";
import { readOnlyShellForm, type ReadOnlyProgram } from "./read-only-shell.ts";

export interface ShellProofOptions { root:string; projectRoot?:string; deny:string[]; readOnly?:string[]; env?:Record<string,string> }
export interface ReadOnlyShellProof { fingerprint:string; program:ReadOnlyProgram }
const within=(root:string,path:string)=>{const p=relative(root,path);return p==="" || p!==".."&&!p.startsWith("../")&&!isAbsolute(p);};
function firstProgram(name:string,root:string,path:string):string|undefined {
  if(path.length>16384)return undefined;
  const dirs=path.split(":");if(dirs.length>128)return undefined;
  for(const dir of dirs) {
    // Bash consumes the original PATH: do not normalize an ambiguous entry into a different program.
    if(!isAbsolute(dir) || dir.split("/").includes(".."))return undefined;
    const candidate=resolve(root,dir,name);
    try {accessSync(candidate,constants.X_OK);if(lstatSync(candidate).isDirectory())continue;return candidate;}catch{/* Try only the next actual PATH entry. */}
  }
  return undefined;
}
function stamp(path:string,program:boolean):unknown {
  try {const s=lstatSync(path);return program?[path,s.dev,s.ino,s.mode,s.size,s.mtimeMs,s.ctimeMs]:[path,s.dev,s.ino,s.mode];}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [path,"missing"];throw error;}
}
function ancestors(path:string,stop:string):string[] {
  const out=[path];for(let n=0;path!==stop && n<64;n++){const parent=dirname(path);if(parent===path)break;path=parent;out.push(path);}return out;
}
// Git's subsection names retain case. Expand the literal letters so the entire anchored key pattern is case-insensitive.
const GIT_HELPER_KEYS = /^(core\.fsmonitor|log\.showsignature|gpg\.(program|.+\.program)|diff\.(external|.+\.(command|textconv)))$/.source
  .replace(/[a-z]/g, letter => `[${letter}${letter.toUpperCase()}]`);
/** No config values escape this predicate. Accept only the two exact helper overrides injected by the core. */
export function gitHelpersUnconfigured(git:string,cwd:string,env:NodeJS.ProcessEnv,current:()=>boolean):boolean {
  if(!current() || Object.keys(env).some(key=>key==="GIT_CONFIG_COUNT"||key==="GIT_CONFIG_PARAMETERS"||key.startsWith("GIT_CONFIG_KEY_")||key.startsWith("GIT_CONFIG_VALUE_")))return false;
  const argv=hubGitArgv(["-C",cwd,"config","--show-scope","--get-regexp",GIT_HELPER_KEYS]);
  const result=spawnSync(git,argv.slice(1),{cwd,env:hubGitEnv(env),encoding:"utf8",timeout:1000,maxBuffer:16384,stdio:["ignore","pipe","pipe"]});
  if(!current() || result.error || result.status!==0 || !result.stdout.endsWith("\n"))return false;
  return result.stdout === "command\tcore.fsmonitor false\ncommand\tdiff.external \n";
}
/** A proof is private host metadata, never an argv/env rewrite or an authorization by itself. */
export function proveReadOnlyShell(input:unknown,options:ShellProofOptions,current:()=>boolean):ReadOnlyShellProof|undefined {
  try {
    if(!current() || !input || typeof input!=="object" || Array.isArray(input))return undefined;
    const args=input as Record<string,unknown>;if(typeof args.command!=="string")return undefined;
    if(args.timeout_s!==undefined && (!Number.isFinite(args.timeout_s)||typeof args.timeout_s!=="number"||args.timeout_s<1||args.timeout_s>600))return undefined;
    const root=realPath(options.root),projectRoot=realPath(options.projectRoot??options.root),names:string[]=[root,projectRoot];
    const form=readOnlyShellForm(args.command,root,(path,base=root)=>{if(path.split("/").includes(".."))throw new Error("ambiguous parent traversal");const lexical=resolve(base,path),canonical=guardPath({cwd:root,deny:options.deny,readOnly:options.readOnly},lexical,"read");names.push(lexical,canonical);return canonical;});
    if(!form || !current())return undefined;
    const env={PATH:process.env.PATH??"/usr/bin:/bin",HOME:homedir(),LANG:process.env.LANG??"en_US.UTF-8",TERM:"dumb",...options.env};
    const lexical=firstProgram(form.program,root,env.PATH);if(!lexical || within(root,lexical) || within(projectRoot,lexical))return undefined;
    const executable=hostExecutable(form.program,root,env.PATH);if(realPath(lexical)!==executable || within(projectRoot,executable) || !current())return undefined;
    if(form.gitCwd && !gitHelpersUnconfigured(executable,form.gitCwd,env,current))return undefined;
    // ponytail: this screens the declared helper-bearing config keys and explicit diff/textconv flags; other config-mediated helpers need dedicated audited forms before extending the allowlist.
    const paths=new Set([...names.flatMap(name=>ancestors(name,root)),...ancestors(lexical,"/"),...ancestors(executable,"/")]);
    const fingerprint=createHash("sha256").update(JSON.stringify([root,projectRoot,args.command,env.PATH,lexical,executable,[...paths].map(path=>stamp(path,path===lexical||path===executable))])).digest("hex");
    return current()?{fingerprint,program:form.program}:undefined;
  } catch {return undefined;}
}
interface Decision { command:string; current:()=>boolean; proof?:ReadOnlyShellProof }
export class ShellExecutionProofs {
  private decisions=new WeakMap<object,Decision>();
  constructor(private readonly options:ShellProofOptions){}
  private key(input:unknown):input is Record<string,unknown>{return !!input&&typeof input==="object"&&!Array.isArray(input)&&typeof (input as Record<string,unknown>).command==="string";}
  ordinary(input:unknown,current:()=>boolean):void {if(this.key(input))this.decisions.set(input,{command:input.command as string,current});}
  readonly(input:unknown,proof:ReadOnlyShellProof,current:()=>boolean):void {if(this.key(input))this.decisions.set(input,{command:input.command as string,current,proof});}
  check(input:unknown):ShellExecutionCheck {
    if(!this.key(input))return "ask";const decision=this.decisions.get(input);
    if(!decision)return "ask";
    if(!decision.current())return "aborted";
    if(input.command!==decision.command)return "ask";
    if(!decision.proof)return "valid";
    const proof=proveReadOnlyShell(input,this.options,decision.current);
    if(!decision.current())return "aborted";
    if(!proof || proof.fingerprint!==decision.proof.fingerprint){this.decisions.delete(input);return "ask";}
    return "valid";
  }
}
