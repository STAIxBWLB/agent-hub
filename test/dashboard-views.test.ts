import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
class Node {
 children:Node[]=[];replaceChildren(){this.children=[]}
 open=false;hidden=false;dataset:Record<string,string>={};attrs:Record<string,string>={};handlers:Record<string,()=>void>={};textContent="";
 setAttribute(name:string,value:string){this.attrs[name]=value}removeAttribute(name:string){delete this.attrs[name]}
 addEventListener(name:string,handler:()=>void){this.handlers[name]=handler}
}
function navigation(saved="",blocked=false){
 const cookies=new Map<string,string>(saved.split("; ").filter(Boolean).map(item=>item.split("=") as [string,string])),writes:string[]=[];
 const sections=["board","office","stream","agents","agents","message","memory","settings"].map(view=>{const node=new Node();node.dataset.view=view;return node});
 const buttons=["board","office","stream","agents","message","memory","settings"].map(view=>{const node=new Node();node.dataset.viewTarget=view;return node});
 const nodes=new Map<string,Node>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)!};
 const document={documentElement:{dataset:{}},get cookie(){if(blocked)throw Error("blocked");return [...cookies].map(([name,value])=>name+"="+value).join("; ")},set cookie(value:string){if(blocked)throw Error("blocked");writes.push(value);const [name,entry]=value.split(";")[0]!.split("=");cookies.set(name!,entry!)},querySelectorAll:(selector:string)=>selector.includes("view-target")?buttons:selector.includes("stack")?[]:sections};
 const preferences=html.match(/<script>([\s\S]*?)<\/script>/)![1];
 const source=html.slice(html.indexOf("// dashboard-navigation-begin"),html.indexOf("// dashboard-navigation-end"));
 const api=runInNewContext(`${preferences};const $=get;const lastSnapshot=null,reachAttention=()=>{},setColumnFocus=()=>{},closeTaskDetail=()=>{};let taskDetailId=null;const signatures=new Map();${source};({initialize:initializeDashboardNavigation,switchView,apply:applyDashboardView,view:()=>currentView,detail:(id)=>{taskDetailId=id;signatures.set("task-detail-content","old")},detailId:()=>taskDetailId,cached:()=>signatures.has("task-detail-content")})`,{document,get});
 api.initialize();return{api,sections,buttons,writes,cookies,get};
}
test("dashboard navigation switches only matching sections and persists its selected view (#391)",()=>{
 const f=navigation();expect(f.api.view()).toBe("board");
 for(const view of ["office","stream","agents","message","memory","settings","board"]){
  f.buttons.find(button=>button.dataset.viewTarget===view)!.handlers.click!();
  expect(f.sections.map(section=>section.hidden)).toEqual(f.sections.map(section=>section.dataset.view!==view));
  expect(f.buttons.filter(button=>button.attrs['aria-current']==="page").map(button=>button.dataset.viewTarget)).toEqual([view]);
  expect(f.writes.at(-1)).toBe(`agent-hub-view=${view}; Path=/; Max-Age=31536000; SameSite=Strict`);
 }
 f.api.switchView("memory");const reload=navigation([...f.cookies].map(([key,value])=>key+"="+value).join("; "));expect(reload.api.view()).toBe("memory");expect(reload.sections.find(section=>section.dataset.view==="memory")!.hidden).toBe(false);
});
test("dashboard view preferences reject unknown values and tolerate blocked cookies (#391)",()=>{
 const invalid=navigation("agent-hub-view=unknown; agent-hub-column-focus=unknown");expect(invalid.api.view()).toBe("board");
 invalid.api.switchView("unknown");expect(invalid.api.view()).toBe("board");
 const blocked=navigation("",true);expect(()=>blocked.api.switchView("agents")).not.toThrow();expect(blocked.api.view()).toBe("agents");
});
test("dashboard views retain one snapshot poll and ticket-only hash with CSP-safe controls (#391)",()=>{
 expect([...html.matchAll(/data-view-target="([^"]+)"/g)].map(match=>match[1])).toEqual(["board","office","stream","agents","message","memory","settings"]);
 const source=html.slice(html.indexOf("// dashboard-navigation-begin"),html.indexOf("// dashboard-navigation-end"));
 expect(source).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|fetch\(|post\(|location\.hash|history\./);
 expect(html).not.toMatch(/\sstyle="|\son[a-z]+="/i);
 expect(html).toContain('<dialog id="task-detail-dialog"');
 expect(html.match(/setTimeout\(poll, 1000\)/g)).toHaveLength(2);
 expect(html.match(/setTimeout\(/g)).toHaveLength(5);
 expect(html).not.toContain("setInterval(");
});


test("native dialog close clears cached detail content and selected task (#391)",()=>{
 const f=navigation();f.api.detail(4);f.get("task-detail-content").children.push(new Node());
 const dialog=f.get("task-detail-dialog"),content=f.get("task-detail-content").children;dialog.open=true;dialog.handlers.close!();
 expect(f.get("task-detail-content").children).toBe(content);expect(f.api.detailId()).toBe(4);expect(f.api.cached()).toBe(true);
 dialog.open=false;dialog.handlers.close!();
 expect(f.get("task-detail-content").children).toHaveLength(0);expect(f.api.detailId()).toBeNull();expect(f.api.cached()).toBe(false);
});
