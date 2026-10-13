import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";

test("actual console advertises all characters while full footer resize and off retain the prompt and config",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ahub-pet-runtime-"));mkdirSync(join(root,".agenthub"));
  const config=join(root,".agenthub/config.json"),raw=JSON.stringify({pet:{size:"full",glyphs:"ascii"}});writeFileSync(config,raw);
  let output="",key=(_value:string)=>{},stop=()=>{},resize=()=>{};
  const terminal:ConsoleTerminal={columns:120,rows:40,isTTY:true,write:text=>{output+=text},raw:()=>{},onData:fn=>{key=fn;return()=>{}},onSignal:fn=>{stop=fn;return()=>{}},onResize:fn=>{resize=fn;return()=>{}}};
  const requests:string[]=[];const client={request:async(m:{t:string})=>{requests.push(m.t);return{}},send:()=>{},close:()=>{},onPush:()=>{},onClose:()=>{}};
  const running=runConsole({cwd:root,stateDir:root,terminal,client,color:false});
  try{
    expect(output).toContain("STAI");expect(output).toContain("\x1b[1;31r");
    output="";key("P");expect(output).toContain("|<>");
    output="";key("P");expect(output).toContain("/||\\");
    output="";key("P");expect(output).toContain("/\\_/\\");
    output="";key("P");expect(output).toContain("o-|------|-o");
    output="";key("P");expect(output).toContain("\x1b[1;36r");
    for(let row=32;row<=36;row++)expect(output).toContain(`\x1b[${row};1H\x1b[2K`);
    output="";key("P");expect(output).toContain("STAI");
    terminal.columns=80;terminal.rows=24;output="";resize();expect(output).toContain("(O O) z asleep");expect(output).toContain("\x1b[1;20r");
    output="";key("?");expect(output).toContain("P next character/off");
    expect(readFileSync(config,"utf8")).toBe(raw);
    expect(requests.every(t=>["status","budget"].includes(t))).toBe(true);
  }finally{stop();await running;rmSync(root,{recursive:true});}
});
