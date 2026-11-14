import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profile, proxyEnv, sandboxAvailable, sandboxedExec, type SandboxNetwork } from "../src/local/sandbox.ts";
import { realPath } from "../src/hub/project.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { TaskWorktrees } from "../src/hub/task-worktree.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { gitProject } from "./fakes/git-project.ts";
import { publishPiDependencies } from "../src/pi/dependency-publish.ts";

const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const cwd = realPath(mkdtempSync(join(tmpdir(), "pi-loopback-"))); roots.push(cwd); return cwd; };

for (const network of [false, { proxyPort: 4321 }] satisfies SandboxNetwork[]) {
  test(`#1447 T5 Pi-only loopback bind/connect keeps external policy unchanged: ${JSON.stringify(network)}`, () => {
    const cwd = root(), ordinary = profile(cwd, network), pi = profile(cwd, network, [], [], [], true);
    expect(ordinary).not.toContain('(allow network-bind (local ip "localhost:*"))');
    expect(ordinary).not.toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(pi).toContain('(allow network-bind (local ip "localhost:*"))');
    expect(pi).toContain('(allow network-inbound (local ip "localhost:*"))');
    expect(pi).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(pi).not.toContain('(allow network*)');
    expect(pi).not.toContain('(allow network-outbound (local ip');
    expect(pi).not.toContain('(allow network-bind (local ip "*:*"))');
    const added = new Set(['(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))']);
    expect(pi.split("\n").filter(line => !added.has(line)).join("\n")).toBe(ordinary);
    if (typeof network === "object") expect(pi).toContain('(allow network-outbound (remote ip "localhost:4321"))');
    expect(pi).toContain('(deny file-write*');
  });
}

test("#1447 T5 only Pi's proxied shell bypasses the proxy for local fixtures", () => {
  const network = { proxyPort: 4321 };
  expect(proxyEnv(network).NO_PROXY).toBe("");
  expect(proxyEnv(false, true)).toEqual({});
  const pi = proxyEnv(network, true);
  expect(pi.HTTP_PROXY).toBe("http://127.0.0.1:4321");
  expect(pi.NO_PROXY).toContain("localhost");
  expect(pi.NO_PROXY).toContain("127.0.0.1");
  expect(pi.NO_PROXY).toContain("::1");
  expect(pi.NO_PROXY).toBe(pi.no_proxy);
  expect(pi.NO_PROXY).not.toContain("*");
});

// These legs need the real macOS kernel. Linux's source-policy tests above are not native proof.
for (const host of ["127.0.0.1", "::1"]) for (const network of [false, { proxyPort: 4321 }] satisfies SandboxNetwork[])
  test.skipIf(!sandboxAvailable())(`#1447 T5 native Seatbelt loopback bind/connect ${host}, proxy=${typeof network === "object"}`, async () => {
    const cwd = root(), script = join(cwd, "listen.ts");
    writeFileSync(script, `const host = ${JSON.stringify(host)};
const server = Bun.serve({hostname:host,port:0,fetch(request){
  return request.headers.has("origin") || request.headers.get("authorization") !== "Bearer fixture-only"
    ? new Response("refused",{status:403}) : new Response("loopback-ok");
}});
try { const response=await fetch("http://"+(host.includes(":")?"["+host+"]":host)+":"+server.port,{headers:{authorization:"Bearer fixture-only"}});
  if(await response.text()!=="loopback-ok")throw new Error("loopback readback failed"); console.log("loopback-ok");
} finally { server.stop(true); }
`);
    const result = await sandboxedExec([process.execPath, script], { cwd, profile: profile(cwd, network, [], [], [], true), env: { HOME: cwd, ...proxyEnv(network, true) }, timeoutMs: 5000 });
    expect(result.code, result.output).toBe(0); expect(result.output).toContain("loopback-ok");
  }, 10_000);

for (const loopback of [false, true]) test.skipIf(!sandboxAvailable())(`#1447 T5 native Seatbelt keeps non-loopback egress closed, Pi=${loopback}`, async () => {
  const cwd = root(), script = join(cwd, "deny.ts");
  // TEST-NET has no service to probe. Only an immediate kernel policy refusal is evidence.
  writeFileSync(script, `import {createConnection} from "node:net";
const socket=createConnection({host:"192.0.2.1",port:9});
const timer=setTimeout(()=>{socket.destroy();console.error("no kernel refusal");process.exitCode=1},500);
socket.once("error",error=>{clearTimeout(timer);if(!["EPERM","EACCES"].includes(error.code)){console.error(error.code);process.exitCode=1}else console.log("kernel-denied")});
socket.once("connect",()=>{clearTimeout(timer);socket.destroy();console.error("unexpected external connect");process.exitCode=1});
`);
  const result = await sandboxedExec([process.execPath, script], { cwd, profile: profile(cwd, false, [], [], [], loopback), env: { HOME: cwd }, timeoutMs: 5000 });
  expect(result.code, result.output).toBe(0); expect(result.output).toContain("kernel-denied");
}, 10_000);

