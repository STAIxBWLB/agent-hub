import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
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
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-role-settings-")), state = join(dir, ".agenthub/state"); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const shared = JSON.stringify({ roles: DEFAULT_CONFIG.roles, memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, snapshots: { enabled: false }, catalog_roles: { codex: ["backend-engineer"] } });
  writeFileSync(join(dir, ".agenthub/config.json"), shared);
  writeFileSync(join(dir, ".agenthub/routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"'));
  const daemon = await startDaemon({ cwd: dir, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: loadConfig(dir) }); cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(state, { role: "console" }); cleanup.push(() => client.close());
  const peer = new Peer("codex"); daemon.bus.add(peer); await peer.start();
  const tools = await ControlClient.connect(state, { role: "tools", peer: "codex" }); cleanup.push(() => tools.close());
  return { dir, state, shared, daemon, client, tools, peer };
}
test("catalog settings validate two compatible ids and preserve shared config through write and undo (#295)", async () => {
  const f = await fixture(), key = "catalog_roles.codex", def = settingDef(key); expect(typeof def).toBe("object");
  if (typeof def === "string") throw new Error(def);
  expect(def).toMatchObject({ group: "Roles", type: "roles", store: "config", applies: "peer start", risk: "safe" });
  for (const bad of ["backend-engineer", ["code-reviewer"], ["missing"], ["backend-engineer", "backend-engineer"], ["backend-engineer", "test-engineer", "frontend-engineer"]]) {
    expect((await f.client.request({ t: "settings_set", key, value: bad })).ok).toBe(false);
  }
  expect(checkSettingValue(def, [], ["backend-engineer"])).toEqual([]);
  expect((await f.client.request({ t: "settings_set", key, value: ["test-engineer"] })).ok).toBe(true);
  expect(loadConfig(f.dir).catalog_roles!.codex).toEqual(["test-engineer"]); expect(readFileSync(join(f.dir, ".agenthub/config.json"), "utf8")).toBe(f.shared);
  const view = await f.client.request({ t: "settings_get" }); const row = view.rows.find((row: any) => row.key === key);
  expect(row.pending).toEqual(["test-engineer"]); expect(row.note).toContain("unconfirmed");
  expect((await f.client.request({ t: "settings_undo" })).ok).toBe(true); expect(loadConfig(f.dir).catalog_roles!.codex).toEqual(["backend-engineer"]);
  const roles = readEvents(join(f.state, "events.jsonl")).filter(event => event.type === "role" && event.stage === "assigned"); expect(roles).toHaveLength(2); expect(JSON.stringify(roles)).not.toContain("## Scope");
});
test("agent shells and tools clients cannot mutate session or existing task roles (#295)", async () => {
  const f = await fixture();
  for (const op of ["assign", "clear"]) expect(classifyPeerCommand("role", [op, "codex", "backend-engineer"])).toBe("console"); expect(classifyPeerCommand("task", ["role", "1", "backend-engineer"])).toBe("console");
  for (const msg of [{ t: "settings_set", key: "catalog_roles.codex", value: [] }, { t: "task_catalog_role", id: 1, role: "backend-engineer" }, { t: "settings_undo" }]) expect((await f.tools.request(msg)).ok).toBe(false);
  const peer = await ControlClient.connect(f.state, { role: "peer", peer: "other", channel: false }); cleanup.push(() => peer.close());
  expect((await peer.request({ t: "settings_set", key: "catalog_roles.codex", value: [] })).ok).toBe(false); expect((await peer.request({ t: "task_catalog_role", id: 1, role: null })).ok).toBe(false);
});
test("person task role changes keep ownership and private stubs while delivering bounded guidance (#295)", async () => {
  const f = await fixture();
  expect((await f.tools.request({ t: "task", op: "hub_task_propose", args: { title: "Work", class: "implement", owner: "codex" } })).ok).toBe(true);
  const board = new Board(join(f.state, "hub.db")); cleanup.push(() => board.close()); const before = board.get(1)!;
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
