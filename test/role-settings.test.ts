import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { realPath } from "../src/hub/project.ts";
import { Board } from "../src/hub/board.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { readEvents } from "../src/hub/events.ts";
import { settingDef, checkSettingValue } from "../src/hub/settings.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import type { Envelope } from "../src/hub/envelope.ts";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
class Peer extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
  turn() { this.setState("busy"); this.setState("idle"); }
}
async function fixture(managedKimi = false, initialKimiRoles?: string[]) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-role-settings-"))), state = join(dir, ".agenthub/state"); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const shared = JSON.stringify({ roles: DEFAULT_CONFIG.roles, memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, snapshots: { enabled: false }, catalog_roles: { codex: ["backend-engineer"], ...(initialKimiRoles ? {kimi:initialKimiRoles} : {}) } });
  writeFileSync(join(dir, ".agenthub/config.json"), shared);
  writeFileSync(join(dir, ".agenthub/routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"'));
  const daemon = await startDaemon({ cwd: dir, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...loadConfig(dir), batch_ms: 0, ...(managedKimi ? { peers: { kimi: { start_mode: "headless" as const } }, kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts"), "--record-protocol", join(dir, "protocol.jsonl")] } : {}) } }); cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(state, { role: "console" }); cleanup.push(() => client.close());
  const peer = new Peer("codex"); daemon.bus.add(peer); await peer.start();
  const tools = await ControlClient.connect(state, { role: "tools", peer: "codex" }); cleanup.push(() => tools.close());
  return { dir, state, shared, daemon, client, tools, peer };
}
test("catalog settings validate two compatible ids and preserve shared config through write and undo (#295)", async () => {
  const f = await fixture(), key = "catalog_roles.codex", def = settingDef(key); expect(typeof def).toBe("object");
  if (typeof def === "string") throw new Error(def);
  expect(def).toMatchObject({ group: "Roles", type: "roles", store: "config", applies: "next use", risk: "safe" });
  for (const bad of ["backend-engineer", ["code-reviewer"], ["missing"], ["backend-engineer", "backend-engineer"], ["backend-engineer", "test-engineer", "frontend-engineer"]]) {
    expect((await f.client.request({ t: "settings_set", key, value: bad })).ok).toBe(false);
  }
  expect(checkSettingValue(def, [], ["backend-engineer"])).toEqual([]);
  expect(() => checkSettingValue(def, ["backend-engineer", "frontend-engineer", "test-engineer"], ["backend-engineer", "frontend-engineer", "test-engineer"])).toThrow("two");
  expect((await f.client.request({ t: "settings_set", key, value: ["test-engineer"] })).ok).toBe(true);
  expect(loadConfig(f.dir).catalog_roles!.codex).toEqual(["test-engineer"]); expect(readFileSync(join(f.dir, ".agenthub/config.json"), "utf8")).toBe(f.shared);
  const view = await f.client.request({ t: "settings_get" }); const row = view.rows.find((row: any) => row.key === key);
  expect(row.pending).toEqual(["test-engineer"]); expect(row.note).toContain("unconfirmed");
  expect((await f.client.request({ t: "settings_undo" })).ok).toBe(true); expect(loadConfig(f.dir).catalog_roles!.codex).toEqual(["backend-engineer"]);
  const roles = readEvents(join(f.state, "events.jsonl")).filter(event => event.type === "role" && event.stage === "assigned"); expect(roles).toHaveLength(2); expect(JSON.stringify(roles)).not.toContain("## Scope");
});
test("agent shells and tools clients cannot mutate session or existing task roles (#295)", async () => {
  const f = await fixture();
  expect((await f.tools.request({ t: "task", op: "hub_task_propose", args: { title: "Existing", class: "implement", owner: "codex" } })).ok).toBe(true);
  for (const op of ["assign", "clear"]) expect(classifyPeerCommand("role", [op, "codex", "backend-engineer"])).toBe("console");
  // #933: an agent re-roles its own task; the daemon refuses another peer's task, and every session-role write stays the person's.
  expect(classifyPeerCommand("task", ["role", "1", "backend-engineer"])).toBe("allowed");
  for (const msg of [{ t: "settings_set", key: "catalog_roles.codex", value: [] }, { t: "settings_undo" }]) expect((await f.tools.request(msg)).ok).toBe(false);
  const board = new Board(join(f.state, "hub.db")); cleanup.push(() => board.close());
  const other = await ControlClient.connect(f.state, { role: "tools", peer: "claude" }); cleanup.push(() => other.close());
  const refused = await other.request({ t: "task_catalog_role", id: 1, role: "backend-engineer" }); expect(refused.ok).toBe(false); expect(refused.error).toContain("not yours"); expect(board.get(1)!.role).toBeUndefined();
  expect((await f.tools.request({ t: "task_catalog_role", id: 1, role: "backend-engineer" })).ok).toBe(true); expect(board.get(1)!.role).toBe("backend-engineer");
  // Under review only the person changes the role, whoever owns the task.
  board.update(1, "codex", "done", { state: "in_review", reviewer: "user" });
  const reviewing = await f.tools.request({ t: "task_catalog_role", id: 1, role: null }); expect(reviewing.ok).toBe(false); expect(reviewing.error).toContain("in review"); expect(board.get(1)!.role).toBe("backend-engineer");
  board.update(1, "user", "changes requested", { state: "changes_requested" });
  // A PII context keeps even the owner out: its words may carry the private task's text.
  const pii = board.propose("user", { title: "private review", class: "implement", signals: ["pii_path"] }); board.update(pii.id, "user", "fixture reviewer", { reviewer: "codex" });
  expect((await f.tools.request({ t: "task_catalog_role", id: 1, role: null })).ok).toBe(false); expect(board.get(1)!.role).toBe("backend-engineer");
  const peer = await ControlClient.connect(f.state, { role: "peer", peer: "other", channel: false }); cleanup.push(() => peer.close());
  expect((await peer.request({ t: "settings_set", key: "catalog_roles.codex", value: [] })).ok).toBe(false); expect((await peer.request({ t: "task_catalog_role", id: 1, role: null })).ok).toBe(false);
});
test("person task role changes keep ownership and private stubs while delivering bounded guidance (#295)", async () => {
  const f = await fixture();
  expect((await f.tools.request({ t: "task", op: "hub_task_propose", args: { title: "Work", class: "implement", owner: "codex" } })).ok).toBe(true);
  const board = new Board(join(f.state, "hub.db")); cleanup.push(() => board.close()); const before = board.get(1)!;
  const direct = new Tasks({ board, bus:f.daemon.bus, cwd:f.dir, project:"fixture", routing:()=>loadRouting(f.dir), notify:()=>{} });
  expect(() => direct.setRole("claude",1,"backend-engineer")).toThrow("not yours"); // #933: the owner (codex) may; another peer may not
  expect((await f.client.request({ t: "task_catalog_role", id: 1, role: "code-reviewer" })).ok).toBe(false); expect(board.get(1)!.role).toBeUndefined();
  expect((await f.client.request({ t: "task_catalog_role", id: 1, role: "backend-engineer" })).ok).toBe(true); expect(board.get(1)).toMatchObject({ role: "backend-engineer", owner: before.owner, reviewer: before.reviewer, class: before.class, state: before.state });
  for (let i = 0; i < 100 && !f.peer.got.length; i++) await Bun.sleep(5); expect(f.peer.got.some(env => env.body.includes("catalog role changed"))).toBe(true);
  expect((await f.client.request({ t: "task_catalog_role", id: 1, role: null })).ok).toBe(true); expect(board.get(1)!.role).toBeUndefined();
  expect((await f.client.request({ t: "task_catalog_role", id: 1 })).ok).toBe(false);
  expect((await f.client.request({ t: "task", op: "hub_task_propose", args: { title: "patient 900101-1234567 needs a follow-up", class: "implement" } })).ok).toBe(true);
  expect((await f.client.request({ t: "task_catalog_role", id: 2, role: "backend-engineer" })).ok).toBe(true); expect(JSON.stringify(readEvents(join(f.state, "events.jsonl")))).not.toContain("900101-1234567");
});
test("role setting controls have labeled keyboard selects, distinct clear/inherit and inline errors (#295)", async () => {
  const html = readFileSync(join(import.meta.dir, "../src/ui/index.html"), "utf8"), code = /const SETTING_GROUPS = [\s\S]*?\nfunction render\(snapshot\) \{/.exec(html)![0].replace(/\nfunction render\(snapshot\) \{$/, "");
  class Node {
    children: Node[] = []; attrs: Record<string,string> = {}; listeners: Record<string,()=>unknown> = {}; dataset: Record<string,string> = {}; value=""; id=""; type=""; disabled=false; hidden=false; htmlFor="";
    constructor(public tag: string, public textContent="", public className="") {}
    append(...nodes: Node[]) { this.children.push(...nodes); } replaceChildren(...nodes: Node[]) { this.children=nodes; }
    setAttribute(key:string,value:string) { this.attrs[key]=value; } addEventListener(key:string,fn:()=>unknown) { this.listeners[key]=fn; }
    all(): Node[] { return [this,...this.children.flatMap(node=>node.all())]; } querySelectorAll(tag:string) { return this.all().filter(node=>node.tag===tag); }
  }
  const notice = new Node("p"), sent: any[] = [];
  const row = { key:"catalog_roles.codex",group:"Roles",label:"codex: catalog guidance",type:"roles",values:["backend-engineer","test-engineer"],value:null,pending:["test-engineer"],file:"config.local.json",source:"config.local.json",applies:"peer start",risk:"safe" };
  const node = runInNewContext(`${code}; settingRow(row, false)`, { row, Date, managerMode:false,snapshotValid:true,stopped:false,$:()=>notice, el:(tag:string,text?:string,cls?:string)=>new Node(tag,text,cls), badge:(text:string)=>new Node("span",text), action:async (payload:any)=>{sent.push(payload);return true;} }) as Node;
  const selects = node.querySelectorAll("select"); expect(selects).toHaveLength(2); expect(node.all().some(el=>el.htmlFor===selects[0]!.id)).toBe(true); expect(selects[1]!.attrs["aria-label"]).toContain("second"); expect(selects[0]!.value).toBe("test-engineer");
  const save = node.all().find(el=>el.attrs["aria-label"]?.startsWith("Save "))!; selects[1]!.value="test-engineer"; await save.listeners.click!(); expect(sent).toEqual([]); expect(node.all().some(el=>el.textContent.includes("distinct roles"))).toBe(true);
  selects[0]!.value=""; selects[1]!.value=""; await save.listeners.click!(); expect(sent.at(-1).value).toEqual([]);
  await node.all().find(el=>el.textContent==="Use profile/shared roles")!.listeners.click!(); expect(sent.at(-1).value).toBeNull();
});


test("role writes apply at the next managed peer start and clear remains distinct from inheritance (#295)", async () => {
  const f = await fixture(true), key = "catalog_roles.kimi";
  expect((await f.client.request({ t: "settings_set", key, value: ["analyst"] })).ok).toBe(true);
  expect((await f.client.request({ t: "peer_start", peer: "kimi" }, 15000)).ok).toBe(true);
  expect((await f.client.request({ t: "send", body: "role publication probe", to: ["kimi"] })).ok).toBe(true);
  const prompts = () => { try { return readFileSync(join(f.dir, "protocol.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(message => message.method === "session/prompt"); } catch { return []; } };
  for (let i=0;i<200 && !prompts().length;i++) await Bun.sleep(5); expect(prompts().length).toBeGreaterThan(0); expect(JSON.stringify(prompts()[0])).toContain("analyst [research, shipped");
  expect((await f.client.request({ t: "settings_get" })).rows.find((row:any)=>row.key===key).pending).toBeUndefined();
  expect((await f.client.request({ t: "settings_set", key, value: ["fact-checker"] })).ok).toBe(true);
  const pending = (await f.client.request({ t: "settings_get" })).rows.find((row:any)=>row.key===key); expect(pending.value).toEqual(["analyst"]); expect(pending.pending).toEqual(["fact-checker"]);
  expect((await f.client.request({ t: "settings_set", key:"catalog_roles.codex", value: [] })).ok).toBe(true); expect(loadConfig(f.dir).catalog_roles!.codex).toEqual([]);
  expect((await f.client.request({ t: "settings_set", key:"catalog_roles.codex", value: null })).ok).toBe(true); expect(loadConfig(f.dir).catalog_roles!.codex).toEqual(["backend-engineer"]);
});
async function cli(f: Awaited<ReturnType<typeof fixture>>, args: string[], peer = false) {
  const entry = join(import.meta.dir, "../src/cli/main.ts"), wrapper = join(f.dir, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const key of ["AGENTHUB_PEER_ID","CLAUDECODE","CLAUDE_CODE_SESSION_ID","CODEX_THREAD_ID","AGENTHUB_PROJECT_DIR","AGENTHUB_STATE_DIR","AGENTHUB_INSTANCE_ID","AGENTHUB_LAUNCH_ID"]) delete process.env[key];\nprocess.env.AGENTHUB_HOME = ${JSON.stringify(join(f.dir,"home"))};\n${peer ? 'process.env.CODEX_THREAD_ID="role-shell-fixture";' : ""}\nprocess.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];\nawait import(${JSON.stringify(entry)});\n`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd:f.dir, stdin:"ignore",stdout:"pipe",stderr:"pipe" });
  const deadline=setTimeout(()=>child.kill(),10000);
  try { const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]); if(code!==0) process.stderr.write(`Role CLI ${args.join(" ")}: ${err}\n`); return {code,out,err}; } finally { clearTimeout(deadline); }
}
test("native CLI role assign and selective clear use person settings while agent shells refuse (#295)", async () => {
  const f=await fixture();
  expect((await cli(f,["role","assign","codex","test-engineer"])).code).toBe(0); expect(loadConfig(f.dir).catalog_roles!.codex).toEqual(["backend-engineer","test-engineer"]);
  expect((await cli(f,["role","assign","codex","frontend-engineer"])).code).not.toBe(0); expect(loadConfig(f.dir).catalog_roles!.codex).toEqual(["backend-engineer","test-engineer"]);
  expect((await cli(f,["role","clear","codex","backend-engineer"])).code).toBe(0); expect(loadConfig(f.dir).catalog_roles!.codex).toEqual(["test-engineer"]);
  for (const args of [["role","assign","codex","backend-engineer"],["role","clear","codex"]]) { const denied=await cli(f,args,true); expect(denied.code).not.toBe(0); expect(denied.err).toContain("person"); }
  // #933: `task role` reaches the daemon from an agent shell; here the daemon refuses (there is no task #1), not the identity table.
  const taskRole=await cli(f,["task","role","1","backend-engineer"],true); expect(taskRole.code).not.toBe(0); expect(taskRole.err).toContain("no task #1"); expect(taskRole.err).not.toContain("inherited agent markers");
  expect(readFileSync(join(f.dir,".agenthub/config.json"),"utf8")).toBe(f.shared);
});


test("catalog role application is scoped to the named peer and leaves other hand edits pending (#295)", async () => {
  const f=await fixture();
  writeFileSync(join(f.dir,".agenthub/config.local.json"),JSON.stringify({catalog_roles:{kimi:["analyst"]}}));
  expect((await f.client.request({t:"settings_set",key:"catalog_roles.codex",value:["test-engineer"]})).ok).toBe(true);
  const rows=(await f.client.request({t:"settings_get"})).rows;
  expect(rows.find((row:any)=>row.key==="catalog_roles.kimi").value).toEqual([]);
  expect(loadConfig(f.dir).catalog_roles!.kimi).toEqual(["analyst"]);
});


test("stopped session roles cannot abbreviate guidance queued for a differently prepared restart (#295)", async () => {
  const f=await fixture(true);
  expect((await f.client.request({t:"settings_set",key:"catalog_roles.kimi",value:["analyst"]})).ok).toBe(true);
  expect((await f.client.request({t:"peer_start",peer:"kimi"},15000)).ok).toBe(true);
  expect((await f.client.request({t:"task",op:"hub_task_propose",args:{title:"Queued guidance",class:"implement",owner:"kimi"}})).ok).toBe(true);
  expect((await f.client.request({t:"peer_stop",peer:"kimi"},15000)).ok).toBe(true);
  expect(f.daemon.bus.stateOf("kimi")).toBe("offline");
  expect((await f.client.request({t:"settings_set",key:"catalog_roles.kimi",value:["fact-checker"]})).ok).toBe(true);
  expect((await f.client.request({t:"task_catalog_role",id:1,role:"analyst"})).ok).toBe(true);
  const pending=f.daemon.bus.snapshot(false).queues.kimi ?? []; const guidance=pending.find(env=>env.body.includes("catalog role changed"));
  expect(guidance).toBeDefined(); expect(guidance!.body).toContain("## Scope"); expect(guidance!.body).not.toContain("already in your session guidance");
  expect((await f.client.request({t:"peer_start",peer:"kimi"},15000)).ok).toBe(true);
  const row=(await f.client.request({t:"settings_get"})).rows.find((row:any)=>row.key==="catalog_roles.kimi"); expect(row.value).toEqual(["fact-checker"]);
});


test("role visibility preserves legacy peer status shape and uses separate metadata (#295)", async () => {
  const f=await fixture(); const status=(await f.client.request({t:"status"})).status;
  expect(status.peers.codex).toEqual({state:"idle",queued:0});
  expect(status.roleInfo.codex.flowRoles).toEqual(["implementer"]);
  expect(status.roleInfo.codex.catalogRoles.pending).toEqual(["backend-engineer"]);
});

test("turn role preparations retain the native start selection across pending edits and restart (#295)", async () => {
  const f=await fixture(true), key="catalog_roles.kimi", pushes:any[]=[];
  f.client.onPush=message=>pushes.push(message);
  f.client.send({t:"tail"});
  const events=()=>readEvents(join(f.state,"events.jsonl"));
  const ended=()=>events().filter(e=>e.type==="turn_end" && e.peer==="kimi");
  const until=async (condition:()=>boolean)=>{for(let i=0;i<200 && !condition();i++)await Bun.sleep(5);expect(condition()).toBe(true);};
  expect((await f.client.request({t:"settings_set",key,value:["analyst"]})).ok).toBe(true);
  expect((await f.client.request({t:"peer_start",peer:"kimi"},15000)).ok).toBe(true);
  expect((await f.client.request({t:"send",body:"PERMISSION role preparation barrier",to:["kimi"]})).ok).toBe(true);
  await until(()=>pushes.some(p=>p.t==="permission"));
  expect((await f.client.request({t:"settings_set",key,value:["fact-checker"]})).ok).toBe(true);
  const ask=pushes.find(p=>p.t==="permission"); expect((await f.client.request({t:"permit",id:ask.id,option:"yes"})).ok).toBe(true);
  await until(()=>ended().length===1);
  const first=ended()[0]; if(first?.type!=="turn_end")throw new Error("missing completed turn");
  expect(first.preparedRoles).toHaveLength(1); expect(first.preparedRoles?.[0]).toMatchObject({id:"analyst",layer:"shipped"}); expect(first.preparedRoles?.[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
  expect((await f.client.request({t:"peer_stop",peer:"kimi"},15000)).ok).toBe(true);
  expect((await f.client.request({t:"peer_start",peer:"kimi"},15000)).ok).toBe(true);
  expect((await f.client.request({t:"send",body:"restarted role preparation",to:["kimi"]})).ok).toBe(true); await until(()=>ended().length===2);
  const second=ended()[1]; if(second?.type!=="turn_end")throw new Error("missing restarted turn"); expect(second.preparedRoles?.map(r=>r.id)).toEqual(["fact-checker"]);
  expect(first.preparedRoles?.map(r=>r.id)).toEqual(["analyst"]);
  expect((await f.client.request({t:"settings_set",key,value:[]})).ok).toBe(true);
  expect((await f.client.request({t:"peer_stop",peer:"kimi"},15000)).ok).toBe(true);
  expect((await f.client.request({t:"peer_start",peer:"kimi"},15000)).ok).toBe(true);
  expect((await f.client.request({t:"send",body:"empty preparation",to:["kimi"]})).ok).toBe(true); await until(()=>ended().length===3);
  const third=ended()[2]; if(third?.type!=="turn_end")throw new Error("missing empty turn"); expect(third.preparedRoles).toEqual([]);
});

test("external turns keep preparation unknown despite configured catalog ids (#295)", async () => {
  const f=await fixture(); f.peer.turn();
  const ended=readEvents(join(f.state,"events.jsonl")).find(e=>e.type==="turn_end" && e.peer==="codex");
  if(ended?.type!=="turn_end")throw new Error("missing external turn");
  expect(ended.preparedRoles).toBeNull();
});

test("native fallback preamble records explicit empty preparation for unavailable catalog roles (#295)", async () => {
  const f=await fixture(true,["missing-role"]);
  expect((await f.client.request({t:"peer_start",peer:"kimi"},15000)).ok).toBe(true);
  expect((await f.client.request({t:"send",body:"fallback preparation probe",to:["kimi"]})).ok).toBe(true);
  const ended=()=>readEvents(join(f.state,"events.jsonl")).find(e=>e.type==="turn_end" && e.peer==="kimi");
  for(let i=0;i<200 && !ended();i++)await Bun.sleep(5);
  const turn=ended(); if(turn?.type!=="turn_end")throw new Error("missing fallback turn");
  expect(turn.preparedRoles).toEqual([]);
  const row=(await f.client.request({t:"settings_get"})).rows.find((r:any)=>r.key==="catalog_roles.kimi");
  expect(row.value).toEqual([]); expect(row.note).toContain("incompatible or unavailable");
});


test("dashboard role metadata retains separate current and pending catalog guidance (#295)",async()=>{
 const f=await fixture(),status=(await f.client.request({t:"status"})).status;const snapshot=await f.client.request({t:"ui_snapshot"});expect(snapshot.ok).toBe(true);expect(snapshot.status.roleInfo).toEqual(status.roleInfo);expect(snapshot.status.peers.codex).toEqual(status.peers.codex);
});
