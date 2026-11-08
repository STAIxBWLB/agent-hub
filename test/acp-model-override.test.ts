import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpPeer, type AcpOptions } from "../src/adapters/acp.ts";
import { acpLogicalModelId, acpModelAdvertisement, type AcpModelPolicy } from "../src/adapters/acp-model-policy.ts";
import { COMPAT, writeTrust } from "../src/adapters/compat.ts";
import { isNativeModelToken } from "../src/adapters/model-token.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { ADAPTERS, assertNativeCapabilityScope, createProjectAdapterCatalog } from "../src/adapters/registry.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
// Synthetic transport wiring only, not a native-binary setter receipt or an enabled policy.
const POLICY: AcpModelPolicy = { admission: { compatId: "jcode" }, agentName: "fixture ACP", version: COMPAT.jcode.verified.at(-1)!, setter: "set_model", receipt: "synthetic-test-only", modelUpdate: "current_model_update" };
const models = { currentModelId: "baseline", availableModels: ["baseline", "A", "B"].map(modelId => ({ modelId, name: modelId })) };
const configOptions = [{ id: "model", type: "select", currentValue: "baseline", options: ["baseline", "A", "B"].map(value => ({ value, name: value })) }];

function observed(root: string, predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listener.close(); reject(new Error("synthetic ACP observation did not arrive")); }, 2000);
    const check = () => { if (predicate()) { clearTimeout(timer); listener.close(); resolve(); } };
    const listener = watch(root, check); check();
  });
}
async function fixture(extra: Partial<AcpOptions> = {}, fault = "", identity = POLICY.version) {
  const root = mkdtempSync(join(tmpdir(), "ahub-acp-model-")); cleanup.push(() => rmSync(root, { force: true, recursive: true }));
  const trust = join(root, "agent-compat.json");
  const policy = extra.modelPolicy ?? POLICY;
  const encode = (id: string) => policy.idCodec === "qwen-openai" ? `${id}(openai)` : id;
  const wireIds = ["baseline", "A", "B"].map(encode);
  const nativeModels = { currentModelId: encode("baseline"), availableModels: wireIds.map(modelId => ({ modelId, name: modelId })) };
  const nativeConfigOptions = [{ id: "model", type: "select", currentValue: encode("baseline"), options: wireIds.map(value => ({ value, name: value })) }];
  if (policy.admission.compatId !== undefined) writeTrust(policy.admission.compatId, policy.version, false, trust);
  const records = join(root, "records.jsonl"), script = join(root, "fixture.ts");
  writeFileSync(records, "");
  writeFileSync(script, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const records=${JSON.stringify(records)},fault=${JSON.stringify(fault)};
let model=${JSON.stringify(encode('baseline'))};let waiting;let setter;let released=false;
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const update=u=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session',update:u}});
const modelNotice=()=>{send({jsonrpc:'2.0',method:'qwen/notify/session/model-update',params:{v:1,sessionId:'foreign',currentModelId:'not-advertised'}});send({jsonrpc:'2.0',method:'qwen/notify/session/model-update',params:{v:2,sessionId:'session',currentModelId:'not-advertised'}});send({jsonrpc:'2.0',method:'qwen/notify/session/model-update',params:{v:1,sessionId:'session',currentModelId:model}})};
const finish=()=>{if(!released)return;if(setter){send({jsonrpc:'2.0',id:setter.id,result:{}});setter=undefined;}if(!waiting)return;const m=waiting;waiting=undefined;update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'done'}});send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})};
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),p=m.params||{};
const answer=result=>send({jsonrpc:'2.0',id:m.id,result});
if(m.method==='fixture/release'){released=true;answer({released:true});finish();}
else if(m.method==='initialize')answer({protocolVersion:1,agentInfo:{name:'fixture ACP',version:${JSON.stringify(identity)}}});
else if(m.method==='session/new')answer({sessionId:'session',models:${JSON.stringify(nativeModels)},configOptions:${JSON.stringify(nativeConfigOptions)}});
else if(m.method==='session/set_model'||m.method==='session/set_config_option'){
appendFileSync(records,JSON.stringify({method:m.method,model:p.modelId??p.value})+'\\n');
if(fault==='hang')return;if(fault==='reject'){send({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'synthetic refusal'}});return;}
model=p.modelId??p.value;update({sessionUpdate:'current_model_update',currentModelId:model});modelNotice();if(fault==='setter-held'&&!released){setter=m;return;}answer(m.method==='session/set_config_option'?{configOptions:[{id:'model',type:'select',currentValue:model,options:${JSON.stringify(wireIds)}.map(value=>({value,name:value}))}]}:{});}
else if(m.method==='session/prompt'){
appendFileSync(records,JSON.stringify({method:m.method,model})+'\\n');
if(fault==='prompt-reject'){send({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'synthetic prompt refusal'}});return;}
update({sessionUpdate:'current_model_update',currentModelId:model});modelNotice();
send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'foreign',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'foreign'}}}});
waiting=m;finish();}
else if(m.id!==undefined)answer({});});`);
  const applied: string[] = [], rejected: string[] = []; let desired: string | undefined = "A";
  const peer = new AcpPeer("fixture", { cmd: [process.execPath, script], cwd: root, env: { HOME: root, XDG_CONFIG_HOME: join(root, "config"), AGENTHUB_HOME: join(root, "hub") }, modelPolicy: POLICY, modelTrustFile: trust,
    getModelOverride: () => { const selected = desired; return { model: selected, applied: () => applied.push(selected ?? "clear"), rejected: () => rejected.push(selected ?? "clear") }; }, ...extra });
  cleanup.push(() => peer.stop());
  await peer.start();
  // A fake-only RPC shares the actual receive lane and runs after the held setter handler has returned.
  // Filesystem notifications are observation hints, not an acknowledgement/release protocol.
  const transport = peer as unknown as { request(method: string, params: unknown): Promise<unknown> };
  const rows = () => readFileSync(records, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { method: string; model: string });
  const idle = () => peer.state === "idle" ? Promise.resolve() : new Promise<void>(resolve => { const old = peer.onState; peer.onState = state => { old?.(state); if (state === "idle") { peer.onState = old; resolve(); } }; });
  return { root, trust, peer, rows, applied, rejected, choose: (model: string | undefined) => { desired = model; }, release: async () => { expect(await transport.request("fixture/release", {})).toEqual({ released: true }); }, idle,
    waitPrompts: (count: number) => observed(root, () => rows().filter(row => row.method === "session/prompt").length === count) };
}

test("only receipted exact Kimi headless policy is admitted; foreign definitions cannot claim the capability", () => {
  expect(ADAPTERS.filter(definition => definition.modelOverride?.acp).map(definition => ({ kind: definition.kind, policy: definition.modelOverride!.acp }))).toEqual([
    { kind: "kimi", policy: { admission: { nativeIdentity: true }, agentName: "Kimi Code CLI", version: "2.5.2", setter: "set_config_option", modelUpdate: "config_option_update", receipt: "docs/verification/2026-11-08-kimi-252-model-setter-1317.md" } },
  ]);
  const source = createProjectAdapterCatalog({ foreign: { transport: "acp", command: "not-executed", args: [], displayName: "Foreign", roles: ["implementer"] } }).definitionOf("foreign")!;
  expect(() => assertNativeCapabilityScope({ ...source, modelOverride: { boundary: "turn", acp: POLICY } })).toThrow("modelOverride");
});
test("advertisements require bounded exact ids/current baseline for both proven shapes", () => {
  expect(acpModelAdvertisement(POLICY, { models })).toEqual({ current: "baseline", available: ["baseline", "A", "B"], wire: { baseline: "baseline", A: "A", B: "B" } });
  const configPolicy = { ...POLICY, setter: "set_config_option" as const };
  expect(acpModelAdvertisement(configPolicy, { configOptions })).toEqual({ current: "baseline", available: ["baseline", "A", "B"], wire: { baseline: "baseline", A: "A", B: "B" } });
  for (const bad of [null, {}, { models: { ...models, currentModelId: "unknown" } }, { models: { ...models, availableModels: [...models.availableModels, models.availableModels[0]] } },
    { models: { ...models, availableModels: Array.from({ length: 257 }, (_, i) => ({ modelId: `M${i}` })) } }]) expect(acpModelAdvertisement(POLICY, bad)).toBeUndefined();
  expect(acpModelAdvertisement(configPolicy, { configOptions: [...configOptions, ...configOptions] })).toBeUndefined();
});
test("captured A remains current while B is desired; setter ACK/control updates are not prompt admission; clear restores baseline", async () => {
  const f = await fixture(); expect(f.peer.modelOverrideState.available).toBe(true); expect(f.peer.modelOverrideState.baseline).toBe("baseline");
  await f.peer.deliver([newEnvelope("user", "synthetic A")]); await f.waitPrompts(1);
  expect(f.applied).toEqual([]); expect(f.peer.modelOverrideState.baseline).toBe("baseline"); f.choose("B");
  expect(f.rows().filter(row => row.method === "session/prompt")).toEqual([{ method: "session/prompt", model: "A" }]);
  const idle = f.idle(); await f.release(); await idle; expect(f.applied).toEqual(["A"]);
  await f.peer.deliver([newEnvelope("user", "synthetic B")]); await f.idle();
  f.choose(undefined); await f.peer.deliver([newEnvelope("user", "synthetic clear")]); await f.idle();
  expect(f.rows().filter(row => row.method === "session/prompt").map(row => row.model)).toEqual(["A", "B", "baseline"]);
  expect(f.applied).toEqual(["A", "B", "clear"]); expect(f.peer.modelOverrideState.baseline).toBe("baseline");
});
test("set_config_option uses only the model option with the same turn admission fence", async () => {
  const f = await fixture({ modelPolicy: { ...POLICY, setter: "set_config_option", modelUpdate: "config_option_update" } });
  await f.peer.deliver([newEnvelope("user", "synthetic config")]); await f.waitPrompts(1);
  expect(f.rows()[0]).toEqual({ method: "session/set_config_option", model: "A" }); expect(f.applied).toEqual([]);
  const idle = f.idle(); await f.release(); await idle; expect(f.applied).toEqual(["A"]);
});
test("unknown models and mismatched native versions refuse before setter or prompt effects", async () => {
  const f = await fixture(); f.choose("not-advertised");
  await expect(f.peer.deliver([newEnvelope("user", "synthetic unknown")])).rejects.toThrow("not advertised");
  expect(f.rows()).toEqual([]); expect(f.applied).toEqual([]); expect(f.rejected).toEqual(["not-advertised"]);
  const wrong = await fixture({}, "", "0.0.0"); expect(wrong.peer.modelOverrideState.available).toBe(false);
  await expect(wrong.peer.deliver([newEnvelope("user", "synthetic wrong version")])).rejects.toThrow("not advertised"); expect(wrong.rows()).toEqual([]);
});
test("definitive setter rejection retires only the unadmitted selection; timeout stops owned transport without a prompt", async () => {
  const refused = await fixture({}, "reject");
  await expect(refused.peer.deliver([newEnvelope("user", "synthetic refused")])).rejects.toThrow("refused");
  expect(refused.rejected).toEqual(["A"]); expect(refused.applied).toEqual([]); expect(refused.rows().some(row => row.method === "session/prompt")).toBe(false);
  const hung = await fixture({ modelSetterTimeoutMs: 25 }, "hang");
  await expect(hung.peer.deliver([newEnvelope("user", "synthetic timeout")])).rejects.toThrow("unknown");
  expect(hung.peer.state).toBe("offline"); expect(hung.peer.modelOverrideState.available).toBe(false); expect(hung.applied).toEqual([]);
  expect(hung.rows().some(row => row.method === "session/prompt")).toBe(false);
}, 20000);

test("selection is captured before an awaited setter; stop invalidates the held setter without sending a prompt", async () => {
  const f = await fixture({}, "setter-held");
  const delivery = f.peer.deliver([newEnvelope("user", "synthetic held setter")]);
  await observed(f.root, () => f.rows().length === 1); f.choose("B");
  expect(f.rows()[0]?.model).toBe("A");
  await f.release(); await delivery; await f.idle(); expect(f.applied).toEqual(["A"]);
  await f.peer.deliver([newEnvelope("user", "synthetic next turn")]); await f.idle();
  expect(f.rows().filter(row => row.method === "session/prompt").map(row => row.model)).toEqual(["A", "B"]);
  const stopped = await fixture({}, "setter-held");
  const rejected = stopped.peer.deliver([newEnvelope("user", "synthetic stop")]).then(() => undefined, (error: unknown) => error);
  await observed(stopped.root, () => stopped.rows().length === 1); await stopped.peer.stop();
  expect(await rejected).toBeInstanceOf(Error);
  expect(stopped.rows().some(row => row.method === "session/prompt")).toBe(false); expect(stopped.applied).toEqual([]);
}, 20000);
test("prompt rejection after setter success does not certify application", async () => {
  const f = await fixture({}, "prompt-reject");
  await f.peer.deliver([newEnvelope("user", "synthetic prompt refusal")]); await f.idle();
  expect(f.applied).toEqual([]); expect(f.rejected).toEqual(["A"]);
  expect(f.rows().map(row => row.method)).toEqual(["session/set_model", "session/prompt"]);
});

test("an unavailable optional setter leaves ordinary no-override ACP delivery unchanged", async () => {
  const f = await fixture({ getModelOverride: () => undefined }, "", "0.0.0");
  expect(f.peer.modelOverrideState.available).toBe(false);
  await f.peer.deliver([newEnvelope("user", "synthetic legacy")]); await f.waitPrompts(1);
  expect(f.rows().map(row => row.method)).toEqual(["session/prompt"]);
  const idle = f.idle(); await f.release(); await idle; expect(f.applied).toEqual([]);
});

test("Qwen versioned model notifications require the current session and never admit a prompt", async () => {
  const f = await fixture({ modelPolicy: { ...POLICY, setter: "set_config_option", modelUpdate: "qwen/notify/session/model-update" } });
  await f.peer.deliver([newEnvelope("user", "synthetic model notice")]); await f.waitPrompts(1);
  expect(f.peer.modelOverrideState.available).toBe(true); expect(f.applied).toEqual([]);
  const idle = f.idle(); await f.release(); await idle; expect(f.applied).toEqual(["A"]);
});

test("person-trusted admission and the exact setter receipt are independent; revocation during setter blocks the prompt", async () => {
  const version = "99.0.0", policy: AcpModelPolicy = { ...POLICY, version, admission: { compatId: "qwen" } };
  const f = await fixture({ modelPolicy: policy }, "setter-held", version);
  expect(f.peer.modelOverrideState.available).toBe(true);
  const failed = f.peer.deliver([newEnvelope("user", "synthetic revoked trust")]).then(() => undefined, (error: unknown) => error);
  await observed(f.root, () => f.rows().length === 1);
  writeTrust("qwen", version, true, f.trust);
  expect(f.peer.modelOverrideState.available).toBe(false);
  await f.release(); const failure = await failed;
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain("changed");
  expect(f.rows().some(row => row.method === "session/prompt")).toBe(false); expect(f.applied).toEqual([]);
  const mismatch = await fixture({ modelPolicy: policy }, "", "99.0.1");
  expect(mismatch.peer.modelOverrideState.available).toBe(false);
  await expect(mismatch.peer.deliver([newEnvelope("user", "synthetic wrong receipt version")])).rejects.toThrow("not advertised");
  expect(mismatch.rows()).toEqual([]);
});
test("explicit native-identity admission does not inherit reviewer compatibility admission", async () => {
  const version = "99.0.0";
  const f = await fixture({ modelPolicy: { ...POLICY, admission: { nativeIdentity: true }, version } }, "", version);
  expect(f.peer.modelOverrideState.available).toBe(true);
  await f.peer.deliver([newEnvelope("user", "synthetic identity-only admission")]); await f.waitPrompts(1);
  expect(f.applied).toEqual([]); const idle = f.idle(); await f.release(); await idle; expect(f.applied).toEqual(["A"]);
});

test("optional Qwen OpenAI codec binds logical tokens to exact advertised wire ids without changing person grammar", () => {
  const policy: AcpModelPolicy = { ...POLICY, setter: "set_config_option", idCodec: "qwen-openai" };
  const model = (value: string) => ({ value, name: "ignored label" });
  const session = (currentValue: string, values: string[]) => ({ configOptions: [{ id: "model", type: "select", currentValue, options: values.map(model) }] });
  expect(acpModelAdvertisement(policy, session("A(openai)", ["A(openai)", "B(openai)"]))).toEqual({ current: "A", available: ["A", "B"], wire: { A: "A(openai)", B: "B(openai)" } });
  expect(acpLogicalModelId(policy, "A(openai)")).toBe("A"); expect(isNativeModelToken("A(openai)")).toBe(false);
  for (const invalid of ["A", "A(anthropic)", "A(openai)extra", "A(OPENAI)", "bad model(openai)", `${"A".repeat(129)}(openai)`]) expect(acpLogicalModelId(policy, invalid)).toBeUndefined();
  expect(acpModelAdvertisement(policy, session("unknown(openai)", ["A(openai)"]))).toBeUndefined();
  expect(acpModelAdvertisement(policy, session("A(openai)", ["A(openai)", "A(openai)"]))).toBeUndefined();
  expect(acpModelAdvertisement(policy, session("A(openai)", ["A(openai)", "B(anthropic)"]))).toBeUndefined();
  expect(acpModelAdvertisement(POLICY, { models: { currentModelId: "A(openai)", availableModels: [{ modelId: "A(openai)" }] } })).toBeUndefined();
});

test("actual ACP codec path sends advertised OpenAI wire ids while retaining logical capture and baseline", async () => {
  const f = await fixture({ modelPolicy: { ...POLICY, setter: "set_config_option", idCodec: "qwen-openai", modelUpdate: "qwen/notify/session/model-update" } });
  expect(f.peer.modelOverrideState.baseline).toBe("baseline");
  await f.peer.deliver([newEnvelope("user", "synthetic encoded override")]); await f.waitPrompts(1);
  expect(f.rows()[0]).toEqual({ method: "session/set_config_option", model: "A(openai)" }); expect(f.applied).toEqual([]);
  const idle = f.idle(); await f.release(); await idle; expect(f.applied).toEqual(["A"]);
  f.choose(undefined); await f.peer.deliver([newEnvelope("user", "synthetic encoded clear")]); await f.idle();
  expect(f.rows().filter(row => row.method === "session/set_config_option").map(row => row.model)).toEqual(["A(openai)", "baseline(openai)"]);
  expect(f.peer.modelOverrideState.baseline).toBe("baseline"); expect(f.applied).toEqual(["A", "clear"]);
});
