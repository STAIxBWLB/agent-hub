import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpOwnedGroup } from "../src/adapters/acp-owned-group.ts";
import { AcpPeer, type AcpOptions, type PermissionRequest } from "../src/adapters/acp.ts";
import { KIMI_2_1_1_5H_REFUSAL_PREFIX } from "../src/adapters/acp-quota.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { readProcessTable } from "../src/hub/child-process.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(10);
  expect(condition()).toBe(true);
};
interface FakeConfig {
  exitBeforeInitialize?: boolean;
  newSessionId?: unknown;
  omitNewSessionId?: boolean;
  agent?: string;
  modes?: string[];
  rejectMode?: string;
  holdMode?: boolean;
  holdModeId?: string;
  loadEcho?: string | false;
  kind?: unknown;
  permission?: boolean;
  quota?: boolean;
  stderr?: string;
  modeError?: string;
  quotaError?: string;
}
async function fixture(config: FakeConfig = {}, options: Partial<AcpOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-configured-acp-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, "requests.jsonl"), script = join(root, "fake.ts");
  writeFileSync(log, "");
  writeFileSync(script, `
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const config=${JSON.stringify(config)}, log=${JSON.stringify(log)};
const send=(message:any)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\\n');
if(config.stderr) process.stderr.write(config.stderr+'\\n');
if(config.exitBeforeInitialize && !existsSync(log+'.exited')) { writeFileSync(log+'.exited','yes'); process.exit(0); }
let permissionPrompt:any;
for await(const line of createInterface({input:process.stdin})) {
  const msg=JSON.parse(line); appendFileSync(log,JSON.stringify(msg)+'\\n');
  if(!msg.method) {
    if(permissionPrompt && msg.id===1000) {
      send({method:'session/update',params:{sessionId:'configured-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(msg.result)}}}});
      send({id:permissionPrompt.id,result:{stopReason:'end_turn'}}); permissionPrompt=undefined;
    }
  } else if(msg.method==='initialize') send({id:msg.id,result:{protocolVersion:1,agentInfo:{name:config.agent??'Configured Fixture',version:'1.0'},agentCapabilities:{loadSession:true}}});
  else if(msg.method==='session/new'||msg.method==='session/load') send({id:msg.id,result:{...((msg.method==='session/load'&&config.loadEcho===false)||(msg.method==='session/new'&&config.omitNewSessionId)?{}:{sessionId:msg.method==='session/new'&&Object.hasOwn(config,'newSessionId')?config.newSessionId:msg.method==='session/load'&&typeof config.loadEcho==='string'?config.loadEcho:msg.params.sessionId??'configured-session'}),modes:{currentModeId:'unsafe-old',availableModes:(config.modes??['safe','auto-safe','unsafe','read-only']).map((id:string)=>({id,name:id}))}}});
  else if(msg.method==='session/set_mode') {
    if(config.holdMode || config.holdModeId===msg.params.modeId) continue;
    if(msg.params.modeId===config.rejectMode) send({id:msg.id,error:{code:-32000,message:config.modeError??'mode rejected by fixture'}});
    else send({id:msg.id,result:{}});
  } else if(msg.method==='session/prompt') {
    if(config.quota) send({id:msg.id,error:{code:-32603,message:config.quotaError??${JSON.stringify(KIMI_2_1_1_5H_REFUSAL_PREFIX)}}});
    else if(config.permission) { permissionPrompt=msg; send({id:1000,method:'session/request_permission',params:{sessionId:'configured-session',toolCall:{toolCallId:'call-1',title:'mcp__agent-hub__hub_review',kind:config.kind,rawInput:{probe:true}},options:[{optionId:'once',name:'Allow once',kind:'allow_once'},{optionId:'always',name:'Allow always',kind:'allow_always'},{optionId:'reject',name:'Reject once',kind:'reject_once'}]}}); }
    else { send({method:'session/update',params:{sessionId:'configured-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ok'}}}}); send({id:msg.id,result:{stopReason:'end_turn'}}); }
  } else if(msg.id!==undefined) send({id:msg.id,result:{}});
}
`);
  const peer = new AcpPeer("fixture", { cmd: [process.execPath, script], cwd: root, ...options });
  cleanup.push(() => peer.stop());
  const messages: string[] = [];
  peer.onMessage = body => { messages.push(body); };
  const requests = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const modes = () => requests().filter(message => message.method === "session/set_mode").map(message => message.params.modeId);
  const prompt = async () => {
    await peer.deliver([newEnvelope("user", "fixture prompt", { to: [peer.id] })]);
    await until(() => messages.length > 0 && peer.state === "idle");
    return JSON.parse(messages.at(-1)!);
  };
  return { root, peer, requests, modes, messages, prompt };
}
const policy = { modes: { ask: "safe", "ask-when-needed": "auto-safe", "never-ask": "unsafe" } } as const;

