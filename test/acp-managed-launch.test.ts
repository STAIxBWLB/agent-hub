import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpPeer, managedAcpLaunch, verifyManagedAcpLaunch, type AcpOptions } from "../src/adapters/acp.ts";
import { AcpOwnedGroup } from "../src/adapters/acp-owned-group.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture(owned = true, rejectMode = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-managed-acp-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "fake.ts");
  writeFileSync(script, `import {createInterface} from "node:readline";
const send=(msg:any)=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",...msg})+"\\n");
for await(const line of createInterface({input:process.stdin})) {
  const msg=JSON.parse(line);
  if(msg.method==="initialize") send({id:msg.id,result:{protocolVersion:1,agentInfo:{name:"Managed fixture",version:"1"}}});
  else if(msg.method==="session/new") send({id:msg.id,result:{sessionId:"actual-native-session",modes:{availableModes:[{id:"safe"}]}}});
  else if(msg.method==="session/set_mode") send(${rejectMode ? '{id:msg.id,error:{code:-32000,message:"fixture mode refusal"}}' : '{id:msg.id,result:{}}'});
  else if(msg.id!==undefined) send({id:msg.id,result:{}});
}`);
  const options: AcpOptions = { cmd: [process.execPath, script], cwd: root, requireOwnedGroup: owned,
    nativePolicy: { modes: { ask: "safe" } }, permissionMode: "ask" };
  class MisleadingMetadataPeer extends AcpPeer {
    override recoveryMetadata() { return { launch: { cwd: "/wrong" }, sessionId: "virtual-session" }; }
    override get nativeSession() { return "virtual-session"; }
  }
  const peer = new MisleadingMetadataPeer("fixture-extra", options);
  cleanup.push(() => peer.stop());
  return { root, options, peer };
}

test("#754 managed ACP proof comes from its actual owned spawn, exact host options and native session", async () => {
  const f = fixture();
  expect(managedAcpLaunch(f.peer, f.options)).toBeUndefined();
  await f.peer.start();
  const receipt = managedAcpLaunch(f.peer, f.options);
  expect(receipt).toMatchObject({ cwd: f.root, sessionId: "actual-native-session" });
  expect(receipt?.generation).toMatch(/^[a-f0-9-]{36}$/);
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(await verifyManagedAcpLaunch(f.peer, f.options)).toBe(true);
  expect(managedAcpLaunch(f.peer, { ...f.options })).toBeUndefined();
  expect(managedAcpLaunch({ ...f.peer, receipt, nativeSession: "actual-native-session" }, f.options)).toBeUndefined();
  const stopping = f.peer.stop();
  expect(managedAcpLaunch(f.peer, f.options)).toBeUndefined();
  await stopping;
  await f.peer.start();
  expect(managedAcpLaunch(f.peer, f.options)?.generation).not.toBe(receipt?.generation);
}, 20_000);

test("#754 unmanaged, bypassed and failed ACP starts cannot mint a managed receipt", async () => {
  const unmanaged = fixture(false);
  await unmanaged.peer.start();
  expect(managedAcpLaunch(unmanaged.peer, unmanaged.options)).toBeUndefined();
  expect(await verifyManagedAcpLaunch(unmanaged.peer, unmanaged.options)).toBe(false);
  await unmanaged.peer.stop();

  const failed = fixture(true, true);
  await expect(failed.peer.start()).rejects.toThrow(/permission mode refused/);
  expect(managedAcpLaunch(failed.peer, failed.options)).toBeUndefined();
  expect(await verifyManagedAcpLaunch(failed.peer, failed.options)).toBe(false);
  class Bypass extends AcpPeer { override async start() {} }
  const bypass = new Bypass("fixture-bypass", failed.options);
  await bypass.start();
  expect(managedAcpLaunch(bypass, failed.options)).toBeUndefined();
  expect(managedAcpLaunch(undefined, failed.options)).toBeUndefined();
}, 20_000);

test("#754 a stopped launch cannot survive an awaited owned-group verification", async () => {
  const f = fixture();
  await f.peer.start();
  let release = () => {}, entered = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  const verifying = new Promise<void>(resolve => { entered = resolve; });
  const original = AcpOwnedGroup.prototype.verify;
  const verify = spyOn(AcpOwnedGroup.prototype, "verify").mockImplementationOnce(async function (this: AcpOwnedGroup) {
    await original.call(this);
    entered();
    await wait;
  });
  try {
    const pending = verifyManagedAcpLaunch(f.peer, f.options);
    await verifying;
    await f.peer.stop();
    release();
    expect(await pending).toBe(false);
    expect(managedAcpLaunch(f.peer, f.options)).toBeUndefined();
  } finally { release(); verify.mockRestore(); }
}, 20_000);

test("#754 unreadable owned-group proof revokes a receipt without claiming teardown", async () => {
  const f = fixture();
  await f.peer.start();
  const verify = spyOn(AcpOwnedGroup.prototype, "verify").mockRejectedValueOnce(new Error("fixture unreadable group"));
  try {
    expect(await verifyManagedAcpLaunch(f.peer, f.options)).toBe(false);
    expect(managedAcpLaunch(f.peer, f.options)).toBeUndefined();
    expect(f.peer.pendingOwnedProcess).toBe(true);
  } finally { verify.mockRestore(); }
  await f.peer.stop();
}, 20_000);
