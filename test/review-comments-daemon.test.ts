import type { ReviewAnchor } from "../src/hub/review-anchor.ts";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { Board } from "../src/hub/board.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { DOING_STUB } from "../src/hub/peer-doing.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { gitProject } from "./fakes/git-project.ts";

class ReviewOwner extends BasePeer {
  got: Envelope[] = [];
  echo = false;
  afterDelivery?: () => void;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.got.push(...envs); if (this.echo) this.onMessage?.("OWNER_ECHO_CANARY " + envs[0]!.body, { to: ["user"], inReplyTo: envs[0] }); this.afterDelivery?.(); }
}
async function fixture(reviewMaterialsGh?: import("../src/hub/sdlc.ts").SdlcGh) {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-review-comments-"))), stateDir = join(cwd, "state");
  gitProject(cwd);
  const text = "REVIEW_QUOTE_CANARY\nSecond paragraph\n";
  writeFileSync(join(cwd, "report.md"), text); writeFileSync(join(cwd, "outside.md"), "outside task");
  for (const args of [["add", "report.md", "outside.md"], ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "-qm", "documents"]]) {
    expect(hubGitSync(["-C", cwd, ...args], { encoding: "utf8", timeout: 5000 }).status).toBe(0);
  }
  const head = hubGitSync(["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }).stdout.trim();
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/routing.toml"), readFileSync(new URL("../templates/routing.toml", import.meta.url), "utf8").replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"').replace('pii_screen = "local"', 'pii_screen = "off"'));
  const daemon = await startDaemon({ cwd, stateDir, projectId: "review-comment-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, reviewMaterialsGh,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, roles: { codex: ["implementer"], claude: ["conductor"] },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] } } });
  const board = new Board(join(stateDir, "hub.db"));
  const row = board.propose("user", { title: "Review document", class: "test", refs: { paths: ["report.md"], commit: head } });
  board.update(row.id, "user", "fixture", { owner: "codex", state: "in_progress" });
  const owner = new ReviewOwner("codex"); daemon.bus.add(owner); await owner.start();
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  const peer = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: cwd });
  const conductor = await ControlClient.connect(stateDir, { role: "tools", peer: "claude", projectRoot: cwd });
  const anchor: ReviewAnchor = { path: "report.md", side: "head", contentHash: createHash("sha256").update(text).digest("hex"), selectors: [{ kind: "lineRange", startLine: 1, endLine: 1 }, { kind: "textQuote", exact: "REVIEW_QUOTE_CANARY", prefix: "", suffix: "" }] };
  return { cwd, stateDir, daemon, board, owner, person, peer, conductor, task: row.id, head, anchor,
    stop: async () => { person.close(); peer.close(); conductor.close(); board.close(); await daemon.stop(); rmSync(cwd, { recursive: true, force: true }); } };
}

test("real console drafts are silent, send is one private-observer capsule, and every non-console write is refused", async () => {
  const f = await fixture();
  try {
    const packets: Envelope[] = [];
    let forgedPublication:Envelope|undefined;
    f.daemon.bus.tap(event => { if(event.t === "envelope" && event.env.body === "UNMARKED_FORGED_REVIEW")forgedPublication=event.env; if (event.t === "envelope" && event.env.refs?.reviewPackage) packets.push(event.env); });
    const ids: string[] = [];
    // Tools cannot borrow the console send operation, and hub_send is not a task operation.
    expect(await f.peer.request({t:"send",to:["user"],body:"REFUSED_FORGED_REVIEW"})).toMatchObject({ok:false});
    expect(await f.peer.request({t:"task",op:"hub_send",args:{to:["user"],text:"REFUSED_FORGED_REVIEW",kind:"review",refs:{reviewPackage:"forged:package",reviewResponse:"forged:response"}}})).toMatchObject({ok:false});
    // The actual native-peer publication callback must strip both forged observer markers.
    f.owner.onMessage?.("UNMARKED_FORGED_REVIEW",{to:["user"],kind:"review",refs:{reviewPackage:"forged:package",reviewResponse:"forged:response"}});
    expect(packets).toEqual([]);
    expect(forgedPublication).toBeDefined();expect(forgedPublication!.body).toBe("UNMARKED_FORGED_REVIEW");
    expect(forgedPublication!.refs).not.toHaveProperty("reviewPackage");expect(forgedPublication!.refs).not.toHaveProperty("reviewResponse");
    expect(readFileSync(join(f.stateDir,"hub.log"),"utf8")).toContain("UNMARKED_FORGED_REVIEW");
    expect(readFileSync(join(f.stateDir,"hub.log"),"utf8")).not.toContain("REFUSED_FORGED_REVIEW");
    for (let i = 0; i < 3; i++) {
      const result = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "REVIEW_BODY_CANARY " + i, personMeta: { identity: "access:person", node: "console-node", via: "console" } });
      expect(result.ok).toBe(true); expect(Number.isSafeInteger(result.rid)).toBe(true); ids.push(result.id);
    }
    expect(packets).toEqual([]); expect(f.owner.got).toEqual([]);
    const list = await f.person.request({ t: "review_comments", task: f.task });
    expect(list.counts).toMatchObject({ draft: 3, sent: 0 });
    expect(list.comments.map((view: { thread: { author: string } }) => view.thread.author)).toEqual(["access:person", "access:person", "access:person"]);
    for (const actor of [f.peer, f.conductor]) for (const t of ["review_comment_put", "review_comment_delete", "review_comment_send"]) {
      const denied = await actor.request({ t, task: f.task, id: ids[0], revision: 1, commit: f.head, anchor: f.anchor, body: "forged" });
      expect(denied.ok).toBe(false); expect(Number.isSafeInteger(denied.rid)).toBe(true);
    }
    const spoof = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "forged", author: "forged" });
    expect(spoof.ok).toBe(false);
    expect((await f.person.request({ t: "review_comments", task: f.task })).counts).toEqual(list.counts);
    const tail: unknown[] = [];
    let echoed!: () => void, tailed!: () => void, echo: Envelope | undefined;
    const echoSeen=new Promise<void>(resolve=>{echoed=resolve;}), tailSeen=new Promise<void>(resolve=>{tailed=resolve;});
    f.daemon.bus.tap(event=>{if(event.t==="envelope" && event.env.from==="codex" && event.env.refs?.reviewResponse){echo=event.env;echoed();}});
    f.person.onPush = message => { tail.push(message); if(message.e?.env?.refs?.reviewResponse)tailed(); };
    f.person.send({ t: "tail" });
    f.owner.echo = true;
    const sent = await f.person.request({ t: "review_comment_send", task: f.task, ids });
    expect(sent).toMatchObject({ ok: true, count: 3 });
    await Promise.all([echoSeen,tailSeen]);
    expect(echo!.body).toContain("OWNER_ECHO_CANARY");expect(echo!.body).toContain("REVIEW_BODY_CANARY");expect(echo!.private).not.toBe(true);
    expect(packets).toHaveLength(1); expect(packets[0]).toMatchObject({ from: "hub", kind: "review", to: ["codex"] });
    expect(packets[0]!.private).not.toBe(true);
    for (let i = 0; i < 3; i++) expect(packets[0]!.body).toContain("REVIEW_BODY_CANARY " + i);
    const snapshot = await f.person.request({ t: "ui_snapshot", view: "board", reviewTask: f.task });
    expect(snapshot.reviewComments.counts).toMatchObject({ draft: 0, sent: 3 });
    const audit = readFileSync(join(f.stateDir, "hub.log"), "utf8") + readFileSync(join(f.stateDir, "events.jsonl"), "utf8");
    expect(audit).not.toContain("REVIEW_BODY_CANARY"); expect(audit).not.toContain("REVIEW_QUOTE_CANARY"); expect(audit).not.toContain("OWNER_ECHO_CANARY");
    expect(JSON.stringify(tail)).not.toContain("REVIEW_BODY_CANARY"); expect(JSON.stringify(tail)).not.toContain("OWNER_ECHO_CANARY");
    expect(JSON.stringify(snapshot.events)).not.toContain("OWNER_ECHO_CANARY");
    f.owner.onDoing?.("todo", "REVIEW_PLAN_CALLBACK_CANARY");
    expect((await f.person.request({t:"status"})).status.peers.codex.doing.text).toBe(DOING_STUB);
    const peerStatus = await f.peer.request({t:"status"});
    expect(peerStatus.status.peers.codex.doing.text).toBe(DOING_STUB);
    expect(JSON.stringify(peerStatus)).not.toContain("REVIEW_PLAN_CALLBACK_CANARY");
    f.owner.echo=false;
    const normalDelivered=new Promise<void>(resolve=>{f.owner.afterDelivery=resolve;});
    f.daemon.bus.publish(newEnvelope("user","normal next request",{to:["codex"],priority:"important"}));
    await normalDelivered;
    expect((await f.person.request({t:"status"})).status.peers.codex.doing.text).toBe(DOING_STUB);
    expect(JSON.stringify(f.board.get(f.task)!.history)).toContain("person review comments sent (3)");
  } finally { await f.stop(); }
});