for (const resume of [false, true]) test(`#451 configured ACP mode map is ACKed before ${resume ? "resumed" : "fresh"} startup and runtime changes`, async () => {
  const f = await fixture({}, { nativePolicy: policy, ...(resume ? { resumeSessionId: "configured-session", requireLoadSessionEcho: true } : {}) });
  await f.peer.start();
  expect(f.modes()).toEqual(["safe"]);
  expect(f.requests().some(message => message.method === (resume ? "session/load" : "session/new"))).toBe(true);
  expect(f.peer.permissionModeState).toBe("ask");
  await f.peer.setPermissionMode("never-ask");
  expect(f.modes()).toEqual(["safe", "unsafe"]);
  expect(f.peer.permissionModeState).toBe("never-ask");
}, 20_000);

for (const selected of ["ask", "never-ask"] as const) test(`#451 configured ACP refuses a partial mode map missing selected ${selected}`, async () => {
  const f = await fixture({}, { nativePolicy: { modes: selected === "ask" ? { "never-ask": "unsafe" } : { ask: "safe" } }, permissionMode: selected });
  await expect(f.peer.start()).rejects.toThrow(/unavailable|mapping|mode/);
  expect(f.peer.state).toBe("offline"); expect(f.modes()).toEqual([]);
}, 20_000);

for (const failure of ["missing", "reject", "timeout"] as const) test(`#451 configured ACP startup fails closed for ${failure} native mode acknowledgement`, async () => {
  const f = await fixture({ ...(failure === "missing" ? { modes: ["unsafe"] } : {}), ...(failure === "reject" ? { rejectMode: "safe" } : {}), ...(failure === "timeout" ? { holdMode: true } : {}) }, { nativePolicy: policy, permissionModeTimeoutMs: 80 });
  await expect(f.peer.start()).rejects.toThrow(/unavailable|refused|unknown/);
  expect(f.peer.state).toBe("offline");
}, 20_000);

test("#451 configured ACP partial mapping refuses unmapped runtime choices without changing acknowledged mode", async () => {
  const f = await fixture({}, { nativePolicy: { modes: { ask: "safe" } } });
  await f.peer.start();
  await expect(f.peer.setPermissionMode("never-ask")).rejects.toThrow(/unavailable|mapping|mode/);
  expect(f.modes()).toEqual(["safe"]); expect(f.peer.permissionModeState).toBe("ask");
}, 20_000);

for (const resume of [false, true]) test(`#451 explicit unmanaged policy suppresses Kimi identity-inferred modes${resume ? " on resume" : ""}`, async () => {
  const f = await fixture({ agent: "Kimi Code CLI", modes: ["default", "auto", "yolo"] }, { nativePolicy: {}, permissionMode: "never-ask", ...(resume ? { resumeSessionId: "configured-session" } : {}) });
  await f.peer.start();
  expect(f.modes()).toEqual([]); expect(f.peer.permissionModeState).toBe("unmanaged");
  await expect(f.peer.setPermissionMode("ask")).rejects.toThrow(/unmanaged/);
  expect(f.modes()).toEqual([]);
}, 20_000);