test.skipIf(!sandboxAvailable())("#1447 T5 native Pi localhost permission does not allow a wildcard listener", async () => {
  const cwd = root(), script = join(cwd, "bind-deny.ts");
  writeFileSync(script, `import {createServer} from "node:net";
const server=createServer(socket=>socket.destroy());
server.once("error",error=>{if(!["EPERM","EACCES"].includes(error.code)){console.error(error.code);process.exitCode=1}else console.log("kernel-denied")});
server.once("listening",()=>{server.close();console.error("unexpected wildcard bind");process.exitCode=1});
server.listen({host:"0.0.0.0",port:0});
`);
  const result = await sandboxedExec([process.execPath, script], { cwd, profile: profile(cwd, false, [], [], [], true), env: { HOME: cwd }, timeoutMs: 5000 });
  expect(result.code, result.output).toBe(0); expect(result.output).toContain("kernel-denied");
}, 10_000);

class FixturePeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}
function barrier() {
  let release!: () => void;
  return { reached: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function taskFixture() {
  const dir = root(), cwd = join(dir, "project"), state = join(dir, "state");
  mkdirSync(cwd); mkdirSync(state); mkdirSync(join(cwd, ".agenthub")); gitProject(cwd);
  writeFileSync(join(cwd, ".agenthub/routing.toml"), '[local]\nfixed_model="fixture"\n[signals]\npii_screen="off"\n[classes.implement]\npeers=["pi"]\n');
  const board = new Board(join(state, "hub.db")), bus = new Bus({ batchMs: 0 });
  closers.push(() => { bus.closeJournal(); board.close(); });
  for (const id of ["pi", "codex", "local"]) { const peer = new FixturePeer(id); bus.add(peer); await peer.start(); }
  const worktrees = new TaskWorktrees({ root: cwd, stateFile: join(state, "worktrees.json"), applies: peer => peer === "pi" || peer === "local", deny: () => [], protectInstructions: () => false });
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles: { claude: ["planner"], pi: ["implementer"] }, routing: () => loadRouting(cwd), notify: () => {}, wipLimit: () => 5,
    sdlc: { config: () => sdlcConfig({ mode: "off" }) }, taskWorktree: worktrees,
    capabilities: () => ({ pi: { tests: true, spec: true, network: true, worktree: true }, local: { tests: true, spec: true, network: true, worktree: true } }) });
  const offer = (owner = "pi") => { const task = board.propose("user", { title: "focused check fixture", class: "implement" }); return board.update(task.id, "user", "assigned", { owner }); };
  return { cwd, state, board, bus, tasks, worktrees, offer };
}

test("#1447 T5 acceptance awaits preparation, preserves its synchronous admission API and reports readiness", async () => {
  const f = await taskFixture(), started = barrier(), release = barrier();
  f.worktrees.registerDependencyPreparation("pi", async (cwd, current) => {
    expect(existsSync(join(cwd, ".git"))).toBe(true); expect(current()).toBe(true);
    started.release(); await release.reached; return { ready: true };
  });
  const offered = f.offer(); let replied = false;
  const pending = f.tasks.acceptReviewed("pi", offered.id).then(task => { replied = true; return task; });
  await started.reached;
  expect(replied).toBe(false); expect(f.board.get(offered.id)?.state).toBe("in_progress");
  release.release(); const accepted = await pending;
  expect(accepted.owner).toBe("pi"); expect(f.tasks.worktreeNote(accepted, "pi")).toContain("dependencies prepared");
  const local = f.offer("local");
  expect(f.tasks.accept("local", local.id).state).toBe("in_progress");
  expect(f.tasks.dependencyNotes("local")).toBeUndefined();
});

test("#1447 T5 refused or failed preparation keeps acceptance and puts a fixed cause in prompt guidance", async () => {
  const f = await taskFixture();
  f.worktrees.registerDependencyPreparation("pi", async () => ({ ready: false, reason: "lifecycle script" }));
  const task = await f.tasks.acceptReviewed("pi", f.offer().id);
  expect(task.state).toBe("in_progress");
  expect(f.tasks.worktreeNote(task, "pi")).toContain("dependencies not prepared: lifecycle script");
  expect(f.tasks.dependencyNotes("pi")).toContain("dependencies not prepared: lifecycle script");
  f.worktrees.registerDependencyPreparation("pi", async () => { throw new Error("INSTALLER_STDERR_SECRET_CANARY"); });
  const again = await f.tasks.acceptReviewed("pi", task.id);
  expect(again.state).toBe("in_progress"); expect(f.tasks.dependencyNotes("pi")).toContain("install failed");
  expect(f.tasks.dependencyNotes("pi")).not.toContain("CANARY");
});