test("review_blob reads immutable declared files and refuses out-of-scope, metadata and tool callers", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.cwd, "report.md"), "DIRTY_WORKTREE_CANARY");
    const read = await f.person.request({ t: "review_blob", task: f.task, path: "report.md", side: "head" });
    expect(read).toMatchObject({ ok: true, head: f.head, doc: { path: "report.md", text: "REVIEW_QUOTE_CANARY\nSecond paragraph\n" } });
    expect(JSON.stringify(read)).not.toContain("DIRTY_WORKTREE_CANARY");
    for (const path of ["outside.md", "../report.md", ".git/config"]) expect(await f.person.request({ t: "review_blob", task: f.task, path, side: "head" })).toMatchObject({ ok: false });
    expect(await f.peer.request({ t: "review_blob", task: f.task, path: "report.md", side: "head" })).toMatchObject({ ok: false });
    const row = f.board.propose("user", { title: "private review", class: "test", signals: ["pii"], refs: { paths: ["report.md"], commit: f.head } });
    expect(await f.person.request({ t: "review_blob", task: row.id, path: "report.md", side: "head" })).toMatchObject({ ok: false });
    expect((await f.person.request({ t: "review_comments", task: row.id })).comments).toEqual([]);
  } finally { await f.stop(); }
});


test("a same-owner replan while PR evidence is awaited revokes the old review material read", async () => {
  let enter!: () => void, release!: () => void, head = "";
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async (args, timeout) => {
    expect(timeout).toBeGreaterThan(0); expect(timeout).toBeLessThanOrEqual(8000);
    if (args[0] === "pr") { enter(); await held; return { code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: [], files: [{path:"report.md",changeType:"MODIFIED"}], changedFiles: 1, baseRefOid: head }) }; }
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head, reviewThreads: { nodes: [], pageInfo: {hasNextPage:false} } } } } }) };
  });
  head = f.head;
  try {
    f.board.update(f.task,"user","fixture PR receipt",{sdlc:{stage:"review",repo:"fixture/repository",pr:1}});
    const reading = f.person.request({t:"review_blob",task:f.task,path:"report.md",side:"head"});
    await entered;
    const current=f.board.get(f.task)!;
    f.board.update(f.task,"user","replan removes file",{refs:{...current.refs,paths:["outside.md"]}});
    release();
    const reply=await reading;
    expect(reply).toMatchObject({ok:false});
    expect(JSON.stringify(reply)).not.toContain("REVIEW_QUOTE_CANARY");
    expect(reply).not.toHaveProperty("doc");
  } finally {release();await f.stop();}
});


