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
 const document={documentElement:{dataset:{}},get cookie(){if(blocked)throw Error("blocked");return [...cookies].map(([name,value])=>name+"="+value).join("; ")},set cookie(value:string){if(blocked)throw Error("blocked");writes.push(value);const [name,entry]=value.split(";")[0]!.split("=");cookies.set(name!,entry!)},listeners:{} as Record<string,(event:any)=>unknown>,addEventListener(name:string,handler:(event:any)=>unknown){this.listeners[name]=handler},querySelectorAll:(selector:string)=>selector.includes("view-target")?buttons:selector.includes("stack")?[]:sections};
 const preferences=html.match(/<script>([\s\S]*?)<\/script>/)![1];
 const source=html.slice(html.indexOf("// dashboard-navigation-begin"),html.indexOf("// dashboard-navigation-end"));
 const api=runInNewContext(`${preferences};const $=get;const lastSnapshot=null,reachAttention=()=>{},setColumnFocus=()=>{},closeTaskDetail=()=>{};let taskDetailId=null;const signatures=new Map();${source};({initialize:initializeDashboardNavigation,switchView,key:dashboardKey,apply:applyDashboardView,view:()=>currentView,detail:(id)=>{taskDetailId=id;signatures.set("task-detail-content","old")},detailId:()=>taskDetailId,cached:()=>signatures.has("task-detail-content")})`,{document,get});
 api.initialize();return{api,sections,buttons,writes,cookies,get,document};
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

// #469 R2 (AC4): keys 1-7 switch views, ? opens the key list, Esc is the native dialog's own close; typing is never hijacked.
function keyFixture(){
 const f=navigation(),keys=f.get("keys-dialog") as Node&{showModal():void;close():void},detail=f.get("task-detail-dialog");
 let shown=0;keys.showModal=()=>{keys.open=true;shown++};keys.close=()=>{keys.open=false};
 const press=(key:string,extra:Record<string,unknown>={})=>{let prevented=false;const event={key,target:{tagName:"BODY"},preventDefault(){prevented=true},...extra};f.document.listeners.keydown!(event);return prevented};
 return{...f,keys,detail,press,shown:()=>shown};
}
test("keys 1-7 switch the seven views in order and persist the choice (#469 R2 AC4)",()=>{
 const f=keyFixture();expect(f.document.listeners.keydown).toBeTypeOf("function");
 const order=["board","office","stream","agents","message","memory","settings"];
 order.forEach((view,index)=>{expect(f.press(String(index+1))).toBe(true);expect(f.api.view()).toBe(view);expect(f.writes.at(-1)).toBe(`agent-hub-view=${view}; Path=/; Max-Age=31536000; SameSite=Strict`)});
 const writes=f.writes.length;
 // "01", " 1", "1e0" and "0x1" all convert to a valid index with Number(); only a single digit is a view key.
 for(const key of ["0","8","9","a","10","01"," 1","1e0","0x1","1.0","Enter","Tab"]){expect(f.press(key),"key "+JSON.stringify(key)).toBe(false)}
 expect(f.api.view()).toBe("settings");expect(f.writes).toHaveLength(writes);
});
test("view keys are ignored inside an input, a textarea, a select and an editable node, and with a modifier held (#469 R2 AC4)",()=>{
 const f=keyFixture();
 for(const target of [{tagName:"INPUT"},{tagName:"textarea"},{tagName:"SELECT"},{tagName:"DIV",isContentEditable:true}]){
  expect(f.press("3",{target})).toBe(false);expect(f.press("?",{target})).toBe(false);
 }
 for(const modifier of ["ctrlKey","metaKey","altKey"])expect(f.press("3",{[modifier]:true})).toBe(false);
 expect(f.api.view()).toBe("board");expect(f.keys.open).toBe(false);expect(f.writes).toHaveLength(0);
 // The same keys work once focus is on a button or the page.
 expect(f.press("3",{target:{tagName:"BUTTON"}})).toBe(true);expect(f.api.view()).toBe("stream");
});
test("? opens the key list once, an open sheet or task detail stops view keys, and the buttons open and close it (#469 R2 AC4)",()=>{
 const f=keyFixture();
 expect(f.press("?")).toBe(true);expect(f.keys.open).toBe(true);expect(f.shown()).toBe(1);
 f.press("?");expect(f.shown()).toBe(1);
 expect(f.press("4")).toBe(false);expect(f.api.view()).toBe("board");
 f.get("keys-close").handlers.click!();expect(f.keys.open).toBe(false);
 f.get("keys-open").handlers.click!();expect(f.keys.open).toBe(true);f.keys.open=false;
 f.detail.open=true;expect(f.press("4")).toBe(false);expect(f.api.view()).toBe("board");
 f.detail.open=false;expect(f.press("4")).toBe(true);expect(f.api.view()).toBe("agents");
 // Esc is not handled by the page: both sheets are native <dialog>s, which close themselves on Esc.
 expect(html).toMatch(/<dialog id="keys-dialog"/);expect(html).toMatch(/<dialog id="task-detail-dialog"/);
 expect(f.press("Escape")).toBe(false);
});
test("the key list names every key the page handles and the help control is labelled (#469 R2 AC4)",()=>{
 const block=/<dialog id="keys-dialog"[\s\S]*?<\/dialog>/.exec(html)![0];
 for(const text of ["1","7","?","Esc","Switch view","Show this list","Close the open sheet"])expect(block).toContain(text);
 expect(html).toMatch(/id="keys-open"[^>]*aria-label="Keyboard shortcuts"/);expect(html).toMatch(/id="keys-close"[^>]*aria-label="Close shortcuts"/);
});
