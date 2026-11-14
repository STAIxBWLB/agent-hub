import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
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
import { preparePiDependencies } from "../src/pi/task-dependencies.ts";
import { hubGitSync } from "../src/hub/git.ts";

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
    expect(pi).toContain('(allow network-inbound (remote ip "localhost:*"))');
    expect(pi).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(pi).not.toContain('(allow network*)');
    expect(pi).not.toContain('(allow network-outbound (local ip');
    expect(pi).not.toContain('(allow network-bind (local ip "*:*"))');
    const added = new Set(['(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (remote ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))']);
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
  const cwd = root(), script = join(cwd, "deny.py");
  // TEST-NET has no service to probe. Only an immediate kernel policy refusal is evidence.
  writeFileSync(script, `import errno, socket, sys
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
    connection.settimeout(0.5)
    try:
        connection.connect(("192.0.2.1", 9))
    except OSError as error:
        if error.errno not in (errno.EPERM, errno.EACCES):
            print("no kernel policy refusal", error.errno)
            sys.exit(1)
        print("kernel-denied")
    else:
        print("unexpected external connect")
        sys.exit(1)
`);
  const result = await sandboxedExec(["/usr/bin/python3", "-I", "-S", script], { cwd, profile: profile(cwd, false, [], [], [], loopback), env: { HOME: cwd }, timeoutMs: 5000 });
  expect(result.code, result.output).toBe(0); expect(result.output).toContain("kernel-denied");
}, 10_000);

function fixtureRequest(host: string, port: number, token: string, external: boolean): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port, ...(external ? { localAddress: host } : {}) }); let text = "", done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; socket.destroy(); resolve(ok); } };
    socket.setTimeout(700, () => finish(false)); socket.once("error", () => finish(false));
    socket.once("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer ${token}\r\nX-Fixture-Case: ${external ? "external" : "loopback"}\r\nConnection: close\r\n\r\n`));
    socket.on("data", data => { text += data.toString(); if (text.includes("fixture-reachable")) finish(true); });
    socket.once("end", () => finish(text.includes("fixture-reachable")));
  });
}

for (const network of [false, { proxyPort: 4321 }] satisfies SandboxNetwork[])
  test.skipIf(!sandboxAvailable())(`#1447 T5 native wildcard listener accepts only loopback peers, proxy=${typeof network === "object"}`, async () => {
    const address = Object.values(networkInterfaces()).flat().find(item => item && item.family === "IPv4" && !item.internal)?.address;
    if (!address) throw new Error("native proof requires a fixture-owned non-loopback IPv4 interface");
    const exercise = async (mode: SandboxNetwork, loopback: boolean, externalAllowed: boolean) => {
      const cwd = root(), script = join(cwd, "ingress.ts"), token = crypto.randomUUID();
      writeFileSync(script, `import {writeFileSync} from "node:fs";
const server=Bun.serve({hostname:"0.0.0.0",port:0,fetch(request){
 if(request.headers.has("origin")||request.headers.get("authorization")!==${JSON.stringify(`Bearer ${token}`)})return new Response("refused",{status:403});
 if(request.headers.get("x-fixture-case")==="external")writeFileSync("accepted-external","fixture-only");
 return new Response("fixture-reachable");
}});writeFileSync("port",String(server.port));setTimeout(()=>server.stop(true),2500);
`);
      const running = sandboxedExec([process.execPath, script], { cwd, profile: profile(cwd, mode, [], [], [], loopback), env: { HOME: cwd, ...proxyEnv(mode, loopback) }, timeoutMs: 5000 });
      const deadline = performance.now() + 2000;
      while (!existsSync(join(cwd, "port")) && performance.now() < deadline) await Bun.sleep(10);
      const port = existsSync(join(cwd, "port")) ? Number(readFileSync(join(cwd, "port"), "utf8")) : undefined;
      let local = false, external = false;
      try {
        if (port) { local = await fixtureRequest("127.0.0.1", port, token, false); external = await fixtureRequest(address, port, token, true); }
      } finally {
        const result = await running; expect(result.code, result.output).toBe(0);
      }
      expect(port).toBeDefined(); expect(local).toBe(true);
      expect(external).toBe(externalAllowed);
      expect(existsSync(join(cwd, "accepted-external"))).toBe(externalAllowed);
    };
    // Positive control proves this host/interface can reach the same fixture app.
    await exercise(true, false, true);
    await exercise(network, true, false);
  }, 15_000);

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

test("#1447 T5 a concurrent accept prepares under its own acceptance rather than adopting the superseded run", async () => {
  const f = await taskFixture(), started = barrier(), release = barrier(); let calls = 0;
  f.worktrees.registerDependencyPreparation("pi", async (_cwd, current) => {
    if (++calls === 1) { started.release(); await release.reached; expect(current()).toBe(false); }
    else expect(current()).toBe(true);
    return { ready: true };
  });
  const task = f.offer(), first = f.tasks.acceptReviewed("pi", task.id);
  await started.reached; const second = f.tasks.acceptReviewed("pi", task.id);
  release.release(); await expect(first).rejects.toThrow("changed owner, session or privacy");
  const accepted = await second;
  expect(calls).toBe(2); expect(accepted.state).toBe("in_progress");
  expect(f.tasks.worktreeNote(accepted, "pi")).toContain("dependencies prepared");
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

async function preparedTypecheckFixture() {
  const f = await taskFixture();
  // These two inputs match the mandatory frozen install that seeded this runner's
  // shared Bun cache. Copy manifests only, never an existing dependency tree.
  for (const file of ["package.json", "bun.lock"]) writeFileSync(join(f.cwd, file), readFileSync(join(import.meta.dir, "..", file)));
  writeFileSync(join(f.cwd, "index.ts"), "export const checked: number = 1;\n");
  writeFileSync(join(f.cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], lib: ["ES2020"] }, files: ["index.ts"] }));
  for (const args of [["add", "package.json", "bun.lock", "index.ts", "tsconfig.json"], ["commit", "-qm", "reviewed typecheck fixture"]]) {
    const run = hubGitSync(["-C", f.cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    expect(run.status, String(run.stderr)).toBe(0);
  }
  const task = f.tasks.accept("pi", f.offer().id), worktree = f.worktrees.describe("pi", task.id)!;
  const result = await preparePiDependencies(worktree.path, { base: worktree.base, repositoryRoot: f.cwd, stagingParent: f.state, current: () => true, publish: publishPiDependencies });
  expect(result).toEqual({ ready: true });
  expect(existsSync(join(worktree.path, "node_modules/.bin/tsc"))).toBe(true);
  return { ...f, worktree };
}

test("#1447 T5 a Git-prepared worktree installs from the shared cache and runs TypeScript with offline resolution", async () => {
  const f = await preparedTypecheckFixture(), home = join(f.state, "typecheck-home"); mkdirSync(home);
  const checked = Bun.spawnSync([process.execPath, "x", "--offline", "tsc", "--noEmit"], { cwd: f.worktree.path, env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 5000 });
  expect(checked.exitCode, checked.stderr.toString()).toBe(0);
}, 20_000);

test.skipIf(!sandboxAvailable())("#1447 T5 the prepared worktree runs bun x tsc with kernel network access denied", async () => {
  const f = await preparedTypecheckFixture();
  const checked = await sandboxedExec([process.execPath, "x", "tsc", "--noEmit"], { cwd: f.worktree.path, profile: profile(f.worktree.path, false), timeoutMs: 5000 });
  expect(checked.code, checked.output).toBe(0);
}, 20_000);
