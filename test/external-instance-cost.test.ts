import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { fakePaths } from "../src/adapters/conformance/fake-paths.ts";

// Match the portable platform helper's lazily required module object, not an ESM namespace copy.
const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");

const IDS = ["fixture-writer", "fixture-verifier", "fixture-reviewer"] as const;
interface Sample { git: number; statusGit: number; writes: number; writeStatusGit: number[] }

async function fixture() {
  const root = realPath(fs.mkdtempSync(join(tmpdir(), "ahub-external-cost-"))), stateDir = join(root, ".agenthub", "state");
  const previousHome = process.env.HOME;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const close = async () => {
    try { client?.close(); await daemon?.stop(); }
    finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; fs.rmSync(root, { recursive: true, force: true }); }
  };
  try {
    const home = join(root, "home"); fs.mkdirSync(home); process.env.HOME = home;
    const git = (...args: string[]) => {
      const result = hubGitSync(["-C", root, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`cost fixture Git failed: ${result.stderr}`);
      return result.stdout;
    };
    git("init", "-q"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    fs.mkdirSync(join(root, ".agenthub", "adapters"), { recursive: true });
    for (const id of IDS) git("worktree", "add", "-b", id, join(root, ".worktrees", id), "HEAD");
    const source = `import {ADAPTER_API,AcpPeer} from "@staix/agent-hub/adapter";
export const definition={api:ADAPTER_API,kind:"fixture",family:"fixture",displayName:"External cost fixture",transport:"acp",roles:["implementer","verifier","reviewer"],optional:true,defaultOnRoster:false,
headlessInstances:{form:"headless",roles:["implementer","verifier","reviewer"]},trust:{onPrem:false,hubSandboxed:false},identity:{mcp:"acp-session"},permission:{genericAcp:{modes:{ask:"default"},readOnly:"plan"}},
start:{forms:["headless"],defaultForm:"headless",daemonPort:"acp",conductorStartable:true,hubSwitches:[],ownedFlags:[],
launch:ctx=>({cmd:${JSON.stringify(process.execPath)},args:[${JSON.stringify(fakePaths.acpServer)},"--modes","default,plan"],metadata:{packageEntrypoint:ctx.entrypoint,argv:[],command:"fixture",env:{}}}),
create:ctx=>new AcpPeer(ctx.instance,ctx.daemon.acp)},session:{idField:"sessionId",currentId:peer=>peer.sessionId},turnEnd:"adapter",cli:{command:"fixture",startWords:()=>["fixture"]},display:{palette:{fg:"white",bg:"black"}}};`;
    fs.writeFileSync(join(root, ".agenthub", "adapters", "fixture.mjs"), source, { mode: 0o600 });
    fs.writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({
      adapter_modules: [{ path: ".agenthub/adapters/fixture.mjs", sha256: createHash("sha256").update(source).digest("hex") }],
      instances: Object.fromEntries(IDS.map((id, index) => [id, { kind: "fixture", roles: [["implementer"], ["verifier"], ["reviewer"]][index], worktree: `.worktrees/${id}`, ...(id === "fixture-reviewer" ? { readOnly: true } : {}) }])),
      roster: Object.fromEntries(IDS.map(id => [id, true])),
    }), { mode: 0o600 });
    fs.writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ batch_ms: 0, memory: { enabled: false, native: false }, inference: { enabled: false }, snapshots: { enabled: false }, approvals: { notify: false }, mlx: { enabled: false }, pi: { enabled: false, auto_start: false } }));
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    for (const id of IDS) expect(await client.request({ t: "start", peer: id })).toMatchObject({ ok: true });
    for (let attempt = 0; attempt < 500 && !IDS.every(id => daemon!.bus.stateOf(id) === "idle"); attempt++) await Bun.sleep(10);
    expect(IDS.every(id => daemon!.bus.stateOf(id) === "idle")).toBe(true);
    return { root, stateDir, daemon, client, close };
  } catch (error) { await close(); throw error; }
}

test("#754 three-instance status and writeStatus use bounded synchronous Git evidence", async () => {
  const f = await fixture(), priorStackLimit = Error.stackTraceLimit;
  const originalSpawn = childProcess.spawnSync, originalWrite = fs.writeFileSync;
  let active: Sample | undefined, writeGit = 0;
  Error.stackTraceLimit = 64;
  const spawn = spyOn(childProcess, "spawnSync").mockImplementation(((...args: Parameters<typeof childProcess.spawnSync>) => {
    if (active && typeof args[0] === "string" && basename(args[0]) === "git") {
      active.git++;
      const stack = new Error().stack ?? "";
      if (/\bat status\b/.test(stack)) active.statusGit++;
      if (/\bat writeStatus\b/.test(stack)) writeGit++;
    }
    return (originalSpawn as (...input: any[]) => any)(...args);
  }) as typeof childProcess.spawnSync);
  const write = spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
    if (active && String(args[0]).startsWith(join(f.stateDir, "status.json.")) && String(args[0]).endsWith(".tmp")) {
      active.writes++; active.writeStatusGit.push(writeGit); writeGit = 0;
    }
    return (originalWrite as (...input: any[]) => any)(...args);
  }) as typeof fs.writeFileSync);
  const sample = async (action: () => Promise<unknown>): Promise<Sample> => {
    const row: Sample = { git: 0, statusGit: 0, writes: 0, writeStatusGit: [] };
    active = row; writeGit = 0;
    try { await action(); return row; } finally { active = undefined; }
  };
  try {
    const probe = await sample(async () => {
      expect(hubGitSync(["-C", f.root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).status).toBe(0);
      const file = join(f.stateDir, "status.json.measure.tmp"); fs.writeFileSync(file, "probe"); fs.rmSync(file);
    });
    expect(probe.git).toBe(1); expect(probe.writes).toBe(1); // Both counters wrap actual effects rather than replacing policy.
    await f.client.request({ t: "status" });
    const status: Sample[] = [], board: Sample[] = [];
    for (let index = 0; index < 3; index++) status.push(await sample(() => f.client.request({ t: "status" })));
    for (let index = 0; index < 3; index++) board.push(await sample(async () => {
      const result = await f.client.request({ t: "task", op: "hub_task_propose", args: { title: `cost fixture ${index}`, class: "implement", backlog: true } });
      expect(result.ok).toBe(true);
    }));
    console.log(`external-instance Git cost: ${JSON.stringify({ instances: IDS.length, status, board })}`);
    expect(status.every(row => row.git > 0 && row.statusGit > 0)).toBe(true);
    expect(board.every(row => row.writes > 0 && row.writeStatusGit.length === row.writes && row.writeStatusGit.every(count => Number.isSafeInteger(count) && count >= 0))).toBe(true);
    // Three cold instance bindings cost 32 real Git processes today. Leave room for a
    // further bounded read while rejecting the old repeated per-field captures (203).
    expect(status.every(row => row.git <= 48)).toBe(true);
    // A board effect may warm the turn before its status write. Permit one full cold
    // three-instance status pass, not the former 149-process writeStatus expansion.
    expect(board.every(row => row.git <= 64 && row.writeStatusGit.every(count => count <= 40))).toBe(true);
  } finally { active = undefined; spawn.mockRestore(); write.mockRestore(); Error.stackTraceLimit = priorStackLimit; await f.close(); }
}, 20_000);