test("PII console comments save on the board and send one stub without exposing quote or body", async () => {
  const f=await fixture();
  try {
    const task=f.board.propose("user",{title:"private review",class:"test",signals:["pii"],refs:{paths:["report.md"],commit:f.head}});
    f.board.update(task.id,"user","fixture private owner",{owner:"codex",state:"in_progress"});
    const saved=await f.person.request({t:"review_comment_put",task:task.id,commit:f.head,anchor:f.anchor,body:"PII_REVIEW_BODY_CANARY"});
    expect(saved.ok).toBe(true);
    const publicRead=await f.person.request({t:"review_comments",task:task.id});
    expect(publicRead.counts).toMatchObject({draft:1});expect(publicRead.comments).toEqual([]);
    const sent:Envelope[]=[];f.daemon.bus.tap(event=>{if(event.t==="envelope" && event.env.refs?.reviewPackage)sent.push(event.env);});
    expect(await f.person.request({t:"review_comment_send",task:task.id,ids:[saved.id]})).toMatchObject({ok:true,count:1});
    expect(sent).toHaveLength(1);expect(sent[0]!.body).not.toContain("PII_REVIEW_BODY_CANARY");expect(sent[0]!.body).not.toContain("REVIEW_QUOTE_CANARY");
    expect(sent[0]!.body.toLowerCase()).toContain("private");
    const stored=f.board.reviewComments(task.id,task.created);expect(JSON.stringify(stored)).toContain("PII_REVIEW_BODY_CANARY");
    const wire=JSON.stringify(await f.person.request({t:"ui_snapshot",view:"board",reviewTask:task.id}));
    expect(wire).not.toContain("PII_REVIEW_BODY_CANARY");expect(wire).not.toContain("REVIEW_QUOTE_CANARY");
  } finally {await f.stop();}
});

