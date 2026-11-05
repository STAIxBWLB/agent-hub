import type { ReviewAnchor } from "../src/hub/review-anchor.ts";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { Board } from "../src/hub/board.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { DOING_STUB } from "../src/hub/peer-doing.ts";
import { renderHeldHint } from "../src/hub/delivery-hints.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { claudeStateFile } from "../src/hub/claude-state.ts";
import { gitProject } from "./fakes/git-project.ts";

class ReviewOwner extends BasePeer {
  readonly nativeSession?: string;
  got: Envelope[] = [];
  echo = false;
  afterDelivery?: () => void;
  deliveryGate?: Promise<void>;
  steerGate?: Promise<void>;
  steered: Envelope[] = [];
  steer?: (envs: Envelope[], deliveryId?: string) => Promise<void>;
  constructor(id: string, readonly pullOnly = false, withSteer = false, nativeSession?: string) {
    super(id);
    this.nativeSession = nativeSession;
    if (withSteer) this.steer = async (envs, deliveryId) => { this.steered.push(...envs); this.afterDelivery?.(); if (this.steerGate) await this.steerGate; if (deliveryId) this.delivery({ id: deliveryId, state: "completed", reason: "synthetic owner consumed steer" }); };
  }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  markBusy() { this.setState("busy"); }
  markIdle() { this.setState("idle"); }
  async deliver(envs: Envelope[], deliveryId?: string) { this.got.push(...envs); if (this.echo) this.onMessage?.("OWNER_ECHO_CANARY " + envs[0]!.body, { to: ["user"], inReplyTo: envs[0] }); this.afterDelivery?.(); if (this.deliveryGate) await this.deliveryGate; if (deliveryId) this.delivery({ id: deliveryId, state: "completed", reason: "synthetic owner consumed delivery" }); }
}
class PiTitleOwner extends ReviewOwner {
  constructor(withSteer = false, nativeSession = "fixture-pi-native-session") { super("pi", false, withSteer, nativeSession); }
  get titleSession() { return "pi-title-session"; }
  get sessionTitle() { return ""; }
}
async function fixture(reviewMaterialsGh?: import("../src/hub/sdlc.ts").SdlcGh, pullOnly = false, withSteer = false) {
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
  const config = { ...DEFAULT_CONFIG, batch_ms: 0, roles: { codex: ["implementer"], claude: ["conductor"] },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] } };
  const daemonOptions = () => ({ cwd, stateDir, projectId: "review-comment-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, reviewMaterialsGh, config });
  let daemon = await startDaemon(daemonOptions());
  let board = new Board(join(stateDir, "hub.db"));
  const row = board.propose("user", { title: "Review document", class: "test", refs: { paths: ["report.md"], commit: head } });
  board.update(row.id, "user", "fixture", { owner: "codex", state: "in_progress" });
  let owner = new ReviewOwner("codex", pullOnly, withSteer, "fixture-native-session"); daemon.bus.add(owner); await owner.start();
  let person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  let peer = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: cwd });
  let conductor = await ControlClient.connect(stateDir, { role: "tools", peer: "claude", projectRoot: cwd });
  const identity = await person.request({ t: "status" });
  writeFileSync(join(stateDir, claudeStateFile("claude-session", "claude")), JSON.stringify({ instanceId: identity.status.instanceId, sessionId: "fixture-claude-session", launchId: "fixture-claude-launch" }));
  const anchor: ReviewAnchor = { path: "report.md", side: "head", contentHash: createHash("sha256").update(text).digest("hex"), selectors: [{ kind: "lineRange", startLine: 1, endLine: 1 }, { kind: "textQuote", exact: "REVIEW_QUOTE_CANARY", prefix: "", suffix: "" }] };
  return { cwd, stateDir, get daemon() { return daemon; }, get board() { return board; }, get owner() { return owner; }, get person() { return person; }, get peer() { return peer; }, get conductor() { return conductor; }, task: row.id, head, anchor,
    restartNative: async (nativeSession = "same-native-session") => {
      person.close(); peer.close(); conductor.close(); board.close(); await daemon.stop();
      daemon = await startDaemon(daemonOptions()); board = new Board(join(stateDir, "hub.db"));
      owner = new ReviewOwner("codex", pullOnly, withSteer, nativeSession); daemon.bus.add(owner); await owner.start();
      person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
      peer = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: cwd });
      conductor = await ControlClient.connect(stateDir, { role: "tools", peer: "claude", projectRoot: cwd });
      const currentIdentity = await person.request({ t: "status" });
      const claudeSessionFile = join(stateDir, claudeStateFile("claude-session", "claude"));
      let claudeSessionState: Record<string, unknown> = { sessionId: "fixture-claude-session", launchId: "fixture-claude-launch" };
      try { claudeSessionState = JSON.parse(readFileSync(claudeSessionFile, "utf8")) as Record<string, unknown>; } catch { /* the fixture starts a fresh session identity below */ }
      writeFileSync(claudeSessionFile, JSON.stringify({ ...claudeSessionState, instanceId: currentIdentity.status.instanceId }));
    },
    stop: async () => { person.close(); peer.close(); conductor.close(); board.close(); await daemon.stop(); rmSync(cwd, { recursive: true, force: true }); } };
}

function proposeOwnedTask(board: Board, owner: string, task: Parameters<Board["propose"]>[1]) {
  const row = board.propose("user", task);
  return board.update(row.id, "user", "fixture owner", { owner });
}

