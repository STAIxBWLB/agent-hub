import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { VERSION } from "../src/version.ts";
import { canonicalInstruction, instructionHash, InstructionReceipts, type PendingInstruction } from "../src/hub/instruction-receipt.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const session = "ff2b6675-873c-4a2d-963e-8d6eb5fcc439", promptId = "d1d605d8-a169-413b-8da2-6bffe44e028d", recordId = "3004bef3-8884-4e54-bbf2-c5c760a52097";
const start = Date.parse("2026-11-22T00:00:00.000Z");
function fixture() {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-instruction-"))); dirs.push(dir);
  const home = join(dir, "home"), cwd = join(dir, "work"); mkdirSync(home); mkdirSync(cwd);
  const project = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); mkdirSync(project, { recursive: true });
  const transcript = join(project, `${session}.jsonl`);
  const store = new InstructionReceipts(join(dir, "hub.db"), async (asked, peer) => ({ session: asked, peer, home, cwd, transcript }), () => start + 10);
  const pending: PendingInstruction = { session, promptId, transcript, home, cwd, project: cwd, peer: "claude", hash: instructionHash("show   status") };
  const record = { type: "user", uuid: recordId, sessionId: session, promptId, version: "2.1.329", timestamp: new Date(start + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>show   status</command-args>" } };
  return { store, pending, record, transcript };
}

test("canonical instructions preserve interior bytes and refuse ambiguous syntax", () => {
  expect(canonicalInstruction("/agent-hub:ahub   show   status  ")).toBe("show   status");
  expect(canonicalInstruction("/agent-hub:ahub")).toBe("");
  for (const input of ["/agent-hub:ahub-extra", " /agent-hub:ahub x", "/agent-hub:ahub <x>", "/agent-hub:ahub a&b"]) expect(canonicalInstruction(input)).toBeUndefined();
  expect(instructionHash("show   status")).not.toBe(instructionHash("show status"));
});

test("confirmation binds a later genuine command, prompt id and one record once", async () => {
  const f = fixture(); try {
    expect(f.store.pending(f.pending, start)).toBe(true);
    writeFileSync(f.transcript, JSON.stringify(f.record) + "\n");
    const confirmed = await f.store.forPeer("claude").confirmReceipt(session, start + 10);
    expect(confirmed).toMatchObject({ session, args: "show   status" });
    expect(await f.store.forPeer("claude").confirmReceipt(session, start + 11)).toBeUndefined();
    expect(f.store.pending(f.pending, start + 12)).toBe(false);
  } finally { f.store.close(); }
});

test("untrusted or mismatched records and paths cannot confirm", async () => {
  for (const change of [{ isMeta: true }, { isSidechain: true }, { origin: undefined }, { origin: { kind: "agent" } }, { promptSource: "typed" }, { promptId: "d1d605d8-a169-413b-8da2-6bffe44e028e" }, { timestamp: new Date(start - 1).toISOString() }, { cwd: "/other" }, { version: "2.1.330" }, { message: { role: "user", content: [{ type: "tool_result", content: "show   status" }] } }]) {
    const f = fixture(); try { f.store.pending(f.pending, start); writeFileSync(f.transcript, JSON.stringify({ ...f.record, ...change }) + "\n"); expect(await f.store.forPeer("claude").confirmReceipt(session, start + 10)).toBeUndefined(); } finally { f.store.close(); }
  }
  const f = fixture(); try { f.store.pending({ ...f.pending, transcript: join(f.pending.home, "outside.jsonl") }, start); writeFileSync(join(f.pending.home, "outside.jsonl"), JSON.stringify(f.record) + "\n"); expect(await f.store.forPeer("claude").confirmReceipt(session, start + 10)).toBeUndefined(); } finally { f.store.close(); }
});

test("version, expiry, Stop and operation limits fail closed", async () => {
  const f = fixture(); try {
    expect(f.store.pending(f.pending, start)).toBe(true);
    writeFileSync(f.transcript, JSON.stringify({ ...f.record, version: "2.1.330" }) + "\n");
    expect(await f.store.forPeer("claude").confirmReceipt(session, start + 1)).toBeUndefined();
    writeFileSync(f.transcript, JSON.stringify(f.record) + "\n");
    writeFileSync(f.transcript, JSON.stringify(f.record) + "\n");
    const c = (await f.store.forPeer("claude").confirmReceipt(session, start + 1))!;
    for (let i = 0; i < 10; i++) expect(f.store.consume(c.id, start + 2)).toBe(true);
    expect(f.store.consume(c.id, start + 3)).toBe(false);
  } finally { f.store.close(); }
  const expired = fixture(); try { expired.store.pending(expired.pending, start); writeFileSync(expired.transcript, JSON.stringify(expired.record) + "\n"); expect(await expired.store.forPeer("claude").confirmReceipt(session, start + 600_000)).toBeUndefined(); expect(await expired.store.forPeer("claude").confirmReceipt(session, start + 1)).toBeUndefined(); } finally { expired.store.close(); }
  const g = fixture(); try { g.store.pending(g.pending, start); g.store.stop(session); writeFileSync(g.transcript, JSON.stringify(g.record) + "\n"); expect(await g.store.forPeer("claude").confirmReceipt(session, start + 1)).toBeUndefined(); } finally { g.store.close(); }
});

test("a transcript UUID cannot confirm two pending receipts", async () => {
  const f = fixture(); try {
    const secondId = "d1d605d8-a169-413b-8da2-6bffe44e028e";
    expect(f.store.pending(f.pending, start)).toBe(true);
    expect(f.store.pending({ ...f.pending, promptId: secondId }, start + 1)).toBe(true);
    writeFileSync(f.transcript, [f.record, { ...f.record, uuid: f.record.uuid.toUpperCase(), promptId: secondId, timestamp: new Date(start + 2).toISOString() }].map(row => JSON.stringify(row)).join("\n") + "\n");
    expect(await f.store.forPeer("claude").confirmReceipt(session, start + 3)).toBeDefined();
    expect(await f.store.forPeer("claude").confirmReceipt(session, start + 4)).toBeUndefined();
  } finally { f.store.close(); }
});

test("confirmed receipts close on Stop and cannot revive after expiry", async () => {
  const f = fixture(); try {
    f.store.pending(f.pending, start); writeFileSync(f.transcript, JSON.stringify(f.record) + "\n");
    const c = (await f.store.forPeer("claude").confirmReceipt(session, start + 2))!;
    f.store.stop(session); expect(f.store.consume(c.id, start + 3)).toBe(false);
  } finally { f.store.close(); }
  const g = fixture(); try {
    g.store.pending(g.pending, start); writeFileSync(g.transcript, JSON.stringify(g.record) + "\n");
    const c = (await g.store.forPeer("claude").confirmReceipt(session, start + 2))!;
    expect(g.store.consume(c.id, start + 600_000)).toBe(false);
    expect(g.store.consume(c.id, start + 3)).toBe(false);
  } finally { g.store.close(); }
});

test("hook emits only a hash for a prefixed prompt", async () => {
  const { parseInstructionHook } = await import("../src/cli/instruction-hook.ts");
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-instruction-home-"))); dirs.push(dir);
  const env = { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: session };
  const input = { hook_event_name: "UserPromptSubmit", session_id: session, prompt_id: promptId, transcript_path: join(dir, "transcript.jsonl"), cwd: process.cwd(), prompt: "/agent-hub:ahub   show   status" };
  const sent = parseInstructionHook(JSON.stringify(input), env);
  expect(sent).toMatchObject({ op: "pending", session, promptId, hash: instructionHash("show   status") });
  expect(JSON.stringify(sent)).not.toContain("show   status");
  expect(parseInstructionHook(JSON.stringify({ ...input, prompt_id: undefined }), env)).toBeUndefined();
  expect(parseInstructionHook(JSON.stringify({ ...input, prompt: "/agent-hub:ahub-other" }), env)).toBeUndefined();
  expect(parseInstructionHook(JSON.stringify({ hook_event_name: "Stop", session_id: session }), env)).toEqual({ t: "instruction_hook", op: "stop", session });
});

test("host session evidence, not a submitted home or session, authorizes confirmation", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-instruction-unbound-"))); dirs.push(dir);
  const home = join(dir, "home"), cwd = join(dir, "work"); mkdirSync(home); mkdirSync(cwd);
  const project = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); mkdirSync(project, { recursive: true });
  const transcript = join(project, `${session}.jsonl`);
  const row = { type: "user", uuid: recordId, sessionId: session, promptId, version: "2.1.329", timestamp: new Date(start + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>show status</command-args>" } };
  writeFileSync(transcript, JSON.stringify(row) + "\n");
  let evidence = false;
  const store = new InstructionReceipts(join(dir, "hub.db"), async (asked, peer) => evidence ? { session: asked, peer, home, cwd, transcript } : undefined, () => start + 10);
  try {
    expect(store.pending({ session, promptId, transcript, home: join(dir, "forged"), cwd: "/forged", project: cwd, hash: instructionHash("show status"), peer: "claude" }, start)).toBe(true);
    expect(await store.forPeer("claude").confirmReceipt(session, start + 2)).toBeUndefined();
    evidence = true;
    expect(await store.forPeer("codex").confirmReceipt(session, start + 2)).toBeUndefined();
    expect(await store.forPeer("claude").confirmReceipt(session, start + 2)).toMatchObject({ args: "show status" });
  } finally { store.close(); }
});

test("a fabricated session cannot borrow another session's host evidence", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-instruction-foreign-"))); dirs.push(dir);
  const home = join(dir, "home"), cwd = join(dir, "work"); mkdirSync(home); mkdirSync(cwd);
  const other = "ff2b6675-873c-4a2d-963e-8d6eb5fcc438", project = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); mkdirSync(project, { recursive: true });
  const transcript = join(project, `${other}.jsonl`);
  const store = new InstructionReceipts(join(dir, "hub.db"), async (_asked, peer) => ({ session, peer, home, cwd, transcript: join(project, `${session}.jsonl`) }), () => start + 10);
  try {
    expect(store.pending({ session: other, promptId, transcript, home, cwd, project: cwd, hash: instructionHash("show status"), peer: "claude" }, start)).toBe(true);
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: recordId, sessionId: other, promptId, version: "2.1.329", timestamp: new Date(start + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>show status</command-args>" } }) + "\n");
    expect(await store.forPeer("claude").confirmReceipt(other, start + 2)).toBeUndefined();
  } finally { store.close(); }
});