test("a real owner refile stages head B before Board commit A changes and carries the anchored finding as moved", async () => {
  const f=await fixture();
  try {
    f.board.update(f.task,"user","fixture reviewer",{reviewer:"claude"});
    const doneA=await f.peer.request({t:"task",op:"hub_task_done",args:{id:f.task,summary:"Document ready at A",refs:{commit:f.head}}});
    expect(doneA.ok).toBe(true);expect(f.board.get(f.task)!.state).toBe("in_review");
    const finding={id:"moved-paragraph",pass:"bugs",severity:"important",disposition:"open",path:"report.md",anchor:f.anchor};
    const review=await f.conductor.request({t:"task",op:"hub_review",args:{id:f.task,head:f.head,verdict:"changes_requested",note:"Move the paragraph",findings:[finding]}});
    expect(review.ok).toBe(true);expect(f.board.get(f.task)!.state).toBe("in_progress"); // existing review auto-reopens its owner
    expect((await f.peer.request({t:"task",op:"hub_task_accept",args:{id:f.task}})).ok).toBe(true);
    writeFileSync(join(f.cwd,"report.md"),"New introduction\nREVIEW_QUOTE_CANARY\nSecond paragraph\n");
    for(const args of [["add","report.md"],["-c","user.name=fixture","-c","user.email=fixture@localhost","-c","commit.gpgsign=false","commit","-qm","move paragraph"]]) expect(hubGitSync(["-C",f.cwd,...args],{encoding:"utf8",timeout:5000}).status).toBe(0);
    const next=hubGitSync(["-C",f.cwd,"rev-parse","HEAD"],{encoding:"utf8",timeout:5000}).stdout.trim();
    expect(next).not.toBe(f.head);expect(f.board.get(f.task)!.refs.commit).toBe(f.head);
    const requests:Envelope[]=[];
    f.daemon.bus.tap(event=>{if(event.t==="envelope" && event.env.kind==="review" && event.env.to?.includes("claude") && event.env.refs?.task===String(f.task))requests.push(event.env);});
    const doneB=await f.peer.request({t:"task",op:"hub_task_done",args:{id:f.task,summary:"Moved the paragraph at B",refs:{commit:next}}});
    expect(doneB.ok).toBe(true);expect(f.board.get(f.task)!.refs.commit).toBe(next);
    expect(requests).toHaveLength(1);expect(requests[0]!.body).toContain("report.md:2-2");expect(requests[0]!.body).toContain("(moved)");
    const retained=f.board.get(f.task)!.history.findLast(entry=>entry.reviewFindings)?.reviewFindings?.items.find(item=>item.id===finding.id);
    expect(retained!.anchor).toEqual(f.anchor);
  } finally {await f.stop();}
});