function waitForDelivery(owner: ReviewOwner): Promise<void> {
  const previous = owner.onDelivery;
  return new Promise<void>(resolve => {
    owner.onDelivery = receipt => {
      previous?.(receipt);
      if (receipt.state !== "completed") return;
      owner.onDelivery = previous;
      resolve();
    };
  });
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
    const snapshot = await f.person.request({ t: "ui_snapshot", view: "board", reviewTask: f.task, reviewRefresh: true });
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

test("periodic snapshots do not resolve review comments; explicit refresh isolates a comment-list race", async () => {
  let enter!: () => void, release!: () => void, holdOnce = true;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async args => {
    if (args[0] === "pr" && holdOnce) { holdOnce = false; enter(); await held; }
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: f.head, state: "OPEN", statusCheckRollup: [], files: [{ path: "report.md", changeType: "MODIFIED" }], changedFiles: 1, baseRefOid: f.head }) };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: f.head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
  });
  try {
    const draft = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "snapshot race" });
    expect(draft.ok).toBe(true);
    f.board.update(f.task, "user", "fixture PR", { sdlc: { stage: "review", repo: "fixture/repository", pr: 1 } });
    const periodic = await f.person.request({ t: "ui_snapshot", view: "board", reviewTask: f.task });
    expect(periodic).toHaveProperty("status");
    expect(periodic).not.toHaveProperty("reviewComments");

    const pending = f.person.request({ t: "ui_snapshot", view: "board", reviewTask: f.task, reviewRefresh: true });
    await entered;
    const edited = await f.person.request({ t: "review_comment_put", task: f.task, id: draft.id, revision: 1, commit: f.head, anchor: f.anchor, body: "snapshot race edited" });
    expect(edited.ok).toBe(true);
    release();
    const refreshed = await pending;
    expect(refreshed).toHaveProperty("status");
    expect(refreshed.reviewComments).toMatchObject({ task: f.task, unavailable: true });
  } finally { release(); await f.stop(); }
});

test("review material never substitutes the current worktree HEAD for a missing task head", async () => {
  const f = await fixture();
  try {
    f.board.update(f.task, "user", "missing task commit", { refs: { paths: ["report.md"], commit: "0000000000000000000000000000000000000000" } });
    const result = await f.person.request({ t: "review_blob", task: f.task, path: "report.md", side: "head" });
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty("doc");
  } finally { await f.stop(); }
});

test("an ordinary Task B input releases Task A review provenance without clearing Task A's named scope", async () => {
  const f = await fixture();
  try {
    const saved = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "durable observer scope" });
    let reviewDelivered!: () => void;
    const reviewDelivery = new Promise<void>(resolve => { reviewDelivered = resolve; });
    f.owner.afterDelivery = reviewDelivered;
    const sent = await f.person.request({ t: "review_comment_send", task: f.task, ids: [saved.id] });
    expect(sent).toMatchObject({ ok: true, delivery: "queued" });
    await reviewDelivery;
    f.owner.afterDelivery = undefined;
    f.owner.onDoing?.("todo", "REVIEW_SCOPE_PROGRESS_CANARY");
    expect((await f.person.request({ t: "status" })).status.peers.codex.doing.text).toBe(DOING_STUB);

    const taskB = proposeOwnedTask(f.board, "codex", { title: "ordinary Task B", class: "test", refs: { paths: ["outside.md"], commit: f.head } });

    let delivered!: () => void;
    const ordinaryDelivery = new Promise<void>(resolve => { delivered = resolve; });
    f.owner.afterDelivery = delivered;
    f.daemon.bus.publish(newEnvelope("user", "ordinary Task B request", { to: ["codex"], priority: "important", refs: { task: String(taskB.id) } }));
    await ordinaryDelivery;
    f.owner.afterDelivery = undefined;
    await new Promise<void>(resolve => setImmediate(resolve)); // let the accepted delivery observer replace Task A's input scope
    f.owner.onDoing?.("reset", "");

    const scopedA = await f.peer.request({ t: "task", op: "hub_remember", args: { task: f.task, text: "Task A remains scoped", kind: "finding" } });
    expect(scopedA.ok).toBe(false);
    const ordinaryB = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "Task B is ordinary", kind: "finding" } });
    expect(ordinaryB.ok).toBe(true);

    let echo: Envelope | undefined;
    let saw!: () => void;
    const seen = new Promise<void>(resolve => { saw = resolve; });
    f.daemon.bus.tap(event => {
      if (event.t === "envelope" && event.env.from === "codex" && event.env.body === "ORDINARY_REPLY_CANARY") { echo = event.env; saw(); }
    });
    f.owner.onMessage?.("ORDINARY_REPLY_CANARY", { to: ["user"] });
    await seen;
    expect(echo!.refs).not.toHaveProperty("reviewResponse");
    f.owner.onDoing?.("todo", "ORDINARY_PROGRESS_CANARY");
    expect((await f.person.request({ t: "status" })).status.peers.codex.doing.text).toBe("ORDINARY_PROGRESS_CANARY");
    const audit = readFileSync(join(f.stateDir, "hub.log"), "utf8") + readFileSync(join(f.stateDir, "events.jsonl"), "utf8");
    expect(audit).toContain("ORDINARY_REPLY_CANARY");
  } finally { await f.stop(); }
});