test("managed home installation adds both instruction hooks without replacing caller hooks", async () => {
  const { checkClaudeProfileHook, installClaudeProfileHook } = await import("../src/cli/claude-profile-hook.ts");
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-instruction-setup-"))); dirs.push(dir);
  const home = { path: dir, exists: true, sources: ["environment"] as ("environment")[] };
  const foreign = { hooks: [{ type: "command", command: "caller-stop" }] };
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { Stop: [foreign] } }), { mode: 0o600 });
  const opts = { instruction: true };
  expect(checkClaudeProfileHook(home, opts).state).toBe("missing");
  expect(installClaudeProfileHook(home, opts)).toMatchObject({ state: "installed", changed: true });
  const value = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(value.hooks.Stop[0]).toEqual(foreign);
  for (const event of ["UserPromptSubmit", "Stop"]) expect(value.hooks[event].filter((entry: any) => entry.hooks.some((hook: any) => hook.command.endsWith(" instruction-hook")))).toHaveLength(1);
  expect(installClaudeProfileHook(home, opts)).toMatchObject({ state: "installed", changed: false });
});

test("instruction hook setup deduplicates only its own exact command and preserves metadata", async () => {
  const { installClaudeProfileHook } = await import("../src/cli/claude-profile-hook.ts");
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-instruction-dedupe-"))); dirs.push(dir);
  const home = { path: dir, exists: true, sources: ["environment"] as ("environment")[] }, opts = { instruction: true };
  installClaudeProfileHook(home, opts);
  const file = join(dir, "settings.json"), value = JSON.parse(readFileSync(file, "utf8"));
  const first = value.hooks.UserPromptSubmit[0], foreign = { hooks: [{ type: "command", command: first.hooks[0].command + " --extra" }] };
  value.hooks.UserPromptSubmit = [{ ...first, description: "keep" }, foreign, first];
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  expect(installClaudeProfileHook(home, opts)).toMatchObject({ state: "installed", changed: true });
  const after = JSON.parse(readFileSync(file, "utf8"));
  expect(after.hooks.UserPromptSubmit).toEqual([{ ...first, description: "keep" }, foreign]);
});

