import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { stopOwnedProcess, trackGroup } from "../src/hub/child-process.ts";

test("A4 an external package runs the exported kit using only the actual npm tarball and its declared runtime dependency", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-public-adapter-package-")), project = mkdtempSync(join(tmpdir(), "ahub-external-consumer-project-")), source = realPath(join(import.meta.dir, ".."));
  try {
    const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: source, encoding: "utf8", timeout: 10_000 });
    expect(packed.status, packed.stderr).toBe(0);
    const artifact = JSON.parse(packed.stdout)[0], names = artifact.files.map((file: { path: string }) => file.path);
    expect(names).toContain("src/adapters/public.ts"); expect(names).toContain("src/adapters/conformance/index.ts");
    expect(names.some((name: string) => name.startsWith("test/"))).toBe(false);
    const extracted = join(root, "unpacked"); mkdirSync(extracted);
    expect(spawnSync("tar", ["-xzf", join(root, artifact.filename), "-C", extracted], { encoding: "utf8", timeout: 5000 }).status).toBe(0);
    const scope = join(root, "node_modules", "@staix"); mkdirSync(scope, { recursive: true });
    renameSync(join(extracted, "package"), join(scope, "agent-hub"));
    // Install only the already exact-pinned published runtime dependency. Never copy an ancestor node_modules tree.
    symlinkSync(realPath(join(source, "node_modules", "@staix", "agent-mem")), join(scope, "agent-mem"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    const module = `import {ADAPTER_API,AcpPeer} from "@staix/agent-hub/adapter";
export const definition={api:ADAPTER_API,kind:"kit-fixture",family:"kit-fixture",displayName:"Kit fixture",transport:"acp",roles:["implementer"],optional:true,defaultOnRoster:false,
trust:{onPrem:false,hubSandboxed:false},identity:{mcp:"acp-session"},permission:{genericAcp:{modes:{ask:"default"}}},
start:{forms:["headless"],defaultForm:"headless",daemonPort:"acp",conductorStartable:true,hubSwitches:[],ownedFlags:[],
create:ctx=>new AcpPeer(ctx.instance,{...ctx.daemon.acp,kind:ctx.instance,expectedAgent:{name:"Kit fixture",version:"1"},nativePolicy:{modes:{ask:"default"}},requireOwnedGroup:true,requireLoadSessionEcho:true}),
launch:ctx=>({cmd:"fixture",args:[],metadata:{packageEntrypoint:ctx.entrypoint,argv:[],command:"fixture",env:{}}})},
session:{idField:"sessionId",currentId:peer=>peer.recoveryMetadata().sessionId},turnEnd:"adapter",cli:{command:"kit-fixture",startWords:()=>["kit-fixture"]},display:{palette:{fg:"white",bg:"black"}}};`;
    writeFileSync(join(root, "adapter.mjs"), module);
    writeFileSync(join(root, "consumer.test.ts"), `import {expect,test} from "bun:test";
import {readFileSync,mkdtempSync,rmSync,statSync} from "node:fs";
import {join,relative} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {mkdirSync,writeFileSync,existsSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {startDaemon} from "./node_modules/@staix/agent-hub/src/hub/daemon.ts";
import {ControlClient} from "./node_modules/@staix/agent-hub/src/hub/control-client.ts";
import {definition} from "./adapter.mjs";
import {createFromDefinition,registerConformance,registerAcpConformance,fakePaths} from "@staix/agent-hub/conformance";
test("consumer has no development tree",()=>{expect(relative(import.meta.dir,fakePaths.acpServer)).toStartWith("node_modules/");expect(statSync(fakePaths.acpServer).isFile()).toBe(true);});
registerConformance({kind:definition.kind,create:async()=>{
 const cwd=mkdtempSync(join(tmpdir(),"public-module-contract-")),messages=[];
 const peer=createFromDefinition(definition,{acp:{cwd,cmd:[process.execPath,fakePaths.acpServer,"--agent-name","Kit fixture","--agent-version","1"]}});
 peer.onMessage=text=>{messages.push(text);};
 try{await peer.start();}catch(error){await peer.stop();rmSync(cwd,{recursive:true,force:true});throw error;}
 return{peer,messages,busyOnDeliver:true,verifyTransport(){expect(peer.recoveryMetadata().sessionId).toBeString();},async close(){try{await peer.stop();}finally{rmSync(cwd,{recursive:true,force:true});}}};
}});
registerAcpConformance({definition,agentArgs:["--agent-name","Kit fixture","--agent-version","1"],unsupported:{
 "native-approval-rpc":"External modules never auto-approve native titles; person approval is exercised by the host integration fixture",
 "native-mode-ack":"This fixture declares only ask; it cannot request the never-ask timeout leg",
 "native-quota":"This fixture has no verified provider quota refusal contract"
}});
for(const decoy of [false,true]) test("installed daemon binds its own SDK outside the package, decoy="+decoy,async()=>{
 const cwd=process.cwd(),stateDir=join(cwd,".agenthub","state");
 expect(spawnSync("git",["init","-q",cwd]).status).toBe(0);
 mkdirSync(join(cwd,".agenthub"),{recursive:true});
 const marker=join(cwd,"decoy-ran"),fake=join(cwd,"node_modules","@staix","agent-hub");
 if(decoy){mkdirSync(fake,{recursive:true});writeFileSync(join(fake,"package.json"),JSON.stringify({type:"module",exports:{"./adapter":"./evil.js"}}));writeFileSync(join(fake,"evil.js"),'import {writeFileSync} from "node:fs";writeFileSync('+JSON.stringify(marker)+',"ran");throw new Error("untrusted decoy");');}
 const source=readFileSync(join(import.meta.dir,"adapter.mjs"),"utf8").replace('cmd:"fixture",args:[]','cmd:'+JSON.stringify(process.execPath)+',args:'+JSON.stringify([fakePaths.acpServer,"--agent-name","Kit fixture","--agent-version","1"]));
 writeFileSync(join(cwd,"adapter.mjs"),source);
 writeFileSync(join(cwd,".agenthub","config.local.json"),JSON.stringify({adapter_modules:[{path:"adapter.mjs",sha256:createHash("sha256").update(source).digest("hex")}],roster:{"kit-fixture":true}}));
 writeFileSync(join(cwd,".agenthub","config.json"),JSON.stringify({memory:{enabled:false,native:false},inference:{enabled:false},snapshots:{enabled:false},approvals:{notify:false},mlx:{enabled:false},pi:{enabled:false,auto_start:false}}));
 let daemon,client;try{
  daemon=await startDaemon({cwd,stateDir,controlPort:0,codexAppPort:0,codexProxyPort:0});
  client=await ControlClient.connect(stateDir,{role:"console",projectRoot:cwd});
  expect((await client.request({t:"start",peer:"kit-fixture"})).ok).toBe(true);
  expect(daemon.bus.peers.get("kit-fixture").state).toBe("idle");
  expect(existsSync(marker)).toBe(false);
 }finally{client?.close();await daemon?.stop();}
},20000);
`);
    const child = spawn(process.execPath, ["test", join(root, "consumer.test.ts"), "--timeout", "20000"], { cwd: project, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    trackGroup(child);
    const chunks: Buffer[] = []; let size = 0;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { if (size < 2 * 1024 * 1024) chunks.push(chunk); size += chunk.length; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", code => resolve(code)); child.once("error", reject); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("public conformance consumer timed out")), 20_000); });
    let code: number | null;
    try { code = await Promise.race([exited, deadline]); }
    finally { clearTimeout(timer); await stopOwnedProcess(child, { group: true }); }
    const output = Buffer.concat(chunks).toString("utf8");
    expect(code, output).toBe(0);
    expect(output).toContain("P4 kit-fixture: transport delivery, synchronous occupancy and owned teardown");
    expect(output).toContain("watchdog cancellation fences the consumed late native result");
    const manifest = JSON.parse(readFileSync(join(scope, "agent-hub", "package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies)).toEqual(["@staix/agent-mem"]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
}, 40_000);
