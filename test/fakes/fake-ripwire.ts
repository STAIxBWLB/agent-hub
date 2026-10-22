#!/usr/bin/env bun
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
const args=process.argv.slice(2),mode=process.env.FAKE_RIPWIRE_MODE;
if(process.env.FAKE_RIPWIRE_RECORD)appendFileSync(process.env.FAKE_RIPWIRE_RECORD,JSON.stringify({cwd:process.cwd(),args})+"\n");
if(args.includes("--version")){console.log(`ripwire ${mode === "version" ? "9.9.9" : "0.6.7"} (fake)`);process.exit(0);}
if(mode === "orphan"){const child=spawn("sleep",["30"],{stdio:"ignore"});if(process.env.FAKE_RIPWIRE_CHILD)appendFileSync(process.env.FAKE_RIPWIRE_CHILD,String(child.pid));process.exit(0);}
if(mode === "timeout"){const child=spawn("sleep",["30"]);if(process.env.FAKE_RIPWIRE_CHILD)appendFileSync(process.env.FAKE_RIPWIRE_CHILD,String(child.pid));await Bun.sleep(30000);}
if(mode === "overflow"){process.stdout.write("x".repeat(512*1024));await Bun.sleep(30000);}
if(mode === "error")process.exit(1);
// A real Git read would execute an inherited clean filter unless the host disabled it.
spawnSync("git",["diff","--no-ext-diff","HEAD","--"],{cwd:process.cwd(),env:process.env,stdio:"ignore"});
const head=spawnSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim(),base=args.find(a=>a.startsWith("--pr-context="))?.split("=")[1];
if(base){
 const captured=readFileSync(new URL("../fixtures/ripwire-0.6.7-pr-context.xml",import.meta.url),"utf8")
   .replaceAll("2eae20407ce85bb5c8c6380d6f88c82e5442dea7",base).replaceAll("2eae20407",base.slice(0,9)).replaceAll("a90f325b7",head.slice(0,9)).replaceAll("/fixture/repo",process.cwd());
 console.log(mode === "subset" ? captured.replace('symbols="2"','symbols="3"') : mode === "schema" ? captured.replaceAll("ripwire.pr-context/v1","bad/v1") : mode === "truncated" ? captured.replace('truncated="none"','truncated="symbols"') : captured);
}else if(args.some(a=>a.startsWith("--at="))){console.log('<at schema="ripwire.at/v1" p="a.ts" l="1" sym="retained" chain="1"><s n="retained" t="fn" l="1" el="3"/></at>');}
else {
 const flag=args.find(a=>a.startsWith("--callers=")||a.startsWith("--callees="))!,kind=flag.startsWith("--callers=")?"callers":"callees",name=flag.split("=")[1]!;
 if((name === "missing" || name === "untracked" && !existsSync("untracked.ts"))){console.log(`<callers schema="ripwire.callers/v1" of="${name}" found="0"/>`);process.exit(1);}
 if(!args.includes("--json")){console.log(`<callers schema="ripwire.callers/v1" of="${name}" defs="1" count="0"/>`);}
 else console.log(JSON.stringify({of:name,defs:1,count:1,root:process.cwd(),...(mode === "json-schema"?{}:{hop_tested:0}),hop_untested:1,graph_ambiguous:0,graph_unresolved:0,counts_floor:true,[kind]:[{t:"fn",n:kind === "callers"?"caller":"callee",p:"a.ts:1",...(mode === "name"?{via:"name"}:{})}]}));
}
