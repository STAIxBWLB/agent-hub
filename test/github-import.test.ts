import { expect,test } from "bun:test";
import {readGitHubImport} from "../src/hub/github-import.ts";
import type {SdlcGh} from "../src/hub/sdlc.ts";
const issue=(number:number)=>({number,title:`issue ${number}`,body:"bounded body",url:`https://github.com/Owner/Repo/issues/${number}`,state:"OPEN"});
test("GitHub import selects only fixed readonly argv and reports bounded pages (#263)",async()=>{
  const calls:string[][]=[];const run:SdlcGh=async(args)=>{calls.push(args);return {code:0,stdout:JSON.stringify(args[0]==="repo"?{nameWithOwner:"Owner/Repo"}:Array.from({length:33},(_,i)=>issue(i+1)))};};
  const result=await readGitHubImport({label:"ready work",milestone:"phase one"},run);expect(result.issues).toHaveLength(32);expect(result.partial).toBe(true);expect(result.issues[0]?.source).toMatchObject({provider:"github",repo:"owner/repo",issue:1});
  expect(calls).toEqual([["repo","view","--json","nameWithOwner"],["issue","list","--repo","Owner/Repo","--state","open","--label","ready work","--milestone","phase one","--limit","33","--json","number,title,body,url,state"]]);
});
test("GitHub import refuses malformed selections identities duplicates and oversized pages (#263)",async()=>{
  let reads=0;const run:SdlcGh=async()=>{reads++;return {code:0,stdout:"[]"};};
  for(const input of [{repo:"--bad",label:"ready"},{repo:"Owner/Repo",label:"--write"},{repo:"Owner/Repo",label:"ready\nclose"},{repo:"Owner/Repo",label:"ready",milestone:"--bad"}])await expect(readGitHubImport(input,run)).rejects.toThrow();expect(reads).toBe(0);
  for(const page of [[{...issue(1),url:"https://example.com/secret"}],[issue(1),issue(1)],[{...issue(1),state:"CLOSED"}],Array.from({length:34},(_,i)=>issue(i+1)),[{...issue(1),body:"x".repeat(8001)}]])await expect(readGitHubImport({repo:"Owner/Repo",label:"ready"},async()=>({code:0,stdout:JSON.stringify(page)}))).rejects.toThrow();
  await expect(readGitHubImport({repo:"Owner/Repo",label:"ready"},async()=>({code:1,stdout:"secret diagnostic"}))).rejects.toThrow("read failed");
});


test("GitHub import selection is captured before repository resolution awaits (#263)",async()=>{
 const selection={label:"approved",milestone:"first"},calls:string[][]=[];
 const result=await readGitHubImport(selection,async args=>{calls.push(args);if(args[0]==="repo"){selection.label="--mutated";selection.milestone="changed";return {code:0,stdout:JSON.stringify({nameWithOwner:"Owner/Repo"})};}return {code:0,stdout:JSON.stringify([issue(1)])};});
 expect(result.issues).toHaveLength(1);expect(calls[1]).toContain("approved");expect(calls[1]).toContain("first");expect(calls[1]).not.toContain("--mutated");expect(calls[1]).not.toContain("changed");
});

test("GitHub intake accepts maximum escaped sentinel pages within a bounded reader",async()=>{
 const rows=Array.from({length:33},(_,i)=>({...issue(i+1),title:"x".repeat(300),body:String.fromCharCode(1).repeat(8000)}));const stdout=JSON.stringify(rows);expect(new TextEncoder().encode(stdout).length).toBeGreaterThan(256*1024);const bounds:number[]=[];
 const result=await readGitHubImport({repo:"Owner/Repo",label:"ready"},async(_args,_timeout,_cwd,bound)=>{bounds.push(bound!);return {code:0,stdout}}).catch(()=>null);expect(result).not.toBeNull();if(!result)return;expect(result.issues).toHaveLength(32);expect(result.partial).toBe(true);expect(bounds).toEqual([2*1024*1024]);
});

test("GitHub intake rejects comma labels before the StringSlice CLI can broaden selection",async()=>{
 let calls=0;await expect(readGitHubImport({repo:"Owner/Repo",label:"priority, high"},async()=>{calls++;return {code:0,stdout:"[]"}})).rejects.toThrow("selection");expect(calls).toBe(0);
});