test("a consumed review package stays excluded for the same native session across daemon restart", async () => {
  const f = await fixture();
  try {
    Object.defineProperty(f.owner, "nativeSession", { value: "same-native-session" });
    const saved = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "restart review scope" });
    const reviewAck = waitForDelivery(f.owner);
    const sent = await f.person.request({ t: "review_comment_send", task: f.task, ids: [saved.id] });
    expect(sent).toMatchObject({ ok: true, delivery: "queued" });
    await reviewAck;
    const piBeforeRestart = new PiTitleOwner(); f.daemon.bus.add(piBeforeRestart); await piBeforeRestart.start();
    const piReviewAck = waitForDelivery(piBeforeRestart);
    f.daemon.bus.publish(newEnvelope("hub", "RESTART_TITLE_REVIEW_QUOTE_CANARY", { to: ["pi"], kind: "review", priority: "important", refs: { task: String(f.task), reviewPackage: "review:restart-title-fixture" } }));
    await piReviewAck;
    const bindingFile = join(f.stateDir, "session-title-inputs.json");
    expect(existsSync(bindingFile)).toBe(false);
    f.owner.onDoing?.("todo", "RESTART_REVIEW_PROGRESS_CANARY");
    expect((await f.person.request({ t: "status" })).status.peers.codex.doing.text).toBe(DOING_STUB);
    const taskB = proposeOwnedTask(f.board, "codex", { title: "ordinary after restart", class: "test", refs: { paths: ["outside.md"], commit: f.head } });

    await f.restartNative("same-native-session");
    const piAfterRestart = new PiTitleOwner(); f.daemon.bus.add(piAfterRestart); await piAfterRestart.start();
    expect(existsSync(bindingFile)).toBe(false);
    const held = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "must remain private after restart", kind: "finding" } });
    expect(held.ok).toBe(false);
    const personNote = await f.person.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "person memory is not a native review turn", kind: "finding" } });
    expect(personNote.ok).toBe(true);
    f.owner.onDoing?.("todo", "RESTART_REVIEW_PROGRESS_CANARY");
    expect((await f.person.request({ t: "status" })).status.peers.codex.doing.text).toBe(DOING_STUB);
    f.owner.onMessage?.("RESTART_REVIEW_CAPTURE_CANARY", { to: ["user"] });
    await new Promise<void>(resolve => setImmediate(resolve));
    const captured = readFileSync(join(f.stateDir, "hub.log"), "utf8") + readFileSync(join(f.stateDir, "events.jsonl"), "utf8");
    expect(captured).not.toContain("RESTART_REVIEW_CAPTURE_CANARY");

    const titleAck = waitForDelivery(piAfterRestart);
    f.daemon.bus.publish(newEnvelope("user", "ORDINARY_AFTER_RESTART_TITLE_CANARY", { to: ["pi"], kind: "chat", priority: "important" }));
    await titleAck;
    expect(existsSync(bindingFile)).toBe(true);
    const titleBindings = readFileSync(bindingFile, "utf8");
    expect(titleBindings).toContain('"pi"');
    expect(titleBindings).not.toContain("RESTART_TITLE_REVIEW_QUOTE_CANARY");

    const ordinaryAck = waitForDelivery(f.owner);
    f.daemon.bus.publish(newEnvelope("user", "ordinary next turn", { to: ["codex"], priority: "important", refs: { task: String(taskB.id) } }));
    await ordinaryAck;
    const ordinary = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "ordinary input follows held review", kind: "finding" } });
    expect(ordinary.ok).toBe(true);
    f.owner.onDoing?.("todo", "ORDINARY_AFTER_RESTART_PROGRESS_CANARY");
    expect((await f.person.request({ t: "status" })).status.peers.codex.doing.text).toBe("ORDINARY_AFTER_RESTART_PROGRESS_CANARY");
    f.owner.onMessage?.("ORDINARY_AFTER_RESTART_CAPTURE_CANARY", { to: ["user"] });
    await new Promise<void>(resolve => setImmediate(resolve));
    const afterOrdinary = readFileSync(join(f.stateDir, "hub.log"), "utf8") + readFileSync(join(f.stateDir, "events.jsonl"), "utf8");
    expect(afterOrdinary).toContain("ORDINARY_AFTER_RESTART_CAPTURE_CANARY");
    const named = await f.peer.request({ t: "task", op: "hub_remember", args: { task: f.task, text: "named review task remains scoped", kind: "finding" } });
    expect(named.ok).toBe(false);

    const status = await f.person.request({ t: "status" });
    const prepared = await f.person.request({ t: "recovery", op: "prepare", operationId: "review-observer-restart", expectedInstanceId: status.status.instanceId, targetFeatures: DAEMON_FEATURES });
    expect(prepared.ok).toBe(true);
    f.daemon.bus.peers.delete("codex");
    const olderTarget = DAEMON_FEATURES.filter(feature => feature !== "review_observer_input_state");
    const rejected = await f.person.request({ t: "recovery", op: "inspect", operationId: "review-observer-restart", expectedInstanceId: status.status.instanceId, targetFeatures: olderTarget });
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining("review_observer_input_state") });
  } finally { await f.stop(); }
});

test("recovery refuses a target without review input state when a native session id is unknown", async () => {
  const f = await fixture();
  try {
    Object.defineProperty(f.owner, "nativeSession", { value: "prior-native-session" });
    const reviewAck = waitForDelivery(f.owner);
    f.daemon.bus.publish(newEnvelope("hub", "PRIOR_NATIVE_REVIEW_CANARY", { to: ["codex"], kind: "review", priority: "important", refs: { task: String(f.task), reviewPackage: "review:unknown-session-fixture" } }));
    await reviewAck;
    Object.defineProperty(f.owner, "nativeSession", { value: undefined });
    const status = await f.person.request({ t: "status" });
    const olderTarget = DAEMON_FEATURES.filter(feature => feature !== "review_observer_input_state");
    const result = await f.person.request({ t: "recovery", op: "inspect", expectedInstanceId: status.status.instanceId, targetFeatures: olderTarget });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("review_observer_input_state") });
  } finally { await f.stop(); }
});