test("#451 configured policy suppresses Kimi-only quota classification even when native identity advertises Kimi", async () => {
  let quota = 0; const failures: string[] = [];
  const f = await fixture({ agent: "Kimi Code CLI", quota: true }, { nativePolicy: {}, onQuotaRefusal: () => { quota++; return true; }, onTurnFailure: (_envs, reason) => { failures.push(reason); } });
  await f.peer.start(); await f.peer.deliver([newEnvelope("user", "quota fixture", { to: [f.peer.id] })]);
  await until(() => failures.length === 1);
  expect(quota).toBe(0); expect(failures).toEqual(["Configured ACP prompt failed"]);
}, 20_000);

for (const kind of ["edit", "delete", "move", "execute", "fetch", "other", undefined, { kind: "read" }]) test(`#451 locked read-only ACP rejects ${JSON.stringify(kind)} before auto-approval and console`, async () => {
  let auto = 0, console_ = 0;
  const f = await fixture({ permission: true, kind }, { nativePolicy: { readOnly: "read-only", lockedReadOnly: true }, permissionMode: "never-ask", autoApprove: () => { auto++; return true; }, onPermission: async () => { console_++; return "always"; } });
  await f.peer.start(); expect(f.modes()).toEqual(["read-only"]);
  const result = await f.prompt();
  expect(result.outcome).toEqual({ outcome: "selected", optionId: "reject" });
  expect(auto).toBe(0); expect(console_).toBe(0);
  await expect(f.peer.setPermissionMode("never-ask")).rejects.toThrow(/read.only|locked/);
  expect(f.modes()).toEqual(["read-only"]);
}, 20_000);

for (const kind of ["read", "search", "think"]) test(`#451 locked read-only ACP preserves ${kind} requests but never offers session-wide allow`, async () => {
  const seen: PermissionRequest[] = [];
  const f = await fixture({ permission: true, kind }, { nativePolicy: { readOnly: "read-only", lockedReadOnly: true }, onPermission: async request => { seen.push(request); return "once"; } });
  await f.peer.start();
  expect((await f.prompt()).outcome).toEqual({ outcome: "selected", optionId: "once" });
  expect(seen).toHaveLength(1); expect(seen[0]?.kind).toBe(kind);
  expect(seen[0]!.options.some(option => option.kind === "allow_always")).toBe(false);
}, 20_000);

test("#451 locked read-only ACP refuses an approver's removed allow-always option", async () => {
  const f = await fixture({ permission: true, kind: "read" }, { nativePolicy: { readOnly: "read-only", lockedReadOnly: true }, onPermission: async () => "always" });
  await f.peer.start(); expect((await f.prompt()).outcome).toEqual({ outcome: "cancelled" });
}, 20_000);

for (const failure of ["missing", "reject", "timeout"] as const) test(`#451 locked read-only ACP refuses ${failure} read-only mode`, async () => {
  const f = await fixture({ ...(failure === "missing" ? { modes: ["safe"] } : {}), ...(failure === "reject" ? { rejectMode: "read-only" } : {}), ...(failure === "timeout" ? { holdMode: true } : {}) }, { nativePolicy: { readOnly: "read-only", lockedReadOnly: true }, permissionModeTimeoutMs: 80 });
  await expect(f.peer.start()).rejects.toThrow(/unavailable|refused|unknown/);
  expect(f.peer.state).toBe("offline");
}, 20_000);


test("#451 configured ACP preserves explicit agent identity pinning", async () => {
  const f = await fixture({}, { nativePolicy: {}, expectedAgent: { name: "Another Agent", version: "1.0" } });
  await expect(f.peer.start()).rejects.toThrow(/identity/);
  expect(f.peer.state).toBe("offline"); expect(f.modes()).toEqual([]);
}, 20_000);

for (const loadEcho of [false, "another-session"] as const) test(`#451 configured ACP refuses a ${loadEcho === false ? "missing" : "different"} restored session echo`, async () => {
  const f = await fixture({ loadEcho }, { nativePolicy: policy, resumeSessionId: "configured-session", requireLoadSessionEcho: true });
  await expect(f.peer.start()).rejects.toThrow(/load did not confirm/);
  expect(f.peer.state).toBe("offline"); expect(f.modes()).toEqual([]);
}, 20_000);

