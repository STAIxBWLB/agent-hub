import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/cli/init.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";
import { Board } from "../src/hub/board.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import type { DocEvidence } from "../src/hub/sdlc-release.ts";

// The real hook, CLI, control identity and daemon ledger run here. Only the host's
// committed-doc readback is substituted; no native release command is executed.
test("S6 actual pre-push hook requires person consent for its captured commit and version and loses it on restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-release-flow-")), root = join(dir, "repo"), stateDir = join(dir, "state");
  mkdirSync(root); mkdirSync(stateDir);
  const git = (...args: string[]) => { const r = hubGitSync(args, { cwd: root, encoding: "utf8", timeout: 2000 }); expect(r.status).toBe(0); return r.stdout.trim(); };
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, agent: ControlClient | undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(dir, "home"), AGENTHUB_HOME: join(dir, "home/hub"), AGENTHUB_PROJECT_DIR: root, AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "fixture" };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_SESSION_ID;
  const cli = join(import.meta.dir, "../src/cli/main.ts"), saved = join(dir, "saved-input");
  async function run(argv: string[], input?: string, asPerson = false) {
    const childEnv = { ...env }; if (asPerson) { delete childEnv.AGENTHUB_PEER_ID; delete childEnv.CODEX_THREAD_ID; }
    const child = Bun.spawn(argv, { cwd: root, env: childEnv, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  }
  const start = async () => {
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      releaseDocEvidence: async () => ({ schemaVersion: 1, head: git("rev-parse", "HEAD"), version: "1.2.3", fresh: true, errors: 0,
        documents: [{ path: "README.md", state: "fresh", verifiedAgainst: git("rev-parse", "HEAD"), commits: 0, dirty: false }] }),
      config: { ...DEFAULT_CONFIG, roster: { claude: false, codex: true, kimi: false, qwen: false, jcode: false, pi: false, local: false },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { enabled: false, keep: 1 } } });
    person = await ControlClient.connect(stateDir, { role: "console" });
    agent = await ControlClient.connect(stateDir, { role: "tools", peer: "codex" });
  };
  try {
    git("init", "-q"); git("remote", "add", "origin", "https://example.test/project.git");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3" }));
    git("add", "package.json"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "candidate");
    const first = git("rev-parse", "HEAD"); git("tag", "v1.2.3"); git("tag", "v1.2.4");
    const hook = join(root, ".git/hooks/pre-push");
    writeFileSync(hook, `#!/bin/sh\ncat > '${saved}'\n`, { mode: 0o755 });
    init(root, undefined, false, true);
    // This account-free fixture disables MLX; remove init's explicit MLX pins.
    const routing = join(root, ".agenthub/routing.toml");
    writeFileSync(routing, readFileSync(routing, "utf8").replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"'));
    const input = `refs/tags/v1.2.3 ${first} refs/tags/v1.2.3 ${"0".repeat(40)}\n`;
    const hookRun = (data = input) => run([hook, "origin", "https://example.test/project.git"], data);
    await start();
    expect((await agent!.request({ t: "sdlc", op: "authorize-release", version: "1.2.3", commit: first })).ok).toBe(false);
    expect((await run([process.execPath, cli, "sdlc", "authorize-release", "1.2.3"])).code).toBe(1);
    expect((await run([process.execPath, cli, "--live-test", "sdlc", "authorize-release", "1.2.3"])).code).toBe(1);
    expect((await hookRun()).code).toBe(1); expect(existsSync(saved)).toBe(false);
    const approval = await run([process.execPath, cli, "sdlc", "authorize-release", "1.2.3", "--json"], undefined, true);
    expect(approval.code, approval.stderr).toBe(0); expect(JSON.parse(approval.stdout)).toMatchObject({ by: "user", version: "1.2.3", commit: first, docs: { fresh: true } });
    expect((await hookRun()).code).toBe(0); expect(readFileSync(saved, "utf8")).toBe(input);
    rmSync(saved);
    expect((await hookRun(input.replaceAll("v1.2.3", "v1.2.4"))).code).toBe(1); expect(existsSync(saved)).toBe(false);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "changed candidate");
    git("tag", "-f", "v1.2.3"); const next = git("rev-parse", "HEAD");
    expect((await hookRun(input.replace(first, next))).code).toBe(1);
    person!.close(); agent!.close(); await daemon!.stop(); daemon = undefined;
    // Hub down refuses tags, but branch-only stdin still reaches the preserved user hook.
    expect((await hookRun()).code).toBe(1);
    const branchInput = `refs/heads/main ${next} refs/heads/main ${"0".repeat(40)}\n`;
    expect((await hookRun(branchInput)).code).toBe(0); expect(readFileSync(saved, "utf8")).toBe(branchInput);
    git("tag", "-f", "v1.2.3", first); await start();
    expect((await hookRun()).code).toBe(1);
    expect(readFileSync(join(stateDir, "events.jsonl"), "utf8")).toContain('"type":"release_authorization"');
  } finally { person?.close(); agent?.close(); await daemon?.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

class ConsentPeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envelopes: Envelope[]) { /* Host turn fixture, no native account or executable. */ }
  begin() { this.setState("busy"); }
  end() { this.setState("idle"); }
}