test("ordinary inbox and push ACKs cannot clear a prior hold for an unbound session, while a confirmed new SID is clean", async () => {
  const f = await fixture();
  try {
    const saved = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "stable session review context" });
    const reviewAck = waitForDelivery(f.owner);
    expect((await f.person.request({ t: "review_comment_send", task: f.task, ids: [saved.id] })).delivery).toBe("queued");
    await reviewAck;
    const taskB = proposeOwnedTask(f.board, "codex", { title: "unbound after restore", class: "test", refs: { paths: ["outside.md"], commit: f.head } });

    await f.restartNative("fixture-native-session");
    Object.defineProperty(f.owner, "nativeSession", { value: undefined });
    f.daemon.bus.publish(newEnvelope("user", "ordinary inbox input", { to: ["codex"], priority: "important", refs: { task: String(taskB.id) } }));
    expect(f.daemon.bus.pull("codex")?.some(env => env.refs?.task === String(taskB.id))).toBe(true);
    const afterInbox = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "inbox cannot prove same native identity", kind: "finding" } });
    expect(afterInbox.ok).toBe(false);

    const ordinaryAck = waitForDelivery(f.owner);
    f.daemon.bus.publish(newEnvelope("user", "ordinary push input", { to: ["codex"], priority: "important", refs: { task: String(taskB.id) } }));
    await ordinaryAck;
    const afterPush = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "push ACK cannot prove same native identity", kind: "finding" } });
    expect(afterPush.ok).toBe(false);

    Object.defineProperty(f.owner, "nativeSession", { value: "confirmed-new-native-session" });
    const newIdentity = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "confirmed new SID is clean", kind: "finding" } });
    expect(newIdentity.ok).toBe(true);
  } finally { await f.stop(); }
});

test("a new native session with a complete store and no prior hold can remember immediately", async () => {
  const f = await fixture();
  try {
    const remembered = await f.peer.request({ t: "task", op: "hub_remember", args: { task: f.task, text: "complete store has no prior review hold", kind: "finding" } });
    expect(remembered.ok).toBe(true);
  } finally { await f.stop(); }
});

test("review input without a stable session is refused, then held for the recorded session across restart", async () => {
  const f = await fixture(undefined, true);
  try {
    Object.defineProperty(f.owner, "nativeSession", { value: undefined });
    const saved = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "unbound handoff quote" });
    expect((await f.person.request({ t: "review_comment_send", task: f.task, ids: [saved.id] })).delivery).toBe("queued");
    let refusal: unknown;
    try { f.daemon.bus.pull("codex"); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("review input provenance unavailable");
    expect((refusal as Error).message).not.toContain("unbound handoff quote");
    expect(f.daemon.bus.queued("codex")).toBeGreaterThan(0);
    expect(f.owner.got).toEqual([]);

    Object.defineProperty(f.owner, "nativeSession", { value: "recorded-native-session" });
    const delivered = f.daemon.bus.pull("codex");
    expect(delivered?.some(env => env.refs?.reviewPackage !== undefined)).toBe(true);
    const taskB = proposeOwnedTask(f.board, "codex", { title: "ordinary after confirmed review", class: "test", refs: { paths: ["outside.md"], commit: f.head } });
    await f.restartNative("recorded-native-session");
    const held = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "confirmed prior hold survives restart", kind: "finding" } });
    expect(held.ok).toBe(false);
  } finally { await f.stop(); }
});

test("Claude launch changes keep the same SID held, while a confirmed new SID clears RAM input provenance", async () => {
  const f = await fixture();
  try {
    const status = await f.person.request({ t: "status" });
    const sessionFile = join(f.stateDir, claudeStateFile("claude-session", "claude"));
    writeFileSync(sessionFile, JSON.stringify({ instanceId: status.status.instanceId, sessionId: "claude-session-one", launchId: "launch-one" }));
    const claude = new ReviewOwner("claude"); f.daemon.bus.add(claude); await claude.start();
    const reviewAck = waitForDelivery(claude);
    f.daemon.bus.publish(newEnvelope("hub", "CLAUDE_SESSION_REVIEW_QUOTE_CANARY", { to: ["claude"], kind: "review", priority: "important", refs: { task: String(f.task), reviewPackage: "review:claude-session-fixture" } }));
    await reviewAck;
    const taskB = proposeOwnedTask(f.board, "claude", { title: "new Claude session task", class: "test", refs: { paths: ["outside.md"], commit: f.head } });

    writeFileSync(sessionFile, JSON.stringify({ instanceId: status.status.instanceId, sessionId: "claude-session-one", launchId: "launch-two" }));
    const sameSession = await f.conductor.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "same SID after launch", kind: "finding" } });
    expect(sameSession.ok).toBe(false);

    writeFileSync(sessionFile, JSON.stringify({ instanceId: status.status.instanceId, sessionId: "claude-session-two", launchId: "launch-three" }));
    const newSession = await f.conductor.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "new confirmed SID", kind: "finding" } });
    expect(newSession.ok).toBe(true);
    expect(f.daemon.bus.lastDeliveredTo("claude")).toEqual([]);
    claude.onDoing?.("todo", "NEW_CLAUDE_SID_PROGRESS_CANARY");
    expect((await f.person.request({ t: "status" })).status.peers.claude.doing.text).toBe("NEW_CLAUDE_SID_PROGRESS_CANARY");
  } finally { await f.stop(); }
});

test("recovery refuses an old target when persisted review input state cannot be read", async () => {
  const f = await fixture();
  try {
    Object.defineProperty(f.owner, "nativeSession", { value: "read-error-native-session" });
    const reviewAck = waitForDelivery(f.owner);
    f.daemon.bus.publish(newEnvelope("hub", "REVIEW_DURABLE_CANARY", { to: ["codex"], kind: "review", priority: "important", refs: { task: String(f.task), reviewPackage: "review:read-error-fixture" } }));
    await reviewAck;
    const db = new Database(join(f.stateDir, "hub.db"));
    try { db.query("UPDATE review_input_sessions SET input_hash='malformed' WHERE peer='codex' AND input_hash IS NOT NULL").run(); } finally { db.close(); }
    await f.restartNative("read-error-native-session");
    const status = await f.person.request({ t: "status" });
    const olderTarget = DAEMON_FEATURES.filter(feature => feature !== "review_observer_input_state");
    const result = await f.person.request({ t: "recovery", op: "inspect", expectedInstanceId: status.status.instanceId, targetFeatures: olderTarget });
    expect(olderTarget).not.toContain("review_observer_input_state");
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("unknown");
    expect(String(result.error)).toMatch(/review_observer_input_state|review observer input/);
  } finally { await f.stop(); }
});