test("#451 configured ACP unanswered runtime mode change stays unknown and offline", async () => {
  const f = await fixture({ holdModeId: "unsafe" }, { nativePolicy: policy, permissionModeTimeoutMs: 80 });
  await f.peer.start();
  await expect(f.peer.setPermissionMode("never-ask")).rejects.toThrow(/unknown/);
  expect(f.peer.state).toBe("offline"); expect(f.peer.permissionModeState).toBe("unknown");
}, 20_000);

test("#451 locked read-only ACP requires an explicit read-only mode id", async () => {
  const f = await fixture({}, { nativePolicy: { lockedReadOnly: true } });
  await expect(f.peer.start()).rejects.toThrow(/unavailable/);
  expect(f.peer.state).toBe("offline"); expect(f.modes()).toEqual([]);
}, 20_000);

test("#451 locked read-only ACP auto-approves a read at most once", async () => {
  let console_ = 0;
  const f = await fixture({ permission: true, kind: "read" }, { nativePolicy: { readOnly: "read-only", lockedReadOnly: true }, autoApprove: () => true, onPermission: async () => { console_++; return "always"; } });
  await f.peer.start();
  expect((await f.prompt()).outcome).toEqual({ outcome: "selected", optionId: "once" });
  expect(console_).toBe(0);
}, 20_000);


test("#451 configured ACP proves its spawned group before handshake and stops that owned group", async () => {
  const f = await fixture({}, { nativePolicy: policy, requireOwnedGroup: true });
  await f.peer.start();
  expect(f.peer.state).toBe("idle"); expect(f.modes()).toEqual(["safe"]);
  expect(f.peer.pendingOwnedProcess).toBe(true);
  await f.peer.stop(); expect(f.peer.state).toBe("offline");
  expect(f.peer.pendingOwnedProcess).toBe(false);
  await f.peer.stop(); // Already-empty proven group cleanup is idempotent.
}, 20_000);


test("#451 configured ACP logs withhold native stderr and prompt error payloads", async () => {
  const logs: string[] = [], failures: string[] = [];
  const f = await fixture({ stderr: "NATIVE_PRIVATE_PAYLOAD", quota: true }, { nativePolicy: {}, log: line => { logs.push(line); }, onTurnFailure: (_envs, reason) => { failures.push(reason); } });
  await f.peer.start(); await until(() => logs.length > 0);
  await f.peer.deliver([newEnvelope("user", "quota fixture", { to: [f.peer.id] })]);
  await until(() => failures.length === 1);
  expect(logs.join("\n")).not.toContain("NATIVE_PRIVATE_PAYLOAD");
  expect(logs.join("\n")).not.toContain(KIMI_2_1_1_5H_REFUSAL_PREFIX);
  expect(logs.join("\n")).toContain("withheld");
}, 20_000);