test("#1447 T5 moved ownership while preparing cannot return a stale accepted task or publish readiness", async () => {
  const f = await taskFixture(), started = barrier(), release = barrier();
  f.worktrees.registerDependencyPreparation("pi", async (_cwd, current) => { started.release(); await release.reached; expect(current()).toBe(false); return { ready: true }; });
  const task = f.offer(), pending = f.tasks.acceptReviewed("pi", task.id);
  await started.reached; f.board.update(task.id, "user", "reassigned", { owner: "codex", state: "proposed" });
  release.release(); await expect(pending).rejects.toThrow("changed owner, session or privacy");
  expect(f.board.get(task.id)?.owner).toBe("codex"); expect(f.worktrees.dependencyState("pi", task.id)).toBeUndefined();
  expect(f.tasks.dependencyNotes("pi")).toBeUndefined();
});

test("#1447 T5 self-claim awaits the same preparation and reports failure without undoing the claim", async () => {
  const f = await taskFixture(), started = barrier(), release = barrier();
  f.worktrees.registerDependencyPreparation("pi", async () => { started.release(); await release.reached; return { ready: false, reason: "missing bun.lock" }; });
  let replied = false;
  const pending = f.tasks.propose("pi", { title: "claim focused check work", class: "implement", owner: "pi" }).then(task => { replied = true; return task; });
  await started.reached; expect(replied).toBe(false); release.release();
  const task = await pending;
  expect(task.state).toBe("in_progress"); expect(task.owner).toBe("pi");
  expect(f.tasks.claimRoleGuidance(task, "pi")).toContain("dependencies not prepared: missing bun.lock");
});

function publicationFixture() {
  const dir = root(), cwd = join(dir, "worktree"), staging = join(dir, "private"), source = join(staging, "node_modules");
  mkdirSync(cwd); mkdirSync(staging); mkdirSync(source);
  writeFileSync(join(source, "fixture.txt"), "installed from reviewed snapshot");
  const identity = lstatSync(cwd);
  return { dir, cwd, staging, source, target: { cwd, dev: identity.dev, ino: identity.ino, timeoutMs: 5000 } };
}

test("#1447 T5 publisher uses rename, a verified CWD and private Bun configuration, not project preload", async () => {
  const f = publicationFixture(), inode = lstatSync(f.source).ino;
  writeFileSync(join(f.cwd, "bunfig.toml"), 'preload=["./evil.ts"]\n');
  writeFileSync(join(f.cwd, ".env"), 'BUN_OPTIONS="--preload ./evil.ts"\n');
  writeFileSync(join(f.cwd, "evil.ts"), 'require("node:fs").writeFileSync("PRELOAD_CANARY","should not execute")');
  expect(await publishPiDependencies(f.source, f.target, () => true)).toBe(true);
  expect(existsSync(f.source)).toBe(false);
  expect(lstatSync(join(f.cwd, "node_modules")).ino).toBe(inode);
  expect(readFileSync(join(f.cwd, "node_modules/fixture.txt"), "utf8")).toContain("reviewed snapshot");
  expect(existsSync(join(f.cwd, "PRELOAD_CANARY"))).toBe(false);
}, 10_000);

for (const kind of ["directory", "symlink"] as const) test(`#1447 T5 publisher refuses an existing ${kind} without overwriting it`, async () => {
  const f = publicationFixture(), target = join(f.cwd, "node_modules"), elsewhere = join(f.dir, "elsewhere");
  mkdirSync(elsewhere); writeFileSync(join(elsewhere, "canary"), "unchanged");
  if (kind === "directory") mkdirSync(target); else symlinkSync(elsewhere, target, "dir");
  const original = lstatSync(target);
  expect(await publishPiDependencies(f.source, f.target, () => true)).toBe(false);
  expect(lstatSync(target).ino).toBe(original.ino); expect(existsSync(f.source)).toBe(true);
  expect(readFileSync(join(elsewhere, "canary"), "utf8")).toBe("unchanged");
}, 10_000);

test("#1447 T5 publisher refuses a replaced worktree ancestor and stale authority", async () => {
  const f = publicationFixture();
  renameSync(f.cwd, join(f.dir, "old-worktree")); mkdirSync(f.cwd);
  expect(await publishPiDependencies(f.source, f.target, () => true)).toBe(false);
  expect(existsSync(join(f.cwd, "node_modules"))).toBe(false); expect(existsSync(f.source)).toBe(true);
  const fresh = publicationFixture();
  expect(await publishPiDependencies(fresh.source, fresh.target, () => false)).toBe(false);
  expect(existsSync(fresh.source)).toBe(true);
}, 10_000);