test("a failed review-hold write keeps pull-only scope held and raises the recovery feature floor", async () => {
  const f = await fixture(undefined, true);
  let inboxPeer: ControlClient | undefined;
  try {
    Object.defineProperty(f.owner, "nativeSession", { value: "failed-write-native-session" });
    const saved = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "failed persistence review scope" });
    expect((await f.person.request({ t: "review_comment_send", task: f.task, ids: [saved.id] })).delivery).toBe("queued");
    const db = new Database(join(f.stateDir, "hub.db"));
    try {
      db.run("CREATE TRIGGER reject_review_input_hold_insert BEFORE INSERT ON review_input_sessions BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
      db.run("CREATE TRIGGER reject_review_input_hold_update BEFORE UPDATE OF input_hash ON review_input_sessions BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    } finally { db.close(); }
    expect(() => f.daemon.bus.pull("codex")).toThrow();
    const instanceId = (await f.person.request({ t: "status" })).status.instanceId;
    writeFileSync(join(f.stateDir, claudeStateFile("claude-session", "claude")), JSON.stringify({ instanceId, sessionId: "mcp-inbox-session", launchId: "mcp-launch" }));
    inboxPeer = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", projectRoot: f.cwd });
    const pushes: any[] = [];
    inboxPeer.onPush = message => { if (message.t === "deliver") pushes.push(message); };
    const acceptedInput = newEnvelope("user", "ordinary accepted context", { to: ["claude"], priority: "important" });
    f.daemon.bus.publish(acceptedInput);
    for (let i = 0; i < 200 && pushes.length === 0; i++) await Bun.sleep(5);
    expect(pushes).toHaveLength(1);
    const pushed = pushes[0]!;
    expect(await inboxPeer.request({ t: "delivery_receipt", deliveryId: pushed.deliveryId, generation: pushed.generation, state: "accepted" })).toMatchObject({ ok: true });
    const claudeOwner = f.daemon.bus.peers.get("claude") as unknown as { nativeStarted(session: string): void };
    claudeOwner.nativeStarted("mcp-inbox-session");
    f.daemon.bus.publish(newEnvelope("hub", "REVIEW_MCP_CANARY", { to: ["claude"], kind: "review", priority: "important", refs: { task: String(f.task), reviewPackage: "review:mcp-write-failure" } }));
    const inboxReply = await inboxPeer.request({ t: "inbox" }, 2000);
    const heldForHint = structuredClone(inboxReply.held);
    expect(inboxReply).toMatchObject({ ok: false, error: expect.stringContaining("review input provenance unavailable"), held: { rows: expect.arrayContaining([
      expect.objectContaining({ id: pushed.deliveryId, revision: expect.any(Number), state: "accepted", senders: expect.arrayContaining(["user"]), kinds: expect.arrayContaining(["chat"]) }),
    ]) } });
    expect(JSON.stringify(inboxReply)).not.toContain("REVIEW_MCP_CANARY");
    expect(renderHeldHint(heldForHint, Date.now(), false)).toContain("hub_delivery_resolve");
    const taskB = proposeOwnedTask(f.board, "codex", { title: "ordinary after failed hold write", class: "test", refs: { paths: ["outside.md"], commit: f.head } });
    const held = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "write failure cannot release pull scope", kind: "finding" } });
    expect(held.ok).toBe(false);
    const status = await f.person.request({ t: "status" });
    const olderTarget = DAEMON_FEATURES.filter(feature => feature !== "review_observer_input_state");
    const recovery = await f.person.request({ t: "recovery", op: "inspect", expectedInstanceId: status.status.instanceId, targetFeatures: olderTarget });
    expect(recovery).toMatchObject({ ok: false, error: expect.stringContaining("review_observer_input_state") });
    Object.defineProperty(f.owner, "nativeSession", { value: "confirmed-new-native-session" });
    const newSessionMemory = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "new verified native session starts clean", kind: "finding" } });
    expect(newSessionMemory.ok).toBe(true);
  } finally { inboxPeer?.close(); await f.stop(); }
});

test("an anchored finding submission remains latched across a daemon restart until ordinary input is acknowledged", async () => {
  const f = await fixture();
  try {
    const reviewer = new ReviewOwner("claude", false, false, "same-claude-session"); f.daemon.bus.add(reviewer); await reviewer.start();
    f.board.update(f.task, "user", "fixture reviewer", { reviewer: "claude" });
    const reviewRequestAck = waitForDelivery(reviewer);
    const done = await f.peer.request({ t: "task", op: "hub_task_done", args: { id: f.task, summary: "Document ready", refs: { commit: f.head } } });
    expect(done.ok).toBe(true);
    await reviewRequestAck;
    const finding = { id: "restart-latched-anchor", pass: "bugs", severity: "important", disposition: "open", path: "report.md", anchor: f.anchor };
    const verdict = await f.conductor.request({ t: "task", op: "hub_review", args: { id: f.task, head: f.head, verdict: "changes_requested", note: "Review finding", findings: [finding] } });
    expect(verdict.ok).toBe(true);
    const taskB = proposeOwnedTask(f.board, "claude", { title: "ordinary reviewer task", class: "test", refs: { paths: ["outside.md"], commit: f.head } });

    await f.restartNative();
    const reviewerAfterRestart = new ReviewOwner("claude", false, false, "same-claude-session"); f.daemon.bus.add(reviewerAfterRestart); await reviewerAfterRestart.start();
    const stillHeld = await f.conductor.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "anchored reviewer input stays held", kind: "finding" } });
    expect(stillHeld.ok).toBe(false);
    const nextTurnAck = waitForDelivery(reviewerAfterRestart);
    f.daemon.bus.publish(newEnvelope("user", "ordinary reviewer next turn", { to: ["claude"], priority: "important", refs: { task: String(taskB.id) } }));
    await nextTurnAck;
    const released = await f.conductor.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "ordinary reviewer turn is clear", kind: "finding" } });
    expect(released.ok).toBe(true);
    const named = await f.conductor.request({ t: "task", op: "hub_remember", args: { task: f.task, text: "anchored task remains scoped", kind: "finding" } });
    expect(named.ok).toBe(false);
  } finally { await f.stop(); }
});