/** Every consent belongs to a disposable repo/local remote. Only committed-doc readback is substituted, as in S6 above. */
async function conductorReleaseRig(actor: "codex" | "local" = "codex") {
  const temp = realPath(mkdtempSync(join(tmpdir(), "ahub-conductor-release-"))), root = join(temp, "repo"), stateDir = join(temp, "state"), remote = join(temp, "remote.git");
  mkdirSync(root); mkdirSync(stateDir);
  const keys = ["HOME", "AGENTHUB_HOME", "AMEM_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "KIMI_CODE_HOME"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { const dir = join(temp, key.toLowerCase()); mkdirSync(dir); process.env[key] = dir; }
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient, conductor: ControlClient, other: ControlClient;
  const clients: ControlClient[] = [], peers = new Map<string, ConsentPeer>();
  const roles: Record<string, string[]> = { claude: ["planner", "reviewer"], codex: ["implementer", ...(actor === "codex" ? ["conductor"] : [])], local: ["implementer", ...(actor === "local" ? ["conductor"] : [])] };
  const git = (...args: string[]) => {
    const result = hubGitSync(args, { cwd: root, encoding: "utf8", timeout: 2000, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
  };
  const audit = () => readFileSync(join(stateDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.type === "release_authorization");
  const evidence = (): DocEvidence => {
    const head = git("rev-parse", "HEAD"), version = JSON.parse(git("show", `${head}:package.json`)).version;
    return { schemaVersion: 1, head, version, fresh: true, errors: 0, documents: [{ path: "README.md", state: "fresh", verifiedAgainst: head, commits: 0, dirty: false }] };
  };
  let docs = async (): Promise<DocEvidence | undefined> => evidence(), docsCalls = 0;
  const close = async () => {
    try { for (const client of clients.splice(0)) client.close(); await daemon?.stop(); }
    finally {
      for (const key of keys) { const value = saved[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(temp, { recursive: true, force: true });
    }
  };
  const connect = async (peer?: string) => {
    const client = await ControlClient.connect(stateDir, peer ? { role: "tools", peer, projectRoot: root } : { role: "console", projectRoot: root }); clients.push(client); return client;
  };
  const start = async () => {
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, notifier: () => {},
      releaseDocEvidence: async () => { docsCalls++; return docs(); },
      config: { ...DEFAULT_CONFIG, roles, roster: { ...DEFAULT_CONFIG.roster, codex: true, local: true, kimi: false, qwen: false, jcode: false, pi: false },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
        omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
        pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
        research: { ...DEFAULT_CONFIG.research, enabled: false }, recovery: { ...DEFAULT_CONFIG.recovery, auto_resume_after_crash: false },
        task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
    peers.clear();
    for (const id of Object.keys(roles)) { const peer = new ConsentPeer(id); peers.set(id, peer); daemon.bus.add(peer); await peer.start(); }
    person = await connect(); conductor = await connect(actor); other = await connect(actor === "codex" ? "local" : "codex");
  };
  try {
    git("init", "-q"); git("init", "--bare", "-q", remote); git("remote", "add", "origin", remote);
    writeFileSync(join(root, "package.json"), '{"name":"release-fixture","version":"1.2.3"}\n'); writeFileSync(join(root, "README.md"), "Committed fixture release documentation\n");
    git("add", "package.json", "README.md"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture release candidate");
    git("tag", "v1.2.3");
    const commit = git("rev-parse", "HEAD");
    await start();
    const authorize = (client = conductor) => client.request({ t: "sdlc", op: "authorize-release", version: "1.2.3", commit });
    const guard = () => person.request({ t: "sdlc", op: "release-guard-hook", remoteName: "origin", remoteUrl: remote,
      stdin: `refs/tags/v1.2.3 ${commit} refs/tags/v1.2.3 ${"0".repeat(40)}\n` });
    const cli = async (args: string[]) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith("ORCA_") || key.startsWith("AGENTHUB_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "QWEN_CODE", "QWEN_CODE_SESSION_ID", "KIMI_CODE"].includes(key)) delete env[key];
      Object.assign(env, { AGENTHUB_HOME: process.env.AGENTHUB_HOME, AGENTHUB_PROJECT_DIR: root, AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PEER_ID: actor });
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr };
    };
    const privateTask = async () => {
      const reply = await person.request({ t: "task", op: "hub_task_propose", args: { title: "Patient 900101-1234567 private follow-up", class: "implement", owner: "local" } });
      expect(reply.ok === true, reply.error).toBe(true);
      const id = Number(String(reply.text).match(/task #(\d+)/)?.[1]); expect(id).toBeGreaterThan(0);
      const board = new Board(join(stateDir, "hub.db"));
      try { expect(board.get(id)?.owner).toBe("local"); expect(board.get(id)?.signals).toContain("pii"); } finally { board.close(); }
      return id;
    };
    const liveRoles = async (peer: string): Promise<string[]> => {
      const reply = await person.request({ t: "status" }); expect(reply.t === "status", reply.error).toBe(true);
      const value: unknown = reply.status?.roleInfo?.[peer]?.flowRoles;
      if (!Array.isArray(value) || value.some(role => typeof role !== "string")) throw new Error("fixture cannot read the daemon's accepted flow roles");
      return value as string[];
    };
    const reloadRoles = async (next: Record<string, string[]>) => {
      mkdirSync(join(root, ".agenthub"), { recursive: true });
      writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ roles: next }), { mode: 0o600 });
      let reply = await person.request({ t: "settings_reload" });
      if (reply.confirmation?.token) reply = await person.request({ t: "settings_reload", confirm: reply.confirmation.token });
      return reply;
    };
    return { temp, root, stateDir, remote, commit, actor, roles, peers, git, audit, evidence, authorize, guard, cli, privateTask, close, liveRoles, reloadRoles,
      get person() { return person; }, get conductor() { return conductor; }, get other() { return other; }, get docsCalls() { return docsCalls; },
      setDocs(value: typeof docs) { docs = value; },
      async restart() { for (const client of clients.splice(0)) client.close(); await daemon!.stop(); daemon = undefined; await start(); } };
  } catch (error) { await close(); throw error; }
}

test("#1063 console and the unique conductor record distinguishable consent and only the conductor CLI gains the new path", async () => {
  const f = await conductorReleaseRig();
  try {
    const refused = await f.authorize(f.other); expect(refused.ok).toBe(false); expect(f.docsCalls).toBe(0); expect(f.audit()).toEqual([]);
    const live = await f.cli(["--live-test", "sdlc", "authorize-release", "1.2.3", "--json"]);
    expect(live.code).toBe(1); expect(live.stderr).toContain("live-test"); expect(f.docsCalls).toBe(0); expect(f.audit()).toEqual([]);
    const person = await f.authorize(f.person); expect(person.ok === true, person.error).toBe(true); expect(person.authorization).toMatchObject({ by: "user", version: "1.2.3", commit: f.commit });
    const delegated = await f.authorize(); expect(delegated.ok === true, delegated.error).toBe(true);
    expect(delegated.authorization).toMatchObject({ by: "codex", version: "1.2.3", commit: f.commit, docs: { fresh: true } });
    const cli = await f.cli(["sdlc", "authorize-release", "1.2.3", "--json"]); expect(cli.code, cli.stderr).toBe(0);
    const receipt = JSON.parse(cli.stdout); expect(receipt).toMatchObject({ by: "codex", version: "1.2.3", commit: f.commit });
    const events = f.audit(); expect(events.map(row => row.by)).toEqual(["user", "codex", "codex"]);
    expect(events.at(-1)).toMatchObject({ authorization: receipt.id, by: "codex", commit: f.commit, version: "1.2.3" });
    const allowed = await f.guard(); expect(allowed.ok === true, allowed.error).toBe(true); expect(allowed.receipts[0].by).toBe("codex");
    await f.restart(); expect((await f.guard()).ok).toBe(false); // No file or old audit restores consent into the new daemon generation.
  } finally { await f.close(); }
}, 20_000);

for (const context of ["associated-private-task", "latched-private-turn"] as const) {
  test(`#1063 configured conductor in ${context} cannot authorize or write an audit`, async () => {
    const f = await conductorReleaseRig("local"), peer = f.peers.get("local")!;
    try {
      const id = await f.privateTask();
      if (context === "latched-private-turn") {
        peer.begin();
        const events = readFileSync(join(f.stateDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(events.some(row => row.type === "turn_start" && row.peer === "local")).toBe(true);
        const closed = await f.person.request({ t: "task", op: "hub_task_cancel", args: { id, reason: "End task while preserving the actual private turn latch" } });
        expect(closed.ok === true, closed.error).toBe(true); expect(peer.state).toBe("busy");
        const board = new Board(join(f.stateDir, "hub.db")); try { expect(board.get(id)?.state).toBe("cancelled"); } finally { board.close(); }
      } else expect(peer.state).toBe("idle");
      const denied = await f.authorize(); expect(denied.ok).toBe(false); expect(f.docsCalls).toBe(0); expect(f.audit()).toEqual([]);
      expect((await f.guard()).ok).toBe(false);
    } finally { peer.end(); await f.close(); }
  }, 20_000);
}

for (const change of ["head", "origin", "role", "private-context"] as const) {
  test(`#1063 conductor authorization rechecks ${change} after the committed-doc await`, async () => {
    const f = await conductorReleaseRig(change === "private-context" ? "local" : "codex");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    try {
      const captured = f.evidence(); f.setDocs(async () => { entered(); await gate; return captured; });
      const call = f.authorize(), outcome = call.then(reply => ({ reply }), error => ({ error }));
      await Promise.race([started, call.then(() => { throw new Error("authorization missed the committed-doc barrier"); })]);
      if (change === "head") f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "changed release candidate");
      else if (change === "origin") f.git("remote", "set-url", "--push", "origin", join(f.temp, "other-local-remote.git"));
      else if (change === "role") {
        const next = structuredClone(f.roles); next.codex = next.codex!.filter(role => role !== "conductor"); next.local!.push("conductor");
        const changed = await f.reloadRoles(next); expect(changed.ok === true, changed.error).toBe(true);
        expect(await f.liveRoles("codex")).toEqual(next.codex!); expect(await f.liveRoles("local")).toEqual(next.local!);
        expect((await f.liveRoles("codex")).includes("conductor")).toBe(false);
        expect((await f.liveRoles("local")).includes("conductor")).toBe(true);
      }
      else await f.privateTask();
      release();
      const settled = await outcome; if ("error" in settled) throw settled.error;
      const reply = settled.reply; expect(reply.ok).toBe(false); expect(f.docsCalls).toBe(1); expect(f.audit()).toEqual([]);
      expect((await f.guard()).ok).toBe(false);
    } finally {
      release();
      await f.close();
    }
  }, 20_000);
}

test("#1063 conductor authority still cannot consent to the wrong candidate/version or stale documentation", async () => {
  const f = await conductorReleaseRig();
  try {
    for (const fields of [{ version: "1.2.4", commit: f.commit }, { version: "1.2.3", commit: "a".repeat(40) }])
      expect((await f.conductor.request({ t: "sdlc", op: "authorize-release", ...fields })).ok).toBe(false);
    expect(f.docsCalls).toBe(0); expect(f.audit()).toEqual([]);
    f.setDocs(async () => ({ ...f.evidence(), fresh: false }));
    expect((await f.authorize()).ok).toBe(false); expect(f.audit()).toEqual([]); expect((await f.guard()).ok).toBe(false);
  } finally { await f.close(); }
}, 20_000);


test("#1063 an ambiguous conductor reload is refused without granting the proposed second peer authority", async () => {
  const f = await conductorReleaseRig();
  try {
    const codexBefore = await f.liveRoles("codex"), localBefore = await f.liveRoles("local");
    const ambiguous = structuredClone(f.roles); ambiguous.local!.push("conductor");
    const rejected = await f.reloadRoles(ambiguous); expect(rejected.ok).toBe(false);
    expect(await f.liveRoles("codex")).toEqual(codexBefore); expect(await f.liveRoles("local")).toEqual(localBefore);
    expect((await f.liveRoles("codex")).includes("conductor")).toBe(true);
    expect((await f.liveRoles("local")).includes("conductor")).toBe(false);
    const refused = await f.authorize(f.other); expect(refused.ok).toBe(false);
    expect(f.docsCalls).toBe(0); expect(f.audit()).toEqual([]); expect((await f.guard()).ok).toBe(false);
    // Invalid raw policy never replaces the accepted map. This is not an invented mid-call authority revocation.
    const stillUnique = await f.authorize(); expect(stillUnique.ok === true, stillUnique.error).toBe(true);
    expect(stillUnique.authorization.by).toBe("codex");
  } finally { await f.close(); }
}, 20_000);
