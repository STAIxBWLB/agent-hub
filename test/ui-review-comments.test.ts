import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Node {
  children: Node[] = []; textContent = ""; value = ""; disabled = false; type = ""; dataset: Record<string,string> = {}; attrs: Record<string,string> = {};
  listeners: Record<string, (() => unknown)[]> = {}; onclick?: () => unknown;
  constructor(readonly tag: string) {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, callback: () => unknown) { (this.listeners[key] ??= []).push(callback); }
  all(): Node[] { return [this,...this.children.flatMap(child => child.all())]; }
  text(): string { return [this.textContent,...this.children.map(child => child.text())].join(" "); }
}
const comment = { task: 7, commit: "a".repeat(40), lifecycle: "draft", revision: 1,
  placement: { status: "moved", range: { startLine: 3, endLine: 4 } as {startLine:number;endLine:number}|undefined },
  thread: { id: "comment-1", anchor: { path: "draft.md", side: "head", selectors: [{kind:"lineRange",startLine:1,endLine:2}] }, body: "Person comment", author: "access:person", at: "2026-11-04T00:00:00Z" } };
function page(acon = false, privateTask = false, unavailable = false) {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8"), start = html.indexOf("function reviewCommentsSection("), end = html.indexOf("function taskDetail(",start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const actions: unknown[] = [], material: unknown[] = [], rendered: Record<string,unknown>[] = [];
  let current = true;
  const el = (tag: string,text?: string) => { const node = new Node(tag); node.textContent = text ?? ""; return node; };
  const snapshot = { reviewWritable: acon, reviewComments: { task: 7, counts: {draft:1,sent:0,resolved:0,dismissed:0}, comments: privateTask ? [] : unavailable ? [{id:comment.thread.id,task:7,commit:comment.commit,lifecycle:"draft",revision:1,placement:{status:"unavailable"}}] : [comment] } };
  const section = runInNewContext(`${html.slice(start,end)};reviewCommentsSection({id:7})`, {
    el, boardViewState: { snapshot }, reviewKit: acon ? { snapshot: async (input: unknown) => { material.push(input); return {ok:true,head:"b".repeat(40),doc:{kind:"text",path:"draft.md",text:"file text",contentHash:"c".repeat(64)}}; },render: (input:Record<string,unknown>) => {rendered.push(input);return el("div","kit");} } : null,
    boardContext: () => ({}),sameBoardContext: () => current, selectedProjectId:"project-1",selectedInstanceId:"instance-1",taskDetailId:7,
    boardButton:(text:string,payload:unknown)=>{const node=el("button",text);node.onclick=()=>actions.push(payload);return node;},
    action:(payload:unknown)=>{actions.push(payload);return Promise.resolve(true);},notice:()=>{},
  }) as Node;
  return {html,section,actions,material,rendered,stale:()=>{current=false;}};
}

test("standalone task details list lifecycle/placement and remain read-only, with count-only private data", () => {
  const f=page();expect(f.section.text()).toContain("draft.md:3-4 (moved) / draft");expect(f.section.text()).toContain("Person comment");expect(f.section.text()).toContain("Read-only here");
  const readButtons=f.section.all().filter(node=>node.tag==="button");expect(readButtons.map(node=>node.textContent)).toEqual(["Refresh review comments"]);expect(readButtons.every(node=>!node.dataset.mutation)).toBe(true);
  const pii=page(false,true);expect(pii.section.text()).toContain("1 draft");expect(pii.section.text()).not.toContain("Person comment");expect(pii.section.text()).not.toContain("draft.md");
  expect(f.html).toContain("const reviewKit = null;");
});

test("review comment cache is scoped to project, daemon instance, generation and opaque task review state", () => {
  const html=readFileSync(new URL("../src/ui/index.html",import.meta.url),"utf8"),start=html.indexOf("function reviewCommentsCacheKey("),end=html.indexOf("async function refreshReviewComments(",start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const key=runInNewContext(`${html.slice(start,end)};reviewCommentsCacheKey`,{context:()=>({projectId:"p1",instanceId:"i1",generation:1})}) as (task:unknown,ctx?:unknown)=>string;
  const task={id:7,reviewStateKey:"head-a-owner-a-public-flow-1"},base=key(task,{projectId:"p1",instanceId:"i1",generation:1});
  expect(key(task,{projectId:"p2",instanceId:"i1",generation:1})).not.toBe(base);
  expect(key(task,{projectId:"p1",instanceId:"i2",generation:1})).not.toBe(base);
  expect(key(task,{projectId:"p1",instanceId:"i1",generation:2})).not.toBe(base);
  expect(key({...task,reviewStateKey:"head-b-owner-a-public-flow-1"},{projectId:"p1",instanceId:"i1",generation:1})).not.toBe(base);
});

test("acon selection uses immutable material head, sends via host action, and rejects stale panel callbacks", async () => {
  const f=page(true), input=f.section.all().find(node=>node.tag==="input")!;input.value="draft.md";
  const open=f.section.all().find(node=>node.textContent==="Open review file")!;
  await open.listeners.click![0]!();
  expect(f.material).toEqual([{panel:"review_blob",projectId:"project-1",instanceId:"instance-1",task:7,path:"draft.md",side:"head"}]);
  expect(f.rendered).toHaveLength(1);expect(f.rendered[0]!.threads).toEqual([comment.thread]);
  const onComment=f.rendered[0]!.onComment as (input:unknown)=>Promise<unknown>;
  await onComment({anchor:comment.thread.anchor,body:"new comment"});
  expect(f.actions).toEqual([{action:"review_comment_put",task:7,commit:"b".repeat(40),anchor:comment.thread.anchor,body:"new comment"}]);
  f.stale();await onComment({anchor:comment.thread.anchor,body:"late comment"});expect(f.actions).toHaveLength(1);
  expect(f.section.all().some(node=>node.textContent==="Send draft comments")).toBe(true);
});


test("outdated and unavailable comments never present their stored line range as a current location",()=>{
  const original=comment.placement;
  try {
    for(const status of ["outdated","unavailable"]) {
      comment.placement={status,range:undefined};
      const f=page();expect(f.section.text()).toContain("draft.md ("+status+")");expect(f.section.text()).not.toContain("draft.md:1-2");
    }
  } finally {comment.placement=original;}
});


test("public unavailable stubs retain identity/status and deletion without inventing a file or anchor",()=>{
  const f=page(true,false,true);expect(f.section.text()).toContain("Comment comment-1 (unavailable) / draft");expect(f.section.text()).not.toContain("draft.md");expect(f.section.text()).not.toContain("Person comment");
  expect(f.section.all().some(node=>node.textContent==="Save draft")).toBe(false);
  f.section.all().find(node=>node.textContent==="Delete draft")!.onclick!();
  expect(f.actions).toEqual([{action:"review_comment_delete",task:7,id:"comment-1",revision:1}]);
});