test("a review pull holds global observer scope, while an ordinary pull replaces it", async () => {
  const f = await fixture(undefined, true);
  try {
    const saved = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "pulled review scope" });
    const sent = await f.person.request({ t: "review_comment_send", task: f.task, ids: [saved.id] });
    expect(sent).toMatchObject({ ok: true, delivery: "queued" });

    const reviewInput = f.daemon.bus.pull("codex");
    expect(reviewInput?.some(env => env.refs?.reviewPackage !== undefined)).toBe(true);
    f.owner.markBusy();
    const taskB = proposeOwnedTask(f.board, "codex", { title: "ordinary pulled task B", class: "test", refs: { paths: ["outside.md"], commit: f.head } });
    const blocked = await f.peer.request({ t: "task", op: "hub_remember", args: { text: "not captured from review pull", kind: "finding", task: taskB.id } });
    expect(blocked.ok).toBe(false);

    f.daemon.bus.publish(newEnvelope("user", "ordinary pulled Task B", { to: ["codex"], priority: "important", refs: { task: String(taskB.id) } }));
    const sameTurnInput = f.daemon.bus.pull("codex");
    expect(sameTurnInput?.some(env => env.refs?.task === String(taskB.id))).toBe(true);
    const sameTurnBlocked = await f.peer.request({ t: "task", op: "hub_remember", args: { text: "same review turn remains private", kind: "finding", task: taskB.id } });
    expect(sameTurnBlocked.ok).toBe(false);

    f.owner.markIdle();
    f.daemon.bus.publish(newEnvelope("user", "ordinary Task B next turn", { to: ["codex"], priority: "important", refs: { task: String(taskB.id) } }));
    const ordinaryInput = f.daemon.bus.pull("codex");
    expect(ordinaryInput?.some(env => env.refs?.task === String(taskB.id))).toBe(true);
    const allowed = await f.peer.request({ t: "task", op: "hub_remember", args: { text: "Task B uses ordinary input", kind: "finding", task: taskB.id } });
    expect(allowed.ok).toBe(true);
    const namedA = await f.peer.request({ t: "task", op: "hub_remember", args: { text: "Task A remains scoped", kind: "finding", task: f.task } });
    expect(namedA.ok).toBe(false);
  } finally { await f.stop(); }
});

test("a restored pull-only review hold survives active and idle inbox pulls until session identity changes", async () => {
  const f = await fixture(undefined, true);
  try {
    Object.defineProperty(f.owner, "nativeSession", { value: "same-native-session" });
    const saved = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "active pull review scope" });
    expect((await f.person.request({ t: "review_comment_send", task: f.task, ids: [saved.id] })).delivery).toBe("queued");
    expect(f.daemon.bus.pull("codex")?.some(env => env.refs?.reviewPackage !== undefined)).toBe(true);
    const taskB = proposeOwnedTask(f.board, "codex", { title: "ordinary active-turn task", class: "test", refs: { paths: ["outside.md"], commit: f.head } });

    await f.restartNative();
    f.owner.markBusy();
    f.daemon.bus.publish(newEnvelope("user", "ordinary input within active turn", { to: ["codex"], priority: "important", refs: { task: String(taskB.id) } }));
    expect(f.daemon.bus.pull("codex")?.some(env => env.refs?.task === String(taskB.id))).toBe(true);
    const stillHeld = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "active turn remains held", kind: "finding" } });
    expect(stillHeld.ok).toBe(false);

    f.owner.markIdle();
    f.daemon.bus.publish(newEnvelope("user", "ordinary input after active turn", { to: ["codex"], priority: "important", refs: { task: String(taskB.id) } }));
    expect(f.daemon.bus.pull("codex")?.some(env => env.refs?.task === String(taskB.id))).toBe(true);
    const stillHeldAfterInbox = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "restored pull-only hold stays sticky", kind: "finding" } });
    expect(stillHeldAfterInbox.ok).toBe(false);

    await f.owner.stop(); f.daemon.bus.peers.delete("codex");
    const replacement = new ReviewOwner("codex", true, false, "different-native-session"); f.daemon.bus.add(replacement); await replacement.start();
    const released = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "confirmed new session starts clean", kind: "finding" } });
    expect(released.ok).toBe(true);
  } finally { await f.stop(); }
});

test("presence-only pushes and pulls do not replace the held review input", async () => {
  const f = await fixture();
  try {
    const saved = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "presence review scope" });
    f.owner.markBusy();
    expect((await f.person.request({ t: "review_comment_send", task: f.task, ids: [saved.id] })).delivery).toBe("queued");
    expect(f.daemon.bus.pull("codex")?.some(env => env.refs?.reviewPackage !== undefined)).toBe(true);
    const taskB = proposeOwnedTask(f.board, "codex", { title: "presence Task B", class: "test", refs: { paths: ["outside.md"], commit: f.head } });

    f.owner.markIdle();
    let pushed!: () => void;
    const presencePush = new Promise<void>(resolve => { pushed = resolve; });
    f.owner.afterDelivery = pushed;
    f.daemon.bus.publish(newEnvelope("hub", "presence update", { to: ["codex"], kind: "presence", priority: "status" }));
    await presencePush;
    f.owner.afterDelivery = undefined;
    await new Promise<void>(resolve => setImmediate(resolve));
    const heldAfterPush = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "still in review context", kind: "finding" } });
    expect(heldAfterPush.ok).toBe(false);

    f.owner.markBusy();
    f.daemon.bus.preface("codex", "another presence-only update");
    expect(f.daemon.bus.pull("codex")?.every(env => env.kind === "presence")).toBe(true);
    const heldAfterPull = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "still in review context", kind: "finding" } });
    expect(heldAfterPull.ok).toBe(false);
  } finally { await f.stop(); }
});

