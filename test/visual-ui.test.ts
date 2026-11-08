import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { panelAssets } from "../src/ui/plugin.ts";
import { renderDashboard } from "../src/hub/ui.ts";

class Element {
  children: Element[]=[]; textContent=""; className=""; disabled=false; type=""; isConnected=true;
  listeners: Record<string,()=>unknown>={};
  constructor(readonly tagName:string,text?:unknown){if(text!==undefined)this.textContent=String(text);}
  append(...nodes:Element[]){this.children.push(...nodes);}
  replaceChildren(...nodes:Element[]){this.children=[...nodes];}
  addEventListener(name:string,callback:()=>unknown){this.listeners[name]=callback;}
  async click(){await this.listeners.click?.();}
}
function ui(host?: {ui:{visual?:(payload:unknown)=>Element}}, post: (path:string,input:Record<string,unknown>)=>Promise<unknown>=async()=>({})) {
  const script=host?panelAssets().js:renderDashboard().script;
  const start=script.indexOf("function sameVisualContext("),end=script.indexOf("function deliverablesSection(",start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const declaration=host?script.slice(script.indexOf("const visualKit ="),script.indexOf(";",script.indexOf("const visualKit ="))+1):"const visualKit = null;";
  const env={host,stopped:false,viewGeneration:1,selectedProjectId:"p1",selectedInstanceId:"i1",managerMode:true,taskDetailId:7,
    context:():{projectId:string;instanceId:string;generation:number}=>({projectId:env.selectedProjectId,instanceId:env.selectedInstanceId,generation:env.viewGeneration}),
    el:(tag:string,text?:unknown,cls?:string)=>{const node=new Element(tag,text);node.className=cls??"";return node;},post};
  const api=runInNewContext(`${declaration}\n${script.slice(start,end)}\n({visualCard,taskVisualsSection,renderVisualPayload})`,env) as {
    visualCard(stub:Record<string,unknown>):Element;taskVisualsSection(task:{id:number}):Element;renderVisualPayload(mount:Element,payload:unknown):void;
  };
  return{api,env};
}
const payloads=[
  {kind:"mermaid",source:"flowchart TD\nA-->B",title:"Diagram"},
  {kind:"comparison",options:[{title:"A",pros:["one"]},{title:"B",cons:["two"]}]},
  {kind:"table",columns:[{key:"a",label:"A"}],rows:[{a:"cell"}]},
  {kind:"beforeAfter",before:{text:"old"},after:{text:"new"}},
];
for(const payload of payloads)test(`actual acon panel dispatches ${payload.kind} to host.ui.visual unchanged`,()=>{
  const calls:unknown[]=[],{api}=ui({ui:{visual:value=>{calls.push(value);return new Element("kit");}}}),mount=new Element("div");
  api.renderVisualPayload(mount,payload);expect(calls).toEqual([payload]);expect(mount.children[0]!.tagName).toBe("kit");
});
for(const host of [undefined,{ui:{}}])test(`standalone or older kit uses source text with ${host?"old host":"standalone"}`,()=>{
  const {api}=ui(host),mount=new Element("div");api.renderVisualPayload(mount,{kind:"mermaid",source:"flowchart TD\n<img src=x>",title:"<script>bad</script>"});
  expect(mount.children[1]!.tagName).toBe("pre");expect(mount.children[1]!.textContent).toBe("flowchart TD\n<img src=x>");
});
test("renderer error uses fixed source fallback without exposing its error text",()=>{
  const {api}=ui({ui:{visual:()=>{throw Error("private renderer diagnostic");}}}),mount=new Element("div");
  api.renderVisualPayload(mount,payloads[0]);expect(mount.children[0]!.textContent).not.toContain("private renderer diagnostic");expect(mount.children[1]!.tagName).toBe("pre");
});
test("stream card fetches payload on click only, frames untrusted title as text",async()=>{
  const requests:Record<string,unknown>[]=[],calls:unknown[]=[];
  const {api}=ui({ui:{visual:value=>{calls.push(value);return new Element("kit");}}},async(_path,input)=>{requests.push(input);return{ok:true,projectId:"p1",instanceId:"i1",visual:{id:"visual-id",payload:payloads[0]}};});
  const card=api.visualCard({id:"visual-id",title:"<script>title</script>"});
  expect(requests).toEqual([]);expect(card.children[0]!.textContent).toBe("<script>title</script>");
  await card.children[1]!.click();expect(requests).toEqual([{after:0,visual:"visual-id",projectId:"p1",instanceId:"i1"}]);expect(calls).toEqual([payloads[0]]);
});
test("late visual response after project generation change cannot render",async()=>{
  let release:(value:unknown)=>void=()=>{};const answer=new Promise(resolve=>{release=resolve;}),calls:unknown[]=[];
  const {api,env}=ui({ui:{visual:value=>{calls.push(value);return new Element("kit");}}},async()=>answer);
  const card=api.visualCard({id:"visual-id"}),pending=card.children[1]!.click();env.viewGeneration++;env.selectedProjectId="p2";
  release({ok:true,projectId:"p1",instanceId:"i1",visual:{id:"visual-id",payload:payloads[0]}});await pending;
  expect(calls).toEqual([]);expect(card.children[2]!.children).toEqual([]);
});
test("task visual list is metadata only and each card fetches its own payload on demand",async()=>{
  const requests:Record<string,unknown>[]=[],calls:unknown[]=[];
  const {api}=ui({ui:{visual:value=>{calls.push(value);return new Element("kit");}}},async(_path,input)=>{
    requests.push(input);return input.visualTask?{ok:true,projectId:"p1",instanceId:"i1",visuals:[{id:"visual-id",kind:"table",title:"A"}]}:{ok:true,projectId:"p1",instanceId:"i1",visual:{id:"visual-id",payload:payloads[2]}};
  });
  const section=api.taskVisualsSection({id:7});await section.children[1]!.click();expect(calls).toEqual([]);expect(requests[0]!.visualTask).toBe(7);
  const card=section.children[2]!.children[0]!;await card.children[1]!.click();expect(requests[1]!.visual).toBe("visual-id");expect(calls).toEqual([payloads[2]]);
});