test("daemon refuses forged session evidence and never publishes prompt text", async () => {
  const { startDaemon } = await import("../src/hub/daemon.ts");
  const { processSignature } = await import("../src/pi/process-signature.ts");
  const { ControlClient, stateDirFor } = await import("../src/hub/control-client.ts");
  const { FakeMemoryClient, startFakeMemWorker } = await import("./fakes/mem-worker.ts");
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-instruction-daemon-"))); dirs.push(dir);
  const home = join(dir, "home"), config = join(home, "claude"), cwd = join(dir, "work"); mkdirSync(home); mkdirSync(config); mkdirSync(cwd); mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, task_sweep: { enabled: false } }));
  const vars = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME"] as const, before = vars.map(key => process.env[key]);
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: config, AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "mem") });
  let captured: InstructionReceipts | undefined;
  const worker = startFakeMemWorker(), memory = new FakeMemoryClient(worker.url);
  await memory.save({ text: "MEMORY-CONTROL", project: "fixture", metadata: {} });
  const stateDir = stateDirFor(cwd), daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, memoryClient: memory, instructionReceiptStore: store => { captured = store; return store; } });
  try {
    const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" });
    try {
      const fake = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);
      const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: session,
        AGENTHUB_PEER_ID: "claude", AGENTHUB_PROJECT_DIR: cwd, AGENTHUB_STATE_DIR: stateDir, AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "mem") };
      for (const key of ["CLAUDE_PID", "CODEX_THREAD_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_INSTANCE_ID"]) delete childEnv[key];
      const forged = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "instruction-hook"], { cwd, env: childEnv,
        stdin: Buffer.from(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt_id: promptId, transcript_path: fake, cwd, prompt: "/agent-hub:ahub SECRET-USER-PROMPT" })), stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(forged.stdout).text(), new Response(forged.stderr).text(), forged.exited]);
      expect(code).toBe(0); expect(out + err).not.toContain("SECRET-USER-PROMPT");
      const { Database } = await import("bun:sqlite"); const db = new Database(join(stateDir, "hub.db"), { readonly: true });
      try { expect((db.query("SELECT COUNT(*) AS n FROM instruction_receipts").get() as { n: number }).n).toBe(1); } finally { db.close(); }
      const rejected = await tools.request({ t: "instruction_hook", op: "pending", session, promptId, transcript: fake, home: config, cwd, hash: instructionHash("SECRET-USER-PROMPT"), prompt: "SECRET-USER-PROMPT" });
      expect(rejected.ok).toBe(false);
      const result = await tools.request({ t: "instruction_hook", op: "pending", session, promptId, transcript: fake, home: config, cwd, hash: instructionHash("SECRET-USER-PROMPT") });
      expect(result.ok).toBe(false);
      expect(await captured!.forPeer("claude").confirmReceipt(session, Date.now())).toBeUndefined();
      const status = await tools.request({ t: "status" });
      expect(JSON.stringify(status)).not.toContain("SECRET-USER-PROMPT");
      const native = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
      const pushes: unknown[] = []; native.onPush = msg => { pushes.push(msg); };
      try {
        for (let n = 0; n < 100 && daemon.bus.stateOf("claude") !== "idle"; n++) await Bun.sleep(5);
        mkdirSync(join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true }); writeFileSync(fake, "");
        const instanceId = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).instanceId;
        const facts = await tools.request({ t: "facts", phase: "session", sessionId: session, transcriptPath: fake, nativeInstanceId: instanceId });
        expect(facts.ok).toBe(true);
        const secondId = "d1d605d8-a169-413b-8da2-6bffe44e028e";
        expect((await tools.request({ t: "instruction_hook", op: "pending", session, promptId: secondId, transcript: fake, home: config, cwd, hash: instructionHash("show status") })).ok).toBe(true);
        await Bun.sleep(5);
        writeFileSync(fake, JSON.stringify({ type: "user", uuid: recordId, sessionId: session, promptId: secondId, version: "2.1.329", timestamp: new Date().toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>show status</command-args>" } }) + "\n");
        // A forged facts message and a fabricated transcript without a managed launch prove nothing.
        expect(await captured!.forPeer("claude").confirmReceipt(session, Date.now())).toBeUndefined();
        expect((await tools.request({ t: "instruction_hook", op: "stop", session })).ok).toBe(true);
        const launchId = "fixture-managed-launch", launchFile = join(stateDir, "claude-launch.json");
        writeFileSync(launchFile, JSON.stringify({ instanceId, launchId, permissionHook: true, launcherPid: process.pid, launcherSignature: "stale-signature" }), { mode: 0o600 });
        expect((await tools.request({ t: "facts", phase: "session", sessionId: session, transcriptPath: fake, nativeInstanceId: instanceId, nativeLaunchId: launchId })).ok).toBe(true);
        const staleId = "d1d605d8-a169-413b-8da2-6bffe44e028c";
        expect((await tools.request({ t: "instruction_hook", op: "pending", session, promptId: staleId, transcript: fake, home: config, cwd, hash: instructionHash("show status") })).ok).toBe(true);
        await Bun.sleep(5);
        writeFileSync(fake, JSON.stringify({ type: "user", uuid: recordId, sessionId: session, promptId: staleId, version: "2.1.329", timestamp: new Date().toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>show status</command-args>" } }) + "\n");
        expect(await captured!.forPeer("claude").confirmReceipt(session, Date.now())).toBeUndefined();
        expect((await tools.request({ t: "instruction_hook", op: "stop", session })).ok).toBe(true);
        writeFileSync(launchFile, JSON.stringify({ instanceId, launchId, permissionHook: true, launcherPid: process.pid, launcherSignature: processSignature(process.pid) }), { mode: 0o600 });
        expect((await tools.request({ t: "facts", phase: "session", sessionId: session, transcriptPath: fake, nativeInstanceId: instanceId, nativeLaunchId: launchId })).ok).toBe(true);
        const thirdId = "d1d605d8-a169-413b-8da2-6bffe44e028f";
        expect((await tools.request({ t: "instruction_hook", op: "pending", session, promptId: thirdId, transcript: fake, home: config, cwd, hash: instructionHash("SECRET-USER-PROMPT") })).ok).toBe(true);
        await Bun.sleep(5);
        writeFileSync(fake, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52098", sessionId: session, promptId: thirdId, version: "2.1.329", timestamp: new Date().toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>SECRET-USER-PROMPT</command-args>" } }) + "\n");
        const confirmed = await captured!.forPeer("claude").confirmReceipt(session, Date.now());
        expect(confirmed).toMatchObject({ args: "SECRET-USER-PROMPT" });
        expect(JSON.stringify(await tools.request({ t: "status" }))).not.toContain("SECRET-USER-PROMPT");
        expect(await captured!.forPeer("claude").confirmReceipt(session, Date.now())).toBeUndefined();
        expect((await tools.request({ t: "instruction_hook", op: "stop", session })).ok).toBe(true);
        expect(captured!.consume(confirmed!.id, Date.now())).toBe(false);
        expect(JSON.stringify(pushes)).not.toContain("SECRET-USER-PROMPT");
        expect(JSON.stringify(worker.calls)).not.toContain("SECRET-USER-PROMPT");
        expect(JSON.stringify(worker.calls)).toContain("MEMORY-CONTROL");
      } finally { native.close(); }
      const unknown = await tools.request({ t: "instruction_unknown_fixture" }); expect(unknown.ok).toBe(false);
      expect((await fetch(`http://127.0.0.1:${daemon.port}`, { headers: { Origin: "https://fixture.invalid" } })).status).toBe(403);
      const denied = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
      const closed = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("token refusal timeout")), 3000);
        denied.onopen = () => denied.send(JSON.stringify({ t: "hello", rid: 1, role: "tools", peer: "claude", token: "wrong" }));
        denied.onclose = event => { clearTimeout(timer); resolve(event.code); };
        denied.onerror = () => { clearTimeout(timer); reject(new Error("token refusal transport failed")); };
      });
      expect(await closed).toBe(4401);
    } finally { tools.close(); }
  } finally {
    await daemon.stop(); worker.stop();
    for (let i = 0; i < vars.length; i++) { const key = vars[i]!; if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]!; }
  }
  for (const name of ["hub.log", "events.jsonl", "status.json"]) {
    try { expect(readFileSync(join(stateDir, name), "utf8")).not.toContain("SECRET-USER-PROMPT"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}, 20_000);

test("a session change or expiry during confirmation cannot commit a stale receipt", async () => {
  for (const scenario of ["session", "expiry"] as const) {
    const f = fixture(), dbPath = join(f.pending.home, "race.db");
    let current = true, clock = start + 10, calls = 0, release!: () => void, reached!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
    const store = new InstructionReceipts(dbPath, async (asked, peer) => {
      if (++calls === 2) { reached(); await barrier; }
      return current ? { session: asked, peer, home: f.pending.home, cwd: f.pending.cwd, transcript: f.transcript } : undefined;
    }, () => clock);
    try {
      store.pending(f.pending, start); writeFileSync(f.transcript, JSON.stringify(f.record) + "\n");
      const confirmation = store.forPeer("claude").confirmReceipt(session, start + 2);
      await entered; if (scenario === "session") current = false; else clock = start + 600_000;
      release(); expect(await confirmation).toBeUndefined();
      if (scenario === "expiry") { clock = start + 10; expect(await store.forPeer("claude").confirmReceipt(session, start + 3)).toBeUndefined(); }
    } finally { store.close(); f.store.close(); }
  }
});

test("the earliest matching record wins and concurrent confirmation happens once", async () => {
  const f = fixture(); try {
    const earlier = { ...f.record, uuid: "3004bef3-8884-4e54-bbf2-c5c760a52096", timestamp: new Date(start + 1).toISOString() };
    const later = { ...f.record, timestamp: new Date(start + 2).toISOString() };
    expect(f.store.pending(f.pending, start)).toBe(true);
    writeFileSync(f.transcript, [later, earlier].map(row => JSON.stringify(row)).join("\n") + "\n");
    const results = await Promise.all([f.store.forPeer("claude").confirmReceipt(session, start + 3), f.store.forPeer("claude").confirmReceipt(session, start + 3)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const { Database } = await import("bun:sqlite"); const db = new Database(join(f.pending.home, "..", "hub.db"), { readonly: true });
    try { expect((db.query("SELECT record_uuid FROM instruction_receipts").get() as { record_uuid: string }).record_uuid).toBe(earlier.uuid); } finally { db.close(); }
  } finally { f.store.close(); }
});

test("setup previews the instruction hook before the existing confirmation", async () => {
  const { setupClaudeHomes } = await import("../src/cli/setup-homes.ts");
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-instruction-confirm-"))); dirs.push(dir);
  const home = { path: dir, exists: true, sources: ["environment"] as ("environment")[] }, shown: string[] = [];
  await setupClaudeHomes({ homes: [home], env: { HOME: dir }, packageRoot: join(import.meta.dir, ".."), yes: false, interactive: true, hook: { instruction: true },
    probe: argv => ({ status: 0, stdout: JSON.stringify(argv.includes("marketplace") ? [{ name: "agent-hub", path: join(import.meta.dir, "..") }] : [{ id: "agent-hub@agent-hub", scope: "user", version: VERSION }]) }),
    run: async () => { throw new Error("declined setup must not run"); },
    ask: async () => { expect(shown.join(" ")).toContain("UserPromptSubmit and Stop"); return "no"; }, print: line => shown.push(line) });
  expect(existsSync(join(dir, "settings.json"))).toBe(false);
});

test("confirmation refuses a symlink or hardlink transcript alias", async () => {
  for (const kind of ["symlink", "hardlink"] as const) {
    const f = fixture(); try {
      const other = join(f.pending.home, "elsewhere.jsonl");
      writeFileSync(other, JSON.stringify(f.record) + "\n");
      if (kind === "symlink") symlinkSync(other, f.transcript); else linkSync(other, f.transcript);
      expect(f.store.pending(f.pending, start)).toBe(true);
      expect(await f.store.forPeer("claude").confirmReceipt(session, start + 10)).toBeUndefined();
    } finally { f.store.close(); }
  }
});

test("a matching record outside the bounded transcript tail cannot confirm", async () => {
  const f = fixture(); try {
    expect(f.store.pending(f.pending, start)).toBe(true);
    writeFileSync(f.transcript, JSON.stringify(f.record) + "\n" + "{}\n".repeat(400_000));
    expect(await f.store.forPeer("claude").confirmReceipt(session, start + 10)).toBeUndefined();
  } finally { f.store.close(); }
});