test("a mixed quote and ordinary batch does not persist an ordinary session-title binding", async () => {
  const f = await fixture();
  const titleOwner = new PiTitleOwner(); f.daemon.bus.add(titleOwner); await titleOwner.start();
  const bindingFile = join(f.stateDir, "session-title-inputs.json");
  try {
    titleOwner.markBusy();
    f.daemon.bus.publish(newEnvelope("hub", "REVIEW_TITLE_QUOTE_CANARY", { to: ["pi"], kind: "review", priority: "important", refs: { task: String(f.task), reviewPackage: "review:title-fixture" } }));
    f.daemon.bus.publish(newEnvelope("user", "MIXED_ORDINARY_TITLE_CANARY", { to: ["pi"], kind: "chat", priority: "important" }));
    let mixedDelivered!: () => void;
    const mixedDelivery = new Promise<void>(resolve => { mixedDelivered = resolve; });
    titleOwner.afterDelivery = mixedDelivered;
    titleOwner.markIdle();
    await mixedDelivery;
    titleOwner.afterDelivery = undefined;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(titleOwner.got).toHaveLength(2);
    expect(existsSync(bindingFile)).toBe(false);

    let ordinaryDelivered!: () => void;
    const ordinaryDelivery = new Promise<void>(resolve => { ordinaryDelivered = resolve; });
    titleOwner.afterDelivery = ordinaryDelivered;
    f.daemon.bus.publish(newEnvelope("user", "CLEAN_TITLE_INPUT_CANARY", { to: ["pi"], kind: "chat", priority: "important" }));
    titleOwner.markIdle();
    await ordinaryDelivery;
    titleOwner.afterDelivery = undefined;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(existsSync(bindingFile)).toBe(true);
    const bindings = readFileSync(bindingFile, "utf8");
    expect(bindings).toContain('"pi"');
    expect(bindings).not.toContain("MIXED_ORDINARY_TITLE_CANARY");
  } finally { await f.stop(); }
});

test("an ordinary steer within a held review turn cannot bind a title", async () => {
  const f = await fixture();
  const titleOwner = new PiTitleOwner(true); f.daemon.bus.add(titleOwner); await titleOwner.start();
  const bindingFile = join(f.stateDir, "session-title-inputs.json");
  try {
    let reviewDelivered!: () => void;
    const reviewDelivery = new Promise<void>(resolve => { reviewDelivered = resolve; });
    titleOwner.afterDelivery = reviewDelivered;
    f.daemon.bus.publish(newEnvelope("hub", "REVIEW_STEER_QUOTE_CANARY", { to: ["pi"], kind: "review", priority: "important", refs: { task: String(f.task), reviewPackage: "review:steer-fixture" } }));
    await reviewDelivery;
    titleOwner.afterDelivery = undefined;
    await new Promise<void>(resolve => setImmediate(resolve));
    titleOwner.markBusy();

    let steerStarted!: () => void, releaseSteer!: () => void;
    const started = new Promise<void>(resolve => { steerStarted = resolve; });
    titleOwner.steerGate = new Promise<void>(resolve => { releaseSteer = resolve; });
    titleOwner.afterDelivery = steerStarted;
    f.daemon.bus.publish(newEnvelope("user", "STEERED_ORDINARY_TITLE_CANARY", { to: ["pi"], kind: "chat", priority: "important" }));
    await started;
    releaseSteer();
    await new Promise<void>(resolve => setImmediate(resolve));
    titleOwner.steerGate = undefined;
    titleOwner.afterDelivery = undefined;
    expect(titleOwner.steered).toHaveLength(1);
    expect(existsSync(bindingFile)).toBe(false);

    titleOwner.markIdle();
    let ordinaryDelivered!: () => void;
    const ordinaryDelivery = new Promise<void>(resolve => { ordinaryDelivered = resolve; });
    titleOwner.afterDelivery = ordinaryDelivered;
    f.daemon.bus.publish(newEnvelope("user", "NEXT_TURN_TITLE_CANARY", { to: ["pi"], kind: "chat", priority: "important" }));
    await ordinaryDelivery;
    titleOwner.afterDelivery = undefined;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(existsSync(bindingFile)).toBe(true);
    const bindings = readFileSync(bindingFile, "utf8");
    expect(bindings).toContain('"pi"');
    expect(bindings).not.toContain("STEERED_ORDINARY_TITLE_CANARY");
  } finally { await f.stop(); }
});

test("a staged ordinary push preserves prior review scope until its positive acknowledgement", async () => {
  const f = await fixture();
  try {
    const saved = await f.person.request({ t: "review_comment_put", task: f.task, commit: f.head, anchor: f.anchor, body: "staged review scope" });
    f.owner.markBusy();
    expect((await f.person.request({ t: "review_comment_send", task: f.task, ids: [saved.id] })).delivery).toBe("queued");
    expect(f.daemon.bus.pull("codex")?.some(env => env.refs?.reviewPackage !== undefined)).toBe(true);
    f.owner.markIdle();

    const taskB = proposeOwnedTask(f.board, "codex", { title: "staged ordinary Task B", class: "test", refs: { paths: ["outside.md"], commit: f.head } });
    let delivered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { delivered = resolve; });
    f.owner.deliveryGate = new Promise<void>(resolve => { release = resolve; });
    f.owner.afterDelivery = delivered;
    f.daemon.bus.publish(newEnvelope("user", "ordinary Task B input", { to: ["codex"], priority: "important", refs: { task: String(taskB.id) } }));
    await started;

    const whilePending = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "review scope remains until delivery acknowledgement", kind: "finding" } });
    expect(whilePending.ok).toBe(false);

    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    f.owner.deliveryGate = undefined;
    f.owner.afterDelivery = undefined;
    const afterAck = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "ordinary input replaced review scope", kind: "finding" } });
    expect(afterAck.ok).toBe(true);
  } finally { await f.stop(); }
});