test("#451 configured ACP native error bodies never reach failure callbacks, delivery receipts or runtime mode errors", async () => {
  const logs: string[] = [], failures: string[] = [], receipts: unknown[] = [];
  const f = await fixture({ quota: true, quotaError: "NATIVE_PRIVATE_PROMPT_PAYLOAD", rejectMode: "unsafe", modeError: "NATIVE_PRIVATE_MODE_PAYLOAD" }, { nativePolicy: policy, log: line => { logs.push(line); }, onTurnFailure: (_envs, reason) => { failures.push(reason); } });
  f.peer.onDelivery = receipt => { receipts.push(receipt); };
  await f.peer.start();
  await f.peer.deliver([newEnvelope("user", "quota fixture", { to: [f.peer.id] })], "configured-private-error");
  await until(() => failures.length === 1 && receipts.some(receipt => (receipt as {state?:string}).state === "needs_review"));
  expect(failures).toEqual(["Configured ACP prompt failed"]);
  const published = JSON.stringify({logs,failures,receipts});
  expect(published).not.toContain(KIMI_2_1_1_5H_REFUSAL_PREFIX);
  expect(published).not.toContain("NATIVE_PRIVATE_PROMPT_PAYLOAD");
  let error: unknown;
  try { await f.peer.setPermissionMode("never-ask"); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("Configured ACP native permission mode refused");
  expect((error as Error).message).not.toContain("NATIVE_PRIVATE_MODE_PAYLOAD");
}, 20_000);

test("#451 configured ACP retains an offline process handle after refused teardown and supports a later verified stop", async () => {
  const f = await fixture({}, { nativePolicy: policy, requireOwnedGroup: true });
  await f.peer.start();
  // Fault-inject only a rejected public stop; the captured identity/proof and actual child stay untouched.
  const stop = spyOn(AcpOwnedGroup.prototype, "stop").mockRejectedValueOnce(new Error("Configured ACP process ownership could not be verified"));
  try {
    await expect(f.peer.stop()).rejects.toThrow(/ownership/);
    expect(f.peer.state).toBe("offline"); expect(f.peer.pendingOwnedProcess).toBe(true);
    await expect(f.peer.start()).rejects.toThrow(/still has a process/);
  } finally { stop.mockRestore(); }
  await f.peer.stop(); expect(f.peer.pendingOwnedProcess).toBe(false);
}, 20_000);

const invalidNewSessions: [string, FakeConfig][] = [
  ["missing", { omitNewSessionId: true }],
  ["nonstring", { newSessionId: 42 }],
  ["null", { newSessionId: null }],
  ["empty", { newSessionId: "" }],
  ["whitespace", { newSessionId: "   " }],
  ["oversize", { newSessionId: "x".repeat(4097) }],
  ["control", { newSessionId: "bad\nidentity" }],
];
for (const [label, config] of invalidNewSessions) test(`#451 configured ACP rejects ${label} session/new identity before idle or prompt`, async () => {
  const f = await fixture(config, { nativePolicy: {} });
  const states: string[] = [];
  f.peer.onState = state => { states.push(state); };
  await expect(f.peer.start()).rejects.toThrow("valid native session identity");
  expect(f.peer.state).toBe("offline");
  expect(states).not.toContain("idle");
  expect(f.requests().some(message => message.method === "session/prompt")).toBe(false);
  expect(f.peer.recoveryMetadata().sessionId).toBeFalsy();
}, 20_000);

test("#451 valid legacy ACP startup retains its native session and permission behavior", async () => {
  const f = await fixture();
  await f.peer.start();
  expect(f.peer.state).toBe("idle");
  expect(f.peer.recoveryMetadata().sessionId).toBe("configured-session");
  expect(f.peer.permissionModeState).toBe("unmanaged");
  expect(f.modes()).toEqual([]);
}, 20_000);

test("#451 configured ACP missing executable clears its handle and permits same-object retry", async () => {
  const command = [join(tmpdir(), "ahub-missing-acp-" + crypto.randomUUID())];
  const f = await fixture({}, { cmd: command, nativePolicy: {}, requireOwnedGroup: true });
  await expect(f.peer.start()).rejects.toThrow();
  expect(f.peer.pendingOwnedProcess).toBe(false);
  command.splice(0, command.length, process.execPath, join(f.root, "fake.ts"));
  await f.peer.start();
  await Bun.sleep(20); // A queued failed-spawn callback must not offline the new owner.
  expect(f.peer.state).toBe("idle");
  await f.peer.stop(); expect(f.peer.pendingOwnedProcess).toBe(false);
}, 20_000);

test("#451 configured ACP early exit is positively cleared and same-object retry succeeds", async () => {
  const f = await fixture({ exitBeforeInitialize: true }, { nativePolicy: {}, requireOwnedGroup: true });
  const capture = spyOn(AcpOwnedGroup, "capture");
  try {
    await expect(f.peer.start()).rejects.toThrow();
    const child = capture.mock.calls[0]?.[0];
    expect(child?.pid).toBeDefined();
    expect(f.peer.pendingOwnedProcess).toBe(false);
    const rows = await readProcessTable();
    expect(rows).toBeDefined();
    expect(rows!.some(row => row.pid === child!.pid || row.pgid === child!.pid)).toBe(false);
    await f.peer.start();
    expect(f.peer.state).toBe("idle");
    await f.peer.stop(); expect(f.peer.pendingOwnedProcess).toBe(false);
  } finally { capture.mockRestore(); }
}, 20_000);
