import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { hubGitSync as gitSync } from "../src/hub/git.ts";
const hubGitSync = (args: string[]) => gitSync(args, { encoding: "utf8" });
import { realPath } from "../src/hub/project.ts";
import { readInstanceConfig } from "../src/hub/instance-config.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { isAcpPeer } from "../src/adapters/acp.ts";
import { fakePaths } from "../src/adapters/conformance/fake-paths.ts";

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 500 && !check(); attempt++) await Bun.sleep(10);
  expect(check()).toBe(true);
}
async function fixture(on = false, instances = false) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-external-daemon-"))), stateDir = join(root, ".agenthub", "state");
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const close = async () => { try { client?.close(); await daemon?.stop(); } finally { rmSync(root, { recursive: true, force: true }); } };
  try {
    expect(hubGitSync(["init", "-q", root]).status).toBe(0);
    mkdirSync(join(root, ".agenthub", "adapters"), { recursive: true });
    const marker = join(root, "imports"), protocol = join(root, "protocol");
    const argv = [fakePaths.acpServer, "--agent-name", "External fixture", "--agent-version", "1", "--record-protocol", protocol];
    const source = `import {appendFileSync} from "node:fs";
import {ADAPTER_API,AcpPeer} from "@staix/agent-hub/adapter";
appendFileSync(${JSON.stringify(marker)},"loaded\\n");
export const definition={api:ADAPTER_API,kind:"fixture",family:"fixture",displayName:"External fixture",transport:"acp",roles:["implementer","verifier"],optional:true,defaultOnRoster:false,
trust:{onPrem:false,hubSandboxed:false},identity:{mcp:"acp-session"},permission:{unmanaged:"external fixture unmanaged"},
start:{forms:["headless"],defaultForm:"headless",daemonPort:"acp",conductorStartable:true,hubSwitches:[],ownedFlags:[],
launch:ctx=>({cmd:${JSON.stringify(process.execPath)},args:${JSON.stringify(argv)},metadata:{packageEntrypoint:ctx.entrypoint,argv:[],command:"fixture",env:{}}}),
create:ctx=>new AcpPeer(ctx.instance,{...ctx.daemon.acp,kind:ctx.instance,nativePolicy:{},expectedAgent:{name:"External fixture",version:"1"},requireOwnedGroup:true,requireLoadSessionEcho:true})},
session:{idField:"sessionId",currentId:peer=>peer.sessionId},turnEnd:"adapter",cli:{command:"fixture",startWords:()=>["fixture"]},display:{palette:{fg:"white",bg:"black"}}};`;
    writeFileSync(join(root, ".agenthub", "adapters", "fixture.mjs"), source, { mode: 0o600 });
    const local = { adapter_modules: [{ path: ".agenthub/adapters/fixture.mjs", sha256: createHash("sha256").update(source).digest("hex") }], roster: { fixture: on },
      ...(instances ? { instances: { "fixture-worker": { kind: "fixture", start_mode: "headless" } } } : {}) };
    writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify(local), { mode: 0o600 });
    writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ batch_ms: 0, memory: { enabled: false, native: false }, inference: { enabled: false }, snapshots: { enabled: false }, approvals: { notify: false }, mlx: { enabled: false }, pi: { enabled: false, auto_start: false } }));
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    return { root, stateDir, daemon, client, marker, local, close };
  } catch (error) { await close(); throw error; }
}

test("A4 daemon imports an off-roster module and CLI sees inert bounded metadata only", async () => {
  const f = await fixture();
  try {
    const status = (await f.client.request({ t: "status" })).status;
    expect(status.externalAdapters).toEqual([{ kind: "fixture", displayName: "External fixture" }]);
    expect(JSON.stringify(status.externalAdapters)).not.toMatch(/path|sha256|create|launch/);
    expect((await f.client.request({ t: "start", peer: "fixture" })).ok).toBe(false);
    const scoped = readInstanceConfig(f.root);
    expect(scoped.catalog.definitionOf("fixture")?.start.create).toBeUndefined();
    expect(scoped.catalog.definitionOf("fixture")?.displayName).toBe("External fixture");
    expect(readFileSync(f.marker, "utf8")).toBe("loaded\n");
    expect(definitionOf("fixture")).toBeUndefined();
    const refused = await f.client.request({ t: "recovery", op: "inspect", expectedInstanceId: f.client.instanceId, targetFeatures: DAEMON_FEATURES.filter(feature => feature !== "external_adapter_modules") });
    expect(refused.ok).toBe(false); expect(refused.error).toContain("external_adapter_modules");
    expect(f.daemon.bus.isRecoveryHeld).toBe(false);
  } finally { await f.close(); }
}, 20_000);

test("A4 a module starts through its factory and never auto-approves hub-tool titles", async () => {
  const f = await fixture(true);
  try {
    const asks: any[] = []; f.client.onPush = message => { if (message.t === "permission") asks.push(message); }; f.client.send({ t: "tail" });
    expect((await f.client.request({ t: "start", peer: "fixture" })).ok).toBe(true);
    const owner = f.daemon.bus.peers.get("fixture");
    expect(isAcpPeer(owner)).toBe(true); if (!isAcpPeer(owner)) throw new Error("fixture owner missing");
    const answers: string[] = []; owner.onMessage = text => { answers.push(text); };
    const outcome = owner.deliver([newEnvelope("user", "PERMISSION HUBTOOL", { to: ["fixture"] })]).catch(error => error);
    await until(() => asks.length > 0 || answers.length > 0);
    expect(asks).toHaveLength(1); expect(answers).toHaveLength(0);
    const deny = asks[0].options.find((option: any) => option.kind === "reject_once");
    expect(deny).toBeDefined();
    expect((await f.client.request({ t: "permit", id: asks[0].id, option: deny.optionId, surface: "console" })).ok).toBe(true);
    await outcome; await until(() => owner.state === "idle");
    expect((await f.client.request({ t: "peer_stop", peer: "fixture" })).ok).toBe(true);
    expect(owner.state).toBe("offline");
  } finally { await f.close(); }
}, 20_000);

test("A4 module edits remain restart-bound and reload never evaluates changed code", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, ".agenthub", "adapters", "fixture.mjs"), 'throw new Error("RELOAD_MUST_NOT_IMPORT");');
    writeFileSync(join(f.root, ".agenthub", "config.local.json"), JSON.stringify({ ...f.local, adapter_modules: [{ ...f.local.adapter_modules[0], sha256: "0".repeat(64) }] }));
    let result = await f.client.request({ t: "settings_reload" });
    if (result.confirmation?.token) result = await f.client.request({ t: "settings_reload", confirm: result.confirmation.token });
    expect(result.ok).toBe(true);
    const status = (await f.client.request({ t: "status" })).status;
    expect(status.pendingRestart.some((row: any) => row.key === "adapter_modules")).toBe(true);
    expect(readFileSync(f.marker, "utf8")).toBe("loaded\n");
    expect(status.externalAdapters).toEqual([{ kind: "fixture", displayName: "External fixture" }]);
  } finally { await f.close(); }
}, 20_000);

test("A4 external-kind instance declarations are refused explicitly", async () => {
  await expect(fixture(false, true)).rejects.toThrow("external adapter instances are unsupported in A4");
}, 20_000);