test("a quote-bearing steer latches observer scope before its positive acknowledgement", async () => {
  const f = await fixture(undefined, false, true);
  try {
    f.owner.markBusy();
    const taskB = proposeOwnedTask(f.board, "codex", { title: "steered ordinary Task B", class: "test", refs: { paths: ["outside.md"], commit: f.head } });
    let steered!: () => void, release!: () => void;
    const steerStarted = new Promise<void>(resolve => { steered = resolve; });
    f.owner.steerGate = new Promise<void>(resolve => { release = resolve; });
    f.owner.afterDelivery = steered;
    f.daemon.bus.publish(newEnvelope("hub", "review quote to a busy peer", { to: ["codex"], kind: "review", priority: "important", refs: { task: String(f.task), reviewPackage: "review:steer-scope" } }));
    await steerStarted;
    const beforeAck = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "steered review input is current", kind: "finding" } });
    expect(beforeAck.ok).toBe(false);

    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    f.owner.steerGate = undefined;
    f.owner.afterDelivery = undefined;
    const afterAck = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "review steer stays scoped", kind: "finding" } });
    expect(afterAck.ok).toBe(false);

    f.owner.markIdle();
    let ordinaryDelivered!: () => void;
    const ordinaryDelivery = new Promise<void>(resolve => { ordinaryDelivered = resolve; });
    f.owner.afterDelivery = ordinaryDelivered;
    f.daemon.bus.publish(newEnvelope("user", "ordinary next turn", { to: ["codex"], priority: "important", refs: { task: String(taskB.id) } }));
    await ordinaryDelivery;
    f.owner.afterDelivery = undefined;
    await new Promise<void>(resolve => setImmediate(resolve));
    const ordinary = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "ordinary next turn replaces review input", kind: "finding" } });
    expect(ordinary.ok).toBe(true);
  } finally { await f.stop(); }
});

test("an anchor-bearing review refusal during a pending delivery keeps its latch after delivery failure", async () => {
  const f = await fixture();
  try {
    const taskB = proposeOwnedTask(f.board, "codex", { title: "pending ordinary Task B", class: "test", refs: { paths: ["outside.md"], commit: f.head } });
    let delivered!: () => void, rejectDelivery!: (reason: Error) => void;
    const started = new Promise<void>(resolve => { delivered = resolve; });
    f.owner.deliveryGate = new Promise<void>((_resolve, reject) => { rejectDelivery = reject; });
    f.owner.afterDelivery = delivered;
    f.daemon.bus.publish(newEnvelope("user", "ordinary Task B input", { to: ["codex"], priority: "important", refs: { task: String(taskB.id) } }));
    await started;

    const refused = await f.peer.request({ t: "task", op: "hub_review", args: { id: 99999, verdict: "approved", findings: [{ id: "refused-anchor", pass: "bugs", severity: "important", disposition: "fixed", path: "report.md", anchor: f.anchor }] } });
    expect(refused.ok).toBe(false);
    rejectDelivery(new Error("synthetic uncertain transport failure"));
    await new Promise<void>(resolve => setImmediate(resolve));
    f.owner.deliveryGate = undefined;
    f.owner.afterDelivery = undefined;
    const stillHeld = await f.peer.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "anchor input stays private after uncertain delivery", kind: "finding" } });
    expect(stillHeld.ok).toBe(false);
  } finally { await f.stop(); }
});

test("an anchored approved hub_review latches its input until a new ordinary delivery", async () => {
  const f = await fixture();
  const reviewer = new ReviewOwner("claude");
  f.daemon.bus.add(reviewer); await reviewer.start();
  try {
    f.board.update(f.task, "user", "prepare anchored review", { reviewer: "claude", state: "in_review" });
    let reviewDelivered!: () => void;
    const reviewDelivery = new Promise<void>(resolve => { reviewDelivered = resolve; });
    reviewer.afterDelivery = reviewDelivered;
    f.daemon.bus.publish(newEnvelope("hub", "Review the report", { to: ["claude"], kind: "review", priority: "important", refs: { task: String(f.task) } }));
    await reviewDelivery;
    reviewer.afterDelivery = undefined;
    await new Promise<void>(resolve => setImmediate(resolve));
    reviewer.markBusy();

    const taskB = proposeOwnedTask(f.board, "claude", { title: "ordinary Task B", class: "test", refs: { paths: ["outside.md"], commit: f.head } });
    const finding = { id: "latched-anchor", pass: "bugs", severity: "important", disposition: "fixed", path: "report.md", anchor: f.anchor };
    const approved = await f.conductor.request({ t: "task", op: "hub_review", args: { id: f.task, head: f.head, verdict: "approved", note: "fixed at the reviewed head", findings: [finding] } });
    expect(approved.ok).toBe(true);
    expect(f.board.get(f.task)!.state).toBe("approved");

    const held = await f.conductor.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "must stay local to the review turn", kind: "finding" } });
    expect(held.ok).toBe(false);

    let ordinaryDelivered!: () => void;
    const ordinaryDelivery = new Promise<void>(resolve => { ordinaryDelivered = resolve; });
    reviewer.markIdle(); // finish the review turn before the next ordinary input
    reviewer.afterDelivery = ordinaryDelivered;
    f.daemon.bus.publish(newEnvelope("user", "ordinary Task B input", { to: ["claude"], priority: "important", refs: { task: String(taskB.id) } }));
    await ordinaryDelivery;
    reviewer.afterDelivery = undefined;
    await new Promise<void>(resolve => setImmediate(resolve));
    const allowed = await f.conductor.request({ t: "task", op: "hub_remember", args: { task: taskB.id, text: "ordinary Task B note", kind: "finding" } });
    expect(allowed.ok).toBe(true);
  } finally { await f.stop(); }
});
