import { expect, test } from "bun:test";
import { parseExactInstruction } from "../src/hub/instructed-exact.ts";

test("exact instructions require run and never interpret shell syntax", () => {
  expect(parseExactInstruction("run task assign 1055 jcode")).toEqual(["task", "assign", "1055", "jcode"]);
  expect(parseExactInstruction("  run   task assign 1055 jcode  ")).toEqual(["task", "assign", "1055", "jcode"]);
  for (const input of ["task assign 1055 jcode", "run", "run --as-user", "run task 'name'", "run task \"name\"", "run task \\name", "run task $HOME", "run task `id`", "run task a&b", "run task a<b", "run task a>b", "run task\nassign", "run task\tassign"]) {
    expect(parseExactInstruction(input)).toBeUndefined();
  }
});

test("exact-mode receipt consumption is atomic and closes on the first use", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { realPath } = await import("../src/hub/project.ts");
  const { InstructionReceipts, instructionHash } = await import("../src/hub/instruction-receipt.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-exact-")));
  const home = join(root, "home"), cwd = join(root, "project"); mkdirSync(home); mkdirSync(cwd);
  const session = "3004bef3-8884-4e54-bbf2-c5c760a52090", promptId = "3004bef3-8884-4e54-bbf2-c5c760a52091";
  const project = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); mkdirSync(project, { recursive: true });
  const transcript = join(project, `${session}.jsonl`), now = Date.now();
  let clock = now + 2;
  const store = new InstructionReceipts(join(root, "hub.db"), async () => ({ session, transcript, home, cwd, peer: "claude" }), () => clock);
  try {
    expect(store.pending({ session, promptId, transcript, home, cwd, project: cwd, hash: instructionHash("run task assign 1055 jcode") }, now)).toBe(true);
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52092", sessionId: session, promptId, version: "2.1.329", timestamp: new Date(now + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>run task assign 1055 jcode</command-args>" } }) + "\n");
    const receipt = await store.forPeer("claude").confirmReceipt(session, now + 2);
    expect(receipt).toBeDefined();
    expect(store.consumeExact(receipt!.id, now + 2)).toBe(true);
    expect(store.consumeExact(receipt!.id, now + 2)).toBe(false);
    expect(store.consume(receipt!.id, now + 2)).toBe(false);
    expect(store.exactCurrent(receipt!.id, now + 2)).toBe(true);
    expect(store.exactCurrent(receipt!.id, now + 600_000)).toBe(false);
    const secondPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52093";
    expect(store.pending({ session, promptId: secondPrompt, transcript, home, cwd, project: cwd, hash: instructionHash("run task assign 1055 jcode") }, now + 3)).toBe(true);
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52094", sessionId: session, promptId: secondPrompt, version: "2.1.329", timestamp: new Date(now + 4).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>run task assign 1055 jcode</command-args>" } }) + "\n");
    clock = now + 5;
    const next = await store.forPeer("claude").confirmReceipt(session, now + 5);
    expect(next).toBeDefined(); expect(store.consumeExact(next!.id, now + 5)).toBe(true);
    store.stop(session); expect(store.exactCurrent(next!.id, now + 5)).toBe(false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("intent receipt rechecks its transcript and admits at most ten serialized uses", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { realPath } = await import("../src/hub/project.ts");
  const { InstructionReceipts, instructionHash } = await import("../src/hub/instruction-receipt.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-intent-"))), home = join(root, "home"), cwd = join(root, "project"); mkdirSync(home); mkdirSync(cwd);
  const session = "3004bef3-8884-4e54-bbf2-c5c760a52090", promptId = "3004bef3-8884-4e54-bbf2-c5c760a52091", args = "assign task 1055", now = Date.now();
  const project = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); mkdirSync(project, { recursive: true });
  let clock = now + 2;
  const transcript = join(project, `${session}.jsonl`), store = new InstructionReceipts(join(root, "hub.db"), async () => ({ session, transcript, home, cwd, peer: "claude" }), () => clock);
  try {
    expect(store.pending({ session, promptId, transcript, home, cwd, project: cwd, hash: instructionHash(args) }, now)).toBe(true);
    const row = JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52092", sessionId: session, promptId, version: "2.1.329", timestamp: new Date(now + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${args}</command-args>` } }) + "\n";
    writeFileSync(transcript, row);
    const receipt = await store.forPeer("claude").confirmIntent(session, now + 2);
    expect(receipt?.args).toBe(args);
    writeFileSync(transcript, "");
    expect(await store.forPeer("claude").confirmIntent(session, now + 2)).toBeUndefined();
    writeFileSync(transcript, row);
    for (let n = 0; n < 10; n++) {
      expect((await store.forPeer("claude").confirmIntent(session, now + 2))?.id).toBe(receipt!.id);
      expect(store.consumeIntent(receipt!.id, now + 2)).toBe(true);
      expect(store.consumeIntent(receipt!.id, now + 2)).toBe(false);
      expect(store.exactCurrent(receipt!.id, now + 2)).toBe(true);
      store.finishExact(receipt!.id);
    }
    expect(await store.forPeer("claude").confirmIntent(session, now + 2)).toBeUndefined();
    expect(store.consumeIntent(receipt!.id, now + 2)).toBe(false);
    const nextPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52093";
    expect(store.pending({ session, promptId: nextPrompt, transcript, home, cwd, project: cwd, hash: instructionHash(args) }, now + 3)).toBe(true);
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52094", sessionId: session, promptId: nextPrompt, version: "2.1.329", timestamp: new Date(now + 4).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${args}</command-args>` } }) + "\n");
    clock = now + 5;
    const next = await store.forPeer("claude").confirmIntent(session, now + 5);
    expect(next).toBeDefined(); expect(store.consumeIntent(next!.id, now + 5)).toBe(true);
    store.stop(session, "claude");
    expect(store.exactCurrent(next!.id, now + 5)).toBe(false);
    expect(await store.forPeer("claude").confirmIntent(session, now + 5)).toBeUndefined();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("verdict identifiers must appear literally as complete identifiers", async () => {
  const { literalInstructionIds } = await import("../src/hub/instructed-intent.ts");
  expect(literalInstructionIds("approve task #1055", ["1055"])).toBe(true);
  expect(literalInstructionIds("approve task #11055", ["1055"])).toBe(false);
  expect(literalInstructionIds("task 1055 claim 2", ["1055", "2"])).toBe(true);
  expect(literalInstructionIds("task 1055", ["1055", "2"])).toBe(false);
  expect(literalInstructionIds("task 1 claim 1", ["1", "1"])).toBe(true);
  expect(literalInstructionIds("task 1", ["1", "1"])).toBe(false);
  expect(literalInstructionIds("approve rc-0123456789ab", ["rc-0123456789ab"])).toBe(true);
  expect(literalInstructionIds("approve rc-0123456789ab-extra", ["rc-0123456789ab"])).toBe(false);
  expect(literalInstructionIds("approve 1055", ["1055|.*"])).toBe(false);
});

test("a newer unconfirmed or closed intent never revives an older receipt", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { realPath } = await import("../src/hub/project.ts");
  const { InstructionReceipts, instructionHash } = await import("../src/hub/instruction-receipt.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-intent-latest-"))), home = join(root, "home"), cwd = join(root, "project"); mkdirSync(home); mkdirSync(cwd);
  const session = "3004bef3-8884-4e54-bbf2-c5c760a52090", first = "3004bef3-8884-4e54-bbf2-c5c760a52091", second = "3004bef3-8884-4e54-bbf2-c5c760a52092", args = "assign task 1055", now = Date.now();
  const project = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); mkdirSync(project, { recursive: true });
  const transcript = join(project, `${session}.jsonl`); let clock = now + 2;
  const store = new InstructionReceipts(join(root, "hub.db"), async () => ({ session, transcript, home, cwd, peer: "claude" }), () => clock);
  const record = (promptId: string, uuid: string, at: number) => JSON.stringify({ type: "user", uuid, sessionId: session, promptId, version: "2.1.329", timestamp: new Date(at).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${args}</command-args>` } }) + "\n";
  try {
    expect(store.pending({ session, promptId: first, transcript, home, cwd, project: cwd, hash: instructionHash(args) }, now)).toBe(true);
    writeFileSync(transcript, record(first, "3004bef3-8884-4e54-bbf2-c5c760a52093", now + 1));
    expect(await store.forPeer("claude").confirmIntent(session, now + 2)).toBeDefined();
    expect(store.pending({ session, promptId: second, transcript, home, cwd, project: cwd, hash: instructionHash(args) }, now + 3)).toBe(true);
    clock = now + 5;
    expect(await store.forPeer("claude").confirmIntent(session, now + 5)).toBeUndefined();
    writeFileSync(transcript, record(second, "3004bef3-8884-4e54-bbf2-c5c760a52094", now + 4));
    const recent = await store.forPeer("claude").confirmIntent(session, now + 5);
    expect(recent).toBeDefined();
    for (let n = 0; n < 10; n++) { expect(store.consumeIntent(recent!.id, now + 5)).toBe(true); store.finishExact(recent!.id); }
    expect(await store.forPeer("claude").confirmIntent(session, now + 5)).toBeUndefined();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("intent command policy closes spending, identity, release and unknown forms", async () => {
  const { intentForm } = await import("../src/hub/instructed-intent.ts");
  for (const args of [["task", "assign", "1055", "claude"], ["task", "claim", "1055", "2", "supported"], ["backlog", "pull", "1055"], ["backlog", "return", "1055"], ["stop", "claude"], ["model", "clear", "claude"], ["results"], ["capabilities"], ["learn", "list"], ["learn", "accept", "1055"], ["review", "1055", "approved"]]) expect(intentForm(args), args.join(" ")).toBeDefined();
  for (const args of [["settings", "set", "tasks.auto_pull", "true"], ["agents", "trust", "claude", "1"], ["permission", "claude", "never-ask"], ["reset"], ["sdlc", "merge", "1"], ["task", "assign", "1", "claude", "--as-user"], ["results", "--read-all"], ["role", "assign", "claude", "planner"], ["title", "claude", "private text"], ["backlog", "add", "implement", "title"], ["backlog", "pin", "1", "0", "true", "reason"], ["backlog", "split", "1", "0", "[]", "reason"], ["study", "approve", "rc-0123456789ab", "1"], ["roadmap", "state", "1", "done"], ["task", "claim", "1", "1", "supported", "--manifest", "file"], ["task", "handoff", "--project", "elsewhere", "title"], ["review", "1", "approved", "some note"], ["unknown"]]) expect(intentForm(args), args.join(" ")).toBeUndefined();
});

test("instructed mode defaults to intent and rejects unknown modes", async () => {
  const { instructedMode } = await import("../src/hub/instructed-exact.ts");
  expect(instructedMode(undefined)).toBe("intent");
  expect(instructedMode("off")).toBe("off");
  expect(instructedMode("exact")).toBe("exact");
  expect(instructedMode("intent")).toBe("intent");
  for (const value of [null, true, "EXACT"]) expect(() => instructedMode(value)).toThrow();
});

test("the exact form policy closes unknown forms and detects task scope", async () => {
  const { exactForm } = await import("../src/hub/instructed-exact.ts");
  expect(exactForm(["task", "assign", "1055", "jcode"])).toEqual({ argv: ["task", "assign", "1055", "jcode"], taskId: 1055 });
  expect(exactForm(["task", "claim", "1055", "2", "supported"])).toEqual({ argv: ["task", "claim", "1055", "2", "supported"], taskId: 1055 });
  for (const args of [["task", "claim", "1055", "0", "supported"], ["task", "claim", "1055", "2", "unknown"], ["task", "claim", "1055", "2", "supported", "--manifest", "input.json", "--disposition", "resolved"], ["task", "claim", "1055", "2", "supported", "--model", "label"]]) expect(exactForm(args)).toBeUndefined();
  expect(exactForm(["task", "unassign", "1055", "--role", "reviewer", "--revision", "3"])?.taskId).toBe(1055);
  expect(exactForm(["settings", "set", "tasks.auto_pull", "true", "--yes"])).toBeDefined();
  expect(exactForm(["settings", "set", "tasks.wip_limits.claude", "2"])).toBeDefined();
  expect(exactForm(["settings", "set", "tasks.queue_backpressure.max_queued", "4"])).toBeDefined();
  expect(exactForm(["stop", "jcode"])).toBeDefined();
  expect(exactForm(["pause", "jcode"])).toBeDefined();
  expect(exactForm(["resume", "jcode"])).toBeDefined();
  for (const key of ["budget.gate", "review.gate", "review.unknown_quota", "review.max_minutes"]) expect(exactForm(["settings", "set", key, "0.9"])).toBeUndefined();
  expect(exactForm(["model", "set", "jcode", "model-1"])).toBeDefined();
  expect(exactForm(["model", "clear", "jcode"])).toBeDefined();
  expect(exactForm(["backlog", "pull", "1055"])?.taskId).toBe(1055);
  for (const words of [["settings", "set", "instructed.mode", "off"], ["settings", "set", "permission.claude", "never-ask"], ["task", "assign", "1055", "jcode", "--as-user"], ["task", "assign", "1055", "jcode", "--project", "elsewhere"], ["task", "assign", "1055", "jcode", "--role", "owner", "--role", "reviewer"], ["agents", "trust", "jcode", "1.0"], ["permission", "claude", "never-ask"], ["settings", "set", "local.bash_network", "true"], ["reset"], ["broker", "room", "drop", "room"], ["sdlc", "authorize-release", "0.1.0"], ["sdlc", "merge", "1"], ["peer", "takeover", "claude"], ["recovery", "reattach", "1"], ["task", "claim", "1055"], ["unknown"]]) expect(exactForm(words)).toBeUndefined();
});


test("runtime guard refuses project roots, sandbox roots and any checkout ancestor", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { realPath } = await import("../src/hub/project.ts");
  const { instructedRuntimeAllowed } = await import("../src/hub/instructed-runtime.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-runtime-")));
  try {
    const installed = join(root, "installed"), project = join(root, "project"), worktree = join(root, "other");
    for (const dir of [installed, project, worktree]) mkdirSync(dir);
    expect(instructedRuntimeAllowed(installed, [project])).toBe(true);
    expect(instructedRuntimeAllowed(installed, [installed])).toBe(false);
    expect(instructedRuntimeAllowed(installed, [join(root, "missing")])).toBe(false);
    writeFileSync(join(worktree, ".git"), "gitdir: elsewhere");
    const nested = join(worktree, "package"); mkdirSync(nested);
    expect(instructedRuntimeAllowed(nested, [project])).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the daemon executes confirmed exact and intent commands through its inherited installed CLI socket", async () => {
  const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { realPath } = await import("../src/hub/project.ts");
  const { Board } = await import("../src/hub/board.ts");
  const { startDaemon } = await import("../src/hub/daemon.ts");
  const { ControlClient, stateDirFor } = await import("../src/hub/control-client.ts");
  const { processSignature } = await import("../src/pi/process-signature.ts");
  const { instructionHash } = await import("../src/hub/instruction-receipt.ts");
  const { FakeMemoryClient, startFakeMemWorker } = await import("./fakes/mem-worker.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-exact-e2e-")));
  const install = join(root, "installed"), home = join(root, "home"), config = join(home, "claude"), cwd = join(root, "project");
  for (const dir of [install, home, config, cwd]) mkdirSync(dir);
  const { spawnSync } = await import("node:child_process");
  expect(spawnSync("git", ["init", "-q", cwd], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).status).toBe(0);
  const repo = join(import.meta.dir, "..");
  cpSync(join(repo, "src"), join(install, "src"), { recursive: true });
  cpSync(join(repo, "plugins"), join(install, "plugins"), { recursive: true });
  cpSync(join(repo, "templates"), join(install, "templates"), { recursive: true });
  cpSync(join(repo, "package.json"), join(install, "package.json"));
  const memoryFile = fileURLToPath(import.meta.resolve("@staix/agent-mem"));
  mkdirSync(join(install, "node_modules", "@staix"), { recursive: true });
  cpSync(dirname(dirname(memoryFile)), join(install, "node_modules", "@staix", "agent-mem"), { recursive: true });
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: true }, inference: { enabled: false }, mlx: { enabled: false }, task_sweep: { enabled: false } }));
  writeFileSync(join(cwd, ".agenthub/routing.toml"), readFileSync(join(repo, "templates/routing.toml"), "utf8").replace('pii = "local_only"', 'pii = "off"').replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"'));
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME"] as const, previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: config, AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "mem") });
  const stateDir = stateDirFor(cwd); mkdirSync(stateDir, { recursive: true });
  const board = new Board(join(stateDir, "hub.db"));
  const task = board.propose("user", { title: "instructed fixture", class: "implement" }); board.close();
  let captured: import("../src/hub/instruction-receipt.ts").InstructionReceipts | undefined;
  const worker = startFakeMemWorker(), memory = new FakeMemoryClient(worker.url);
  await memory.save({ text: "MEMORY-CONTROL", project: "fixture", metadata: {} });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({ cwd, stateDir, memoryClient: memory, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, instructedRuntimeForTest: { root: install, bun: process.execPath }, instructionReceiptStore: store => { captured = store; return store; } });
    expect(captured!.mode()).toBe("intent"); captured!.setMode("exact");
    const native = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
    const pushes: unknown[] = []; native.onPush = message => { pushes.push(message); };
    const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" });
    try {
      for (let n = 0; n < 100 && daemon.bus.stateOf("claude") !== "idle"; n++) await Bun.sleep(5);
      const session = "3004bef3-8884-4e54-bbf2-c5c760a52090", promptId = "3004bef3-8884-4e54-bbf2-c5c760a52091", launchId = "fixture-managed-launch";
      const folder = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); mkdirSync(folder, { recursive: true });
      const transcript = join(folder, `${session}.jsonl`); writeFileSync(transcript, "");
      const instanceId = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).instanceId;
      const dashboard = await ControlClient.connect(stateDir, { role: "console" });
      try {
        const dashboardReply = await dashboard.request({ t: "ui_action", instanceId, action: { action: "setting", key: "instructed.mode", value: "off" } });
        expect(dashboardReply.ok).toBe(false);
      } finally { dashboard.close(); }
      const unmanaged = await tools.request({ t: "instruction_execute", session });
      expect(unmanaged.error).toContain("this Claude session was not started by ahub claude");
      expect(unmanaged.error).toContain("ahub claude");
      writeFileSync(join(stateDir, "claude-launch.json"), JSON.stringify({ instanceId, launchId, permissionHook: true, launcherPid: process.pid, launcherSignature: processSignature(process.pid) }), { mode: 0o600 });
      const missing = await tools.request({ t: "instruction_execute", session });
      expect(missing.error).toContain("no session evidence for this Claude session yet");
      expect(missing.error).toContain("send one ordinary prompt");
      expect((await tools.request({ t: "facts", phase: "session", sessionId: session, transcriptPath: transcript, nativeInstanceId: instanceId, nativeLaunchId: launchId })).ok).toBe(true);
      expect((await tools.request({ t: "instruction_execute", session })).ok).toBe(false);
      expect((await tools.request({ t: "task", op: "task_assign", args: { id: task.id, peer: "claude" } })).ok).toBe(false);
      const args = `run task assign ${task.id} claude`, started = Date.now();
      expect(captured!.pending({ session, promptId, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(args) }, started)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52092", sessionId: session, promptId, version: "2.1.329", timestamp: new Date(started + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${args}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session, argv: ["task", "assign", "999", "claude"] })).ok).toBe(false);
      const result = await tools.request({ t: "instruction_execute", session }, 35_000);
      expect(result).toMatchObject({ ok: true });
      expect(result.exitCode).toBe(0);
      expect((await tools.request({ t: "instruction_execute", session })).ok).toBe(false);
      const audit = readFileSync(join(stateDir, "events.jsonl"), "utf8");
      expect(audit).toContain('"instructed":true'); expect(audit).toContain('"instructionReceipt":'); expect(audit).not.toContain(args);
      expect(readFileSync(join(stateDir, "hub.log"), "utf8")).not.toContain(args);
      expect(JSON.stringify(await tools.request({ t: "status" }))).not.toContain(args);
      expect(JSON.stringify(pushes)).not.toContain(args);
      expect(JSON.stringify(worker.calls)).toContain("MEMORY-CONTROL");
      expect(JSON.stringify(worker.calls)).not.toContain(args);
      const settingPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52095", settingArgs = "run settings set tasks.auto_pull true --yes", settingAt = Date.now();
      expect(captured!.pending({ session, promptId: settingPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(settingArgs) }, settingAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52096", sessionId: session, promptId: settingPrompt, version: "2.1.329", timestamp: new Date(settingAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${settingArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      const settingResult = await tools.request({ t: "instruction_execute", session }, 35_000);
      expect(settingResult).toMatchObject({ ok: true, exitCode: 0 });
      expect(JSON.parse(readFileSync(join(cwd, ".agenthub", "config.local.json"), "utf8")).tasks.auto_pull).toBe(true);
      const closedForms = ["run agents trust jcode 1.0", "run settings set local.bash_network true", "run reset", "run sdlc merge 1", "run peer takeover claude"];
      const admittedBefore = readFileSync(join(stateDir, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"instructed":true')).length;
      for (const closed of closedForms) {
        const closedPrompt = crypto.randomUUID(), closedAt = Date.now();
        expect(captured!.pending({ session, promptId: closedPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(closed) }, closedAt)).toBe(true);
        writeFileSync(transcript, JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: session, promptId: closedPrompt, version: "2.1.329", timestamp: new Date(closedAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${closed}</command-args>` } }) + "\n");
        await Bun.sleep(5);
        const refused = await tools.request({ t: "instruction_execute", session }, 35_000);
        expect(refused.ok).toBe(false);
        expect(refused.error).toContain("not proven for instructed exact mode");
        expect(refused.error).toContain("cd '");
        expect(refused.error).toContain("Success:");
      }
      expect(readFileSync(join(stateDir, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"instructed":true')).length).toBe(admittedBefore);
      const modePrompt = "3004bef3-8884-4e54-bbf2-c5c760a52103", modeArgs = "run settings set instructed.mode off", modeAt = Date.now();
      expect(captured!.pending({ session, promptId: modePrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(modeArgs) }, modeAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52104", sessionId: session, promptId: modePrompt, version: "2.1.329", timestamp: new Date(modeAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${modeArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session }, 35_000)).ok).toBe(false);
      expect((JSON.parse(readFileSync(join(cwd, ".agenthub", "config.local.json"), "utf8")).instructed ?? {}).mode).toBeUndefined();
      const installedEntry = join(install, "src/cli/main.js"), entry = readFileSync(installedEntry, "utf8");
      const floodPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52105", floodArgs = `run task unassign ${task.id}`, floodAt = Date.now();
      expect(captured!.pending({ session, promptId: floodPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(floodArgs) }, floodAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52106", sessionId: session, promptId: floodPrompt, version: "2.1.329", timestamp: new Date(floodAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${floodArgs}</command-args>` } }) + "\n");
      writeFileSync(installedEntry, 'process.stdout.write("x".repeat(65537));');
      await Bun.sleep(5);
      const flooded = await tools.request({ t: "instruction_execute", session }, 35_000);
      expect(flooded.ok).toBe(false); expect(flooded.error).toContain("output exceeded its limit");
      writeFileSync(installedEntry, entry);
      const pendingBoard = new Board(join(stateDir, "hub.db"));
      let pendingTask: number;
      try { pendingTask = pendingBoard.propose("user", { title: "stop race fixture", class: "implement" }).id; } finally { pendingBoard.close(); }
      writeFileSync(installedEntry, entry.replace("// Shell completion asks", "if (process.env.AGENTHUB_INSTRUCTED_IPC) await Bun.sleep(500);\n// Shell completion asks"));
      const stopPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52099", stopArgs = `run task assign ${pendingTask} claude`, stopAt = Date.now();
      expect(captured!.pending({ session, promptId: stopPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(stopArgs) }, stopAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52100", sessionId: session, promptId: stopPrompt, version: "2.1.329", timestamp: new Date(stopAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${stopArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      const running = tools.request({ t: "instruction_execute", session }, 35_000);
      const { Database } = await import("bun:sqlite"); const inspect = new Database(join(stateDir, "hub.db"), { readonly: true });
      let spent = false;
      try { for (let n = 0; n < 100 && !spent; n++) { spent = (inspect.query("SELECT state FROM instruction_receipts WHERE prompt_id = ?").get(stopPrompt) as { state: string } | null)?.state === "closed"; if (!spent) await Bun.sleep(5); } } finally { inspect.close(); }
      expect(spent).toBe(true);
      expect((await tools.request({ t: "instruction_hook", op: "stop", session })).ok).toBe(true);
      expect((await running).ok).toBe(false);
      const afterStop = new Board(join(stateDir, "hub.db"));
      try { expect(afterStop.get(pendingTask)!.owner).toBeNull(); } finally { afterStop.close(); }
      writeFileSync(installedEntry, entry);
      const offPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52097", offArgs = `run task unassign ${task.id}`, offAt = Date.now();
      expect(captured!.pending({ session, promptId: offPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(offArgs) }, offAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52098", sessionId: session, promptId: offPrompt, version: "2.1.329", timestamp: new Date(offAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${offArgs}</command-args>` } }) + "\n");
      expect((await tools.request({ t: "settings_set", key: "instructed.mode", value: "off" })).ok).toBe(false);
      const { personEnv } = await import("../src/hub/child-process.ts");
      let terminalOutput = "";
      const person = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "settings", "set", "instructed.mode", "off"], { cwd, env: { ...personEnv(process.env), AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd }, terminal: { cols: 100, rows: 20, data: (_term: unknown, bytes: Uint8Array) => { terminalOutput += new TextDecoder().decode(bytes); } } } as never);
      expect(await person.exited).toBe(0);
      expect(terminalOutput).toContain("witness off");
      const localConfig = join(cwd, ".agenthub", "config.local.json");
      const local = JSON.parse(readFileSync(localConfig, "utf8")); local.instructed = { mode: "off" }; writeFileSync(localConfig, JSON.stringify(local));
      await Bun.sleep(5);
      const disabled = await tools.request({ t: "instruction_execute", session }, 35_000);
      expect(disabled.ok).toBe(false); expect(disabled.error).toContain("instructed.mode is off");
      expect(disabled.error).toContain("ahub settings set instructed.mode exact"); expect(disabled.error).not.toContain(offArgs);
      local.instructed.mode = "exact"; writeFileSync(localConfig, JSON.stringify(local));
      // An agent's direct file edit cannot re-enable a mode the person disabled.
      expect((await tools.request({ t: "instruction_execute", session }, 35_000)).ok).toBe(false);
      const reenable = await ControlClient.connect(stateDir, { role: "console" });
      try {
        expect((await reenable.request({ t: "settings_set", key: "instructed.mode", value: "exact" })).ok).toBe(true);
        local.instructed.mode = "off"; writeFileSync(localConfig, JSON.stringify(local));
        const view = await reenable.request({ t: "settings_get" });
        expect(view.rows.find((row: { key: string }) => row.key === "instructed.mode").value).toBe("exact");
      } finally { reenable.close(); }
      captured!.setMode("intent");
      const intentBoard = new Board(join(stateDir, "hub.db"));
      const intentTask = intentBoard.propose("user", { title: "intent fixture", class: "implement", plan: { claims: ["fixture claim"] } });
      intentBoard.update(intentTask.id, "claude", "declined", {}); intentBoard.close();
      const exactPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52115", exactArgs = `run task assign ${intentTask.id} claude`, exactAt = Date.now();
      expect(captured!.pending({ session, promptId: exactPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(exactArgs) }, exactAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52116", sessionId: session, promptId: exactPrompt, version: "2.1.329", timestamp: new Date(exactAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${exactArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session, argv: ["capabilities"] }, 35_000)).ok).toBe(false);
      const intentPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52109", intentArgs = `please assign task ${intentTask.id} to claude and mark claim 1 supported`, intentAt = Date.now();
      expect(captured!.pending({ session, promptId: intentPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(intentArgs) }, intentAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52110", sessionId: session, promptId: intentPrompt, version: "2.1.329", timestamp: new Date(intentAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${intentArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session, argv: ["task", "assign", String(intentTask.id), "claude"] }, 35_000)).ok).toBe(true);
      const wrongVerdict = await tools.request({ t: "instruction_execute", session, argv: ["review", "999999", "approved"] }, 35_000);
      expect(wrongVerdict.ok).toBe(false); expect(wrongVerdict.error).toContain("not written");
      const wrongSlot = await tools.request({ t: "instruction_execute", session, argv: ["task", "claim", String(intentTask.id), "2", "supported"] }, 35_000);
      expect(wrongSlot.ok).toBe(false); expect(wrongSlot.error).toContain("not written");
      const freeText = await tools.request({ t: "instruction_execute", session, argv: ["review", String(intentTask.id), "approved", "a note"] }, 35_000);
      expect(freeText.ok).toBe(false); expect(freeText.error).toContain("free text");
      expect((await tools.request({ t: "instruction_execute", session, argv: ["task", "claim", String(intentTask.id), "1", "supported"] }, 35_000)).ok).toBe(true);
      expect((await tools.request({ t: "instruction_execute", session, argv: ["capabilities"] }, 35_000)).ok).toBe(true);
      expect((await tools.request({ t: "instruction_execute", session, argv: ["settings", "set", "tasks.auto_pull", "false"] }, 35_000)).ok).toBe(false);
      const intentRead = new Board(join(stateDir, "hub.db"));
      try {
        expect(intentRead.get(intentTask.id)!.history.findLast(entry => entry.event === "reassigned")).toMatchObject({ by: "user", instructed: true, instructedPeer: "claude" });
        expect(intentRead.get(intentTask.id)!.history.findLast(entry => entry.event === "claim verdict")).toMatchObject({ by: "user", instructed: true, instructedPeer: "claude", claim: { slot: 1, verdict: "supported" } });
        intentRead.update(intentTask.id, "user", "fixture accepted", { state: "in_progress", reviewer: "user" });
        intentRead.update(intentTask.id, "claude", "fixture done", { state: "in_review" });
      } finally { intentRead.close(); }
      const verdictPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52111", verdictArgs = `please approve task ${intentTask.id}`, verdictAt = Date.now();
      expect(captured!.pending({ session, promptId: verdictPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(verdictArgs) }, verdictAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52112", sessionId: session, promptId: verdictPrompt, version: "2.1.329", timestamp: new Date(verdictAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${verdictArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      const verdict = await tools.request({ t: "instruction_execute", session, argv: ["review", String(intentTask.id), "approved"] }, 35_000);
      expect(verdict).toMatchObject({ ok: true, exitCode: 0 });
      const verdictBoard = new Board(join(stateDir, "hub.db"));
      try { expect(verdictBoard.get(intentTask.id)!.history.findLast(entry => entry.event === "approved")).toMatchObject({ by: "user", event: "approved", instructed: true, instructedPeer: "claude" }); } finally { verdictBoard.close(); }
      for (const prompt of [intentArgs, verdictArgs]) {
        expect(readFileSync(join(stateDir, "events.jsonl"), "utf8")).not.toContain(prompt);
        expect(readFileSync(join(stateDir, "hub.log"), "utf8")).not.toContain(prompt);
        expect(JSON.stringify(await tools.request({ t: "status" }))).not.toContain(prompt);
        expect(JSON.stringify(pushes)).not.toContain(prompt);
        expect(JSON.stringify(worker.calls)).not.toContain(prompt);
      }
      captured!.setMode("exact");
      const manifestPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52121", manifestArgs = `run task claim ${intentTask.id} 1 unsupported --manifest input.json --disposition resolved`, manifestAt = Date.now();
      expect(captured!.pending({ session, promptId: manifestPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(manifestArgs) }, manifestAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52122", sessionId: session, promptId: manifestPrompt, version: "2.1.329", timestamp: new Date(manifestAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${manifestArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session }, 35_000)).ok).toBe(false);
      const claimPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52117", claimArgs = `run task claim ${intentTask.id} 1 unsupported`, claimAt = Date.now();
      expect(captured!.pending({ session, promptId: claimPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(claimArgs) }, claimAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52118", sessionId: session, promptId: claimPrompt, version: "2.1.329", timestamp: new Date(claimAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${claimArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session, argv: ["task", "claim", String(intentTask.id), "1", "supported"] }, 35_000)).ok).toBe(false);
      expect((await tools.request({ t: "instruction_execute", session }, 35_000))).toMatchObject({ ok: true, exitCode: 0 });
      expect((await tools.request({ t: "instruction_execute", session }, 35_000)).ok).toBe(false);
      const claimBoard = new Board(join(stateDir, "hub.db"));
      try {
        const claims = claimBoard.get(intentTask.id)!.history.filter(entry => entry.event === "claim verdict");
        expect(claims).toHaveLength(2); expect(claims.at(-1)).toMatchObject({ by: "user", instructed: true, instructedPeer: "claude", claim: { slot: 1, verdict: "unsupported" } });
      } finally { claimBoard.close(); }
      expect(readFileSync(join(stateDir, "events.jsonl"), "utf8")).not.toContain(claimArgs);
      const read = new Board(join(stateDir, "hub.db"));
      let privateId: number;
      try {
        const saved = read.get(task.id)!; expect(saved.owner).toBe("claude"); expect(saved.history.at(-1)).toMatchObject({ by: "user", instructed: true, instructedPeer: "claude" });
        privateId = read.propose("user", { title: "private fixture", class: "implement", signals: ["pii"], plan: { claims: ["private claim"] } }).id;
      } finally { read.close(); }
      captured!.setMode("intent");
      const privateIntentPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52113", privateIntent = `please assign task ${privateId}`, privateIntentAt = Date.now();
      expect(captured!.pending({ session, promptId: privateIntentPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(privateIntent) }, privateIntentAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52114", sessionId: session, promptId: privateIntentPrompt, version: "2.1.329", timestamp: new Date(privateIntentAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${privateIntent}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      const privateIntentResult = await tools.request({ t: "instruction_execute", session, argv: ["task", "assign", String(privateId), "claude"] }, 35_000);
      expect(privateIntentResult.ok).toBe(false); expect(privateIntentResult.error).toContain("private work");
      captured!.setMode("exact");
      const privateClaimPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52119", privateClaim = `run task claim ${privateId} 1 supported`, privateClaimAt = Date.now();
      expect(captured!.pending({ session, promptId: privateClaimPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(privateClaim) }, privateClaimAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52120", sessionId: session, promptId: privateClaimPrompt, version: "2.1.329", timestamp: new Date(privateClaimAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${privateClaim}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      const privateClaimResult = await tools.request({ t: "instruction_execute", session }, 35_000);
      expect(privateClaimResult.ok).toBe(false); expect(privateClaimResult.error).toContain("private work");
      const privateClaimBoard = new Board(join(stateDir, "hub.db"));
      try { expect(privateClaimBoard.get(privateId)!.history.some(entry => entry.event === "claim verdict")).toBe(false); } finally { privateClaimBoard.close(); }
      const privatePrompt = "3004bef3-8884-4e54-bbf2-c5c760a52093", privateArgs = `run task assign ${privateId} claude`, privateAt = Date.now();
      expect(captured!.pending({ session, promptId: privatePrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(privateArgs) }, privateAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52094", sessionId: session, promptId: privatePrompt, version: "2.1.329", timestamp: new Date(privateAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${privateArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session }, 35_000)).ok).toBe(false);
      const after = new Board(join(stateDir, "hub.db"));
      let publicId: number;
      try {
        expect(after.get(privateId)!.owner).toBeNull();
        after.update(privateId, "user", "assigned", { owner: "claude" });
        publicId = after.propose("user", { title: "public while private", class: "implement" }).id;
      } finally { after.close(); }
      const privateTurnPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52101", privateTurnArgs = `run task assign ${publicId} claude`, privateTurnAt = Date.now();
      expect(captured!.pending({ session, promptId: privateTurnPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(privateTurnArgs) }, privateTurnAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52102", sessionId: session, promptId: privateTurnPrompt, version: "2.1.329", timestamp: new Date(privateTurnAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${privateTurnArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session }, 35_000)).ok).toBe(false);
      const privateCheck = new Board(join(stateDir, "hub.db"));
      try { expect(privateCheck.get(publicId)!.owner).toBeNull(); } finally { privateCheck.close(); }
    } finally { tools.close(); native.close(); }
  } finally {
    await daemon?.stop(); worker.stop(); keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);


test("control client handshakes and exchanges a request over inherited Bun IPC", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ahub-ipc-control-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ controlPort: 12345, protocol: 17, protocolMin: 16, protocolMax: 17 }));
    writeFileSync(join(dir, "control-token"), "test-only");
    const module = import.meta.resolve("../src/hub/control-client.ts");
    const code = `const W=globalThis.WebSocket; globalThis.WebSocket=class extends W { constructor(){throw Error("unexpected websocket")} }; const {ControlClient}=await import(${JSON.stringify(module)}); const c=await ControlClient.connect(${JSON.stringify(dir)}, {role:"console"}); const result=await c.request({t:"probe"}); if(!result.ok) process.exit(2); c.close(); try { await ControlClient.connect(${JSON.stringify(dir)}, {role:"console"}); process.exit(3); } catch { process.exit(0); }`;
    const kinds: string[] = [];
    const child = Bun.spawn({ cmd: [process.execPath, "-e", code], env: { ...process.env, AGENTHUB_INSTRUCTED_IPC: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", serialization: "json", ipc(message, process) {
      kinds.push(message.t);
      process.send(message.t === "hello" ? { t: "welcome", ok: true, rid: message.rid, protocol: 17 } : { ok: message.t === "probe", rid: message.rid });
    } });
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exit, error, kinds }).toEqual({ exit: 0, error: "", kinds: ["hello", "probe"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("instructed mode is machine-local and cannot be changed by a tools CLI", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { loadConfig } = await import("../src/hub/daemon.ts");
  const { validateRawConfig } = await import("../src/hub/config-apply.ts");
  const { classifyPeerCommand } = await import("../src/cli/identity.ts");
  const root = mkdtempSync(join(tmpdir(), "ahub-exact-config-"));
  try {
    expect(spawnSync("git", ["init", "-q", root], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).status).toBe(0);
    mkdirSync(join(root, ".agenthub"));
    writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ instructed: { mode: "off" } }));
    expect(spawnSync("git", ["-C", root, "add", "-f", ".agenthub/config.json"]).status).toBe(0);
    expect(loadConfig(root).instructed?.mode).toBe("intent");
    writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ instructed: { mode: "off" } }));
    expect(loadConfig(root).instructed?.mode).toBe("off");
    expect(() => validateRawConfig({ instructed: { mode: "off" } })).not.toThrow();
    expect(() => validateRawConfig({ instructed: { mode: "intent" } })).not.toThrow();
    expect(() => validateRawConfig({ instructed: { mode: "unknown" } })).toThrow();
    expect(classifyPeerCommand("settings", ["set", "instructed.mode", "exact"])).toBe("console");
    expect(classifyPeerCommand("instructed", ["run"])).toBe("allowed");
    const { InstructionReceipts } = await import("../src/hub/instruction-receipt.ts");
    const witnessFile = join(root, "witness.db");
    const witness = new InstructionReceipts(witnessFile, async () => undefined);
    expect(witness.mode()).toBe("intent"); witness.setMode("off"); witness.close();
    const restarted = new InstructionReceipts(witnessFile, async () => undefined);
    try { expect(restarted.mode()).toBe("off"); restarted.seedMode(() => { throw new Error("display must not be read"); }); restarted.setMode("exact"); expect(restarted.mode()).toBe("exact"); } finally { restarted.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an instructed CLI bootstrap refuses WebSocket construction", async () => {
  const { mkdtempSync, copyFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "ahub-exact-bootstrap-"));
  try {
    copyFileSync(join(import.meta.dir, "../src/cli/main.js"), join(root, "main.js"));
    writeFileSync(join(root, "main.ts"), 'try { new WebSocket("ws://127.0.0.1:1"); console.log("opened"); } catch { console.log("blocked"); }');
    const child = Bun.spawn([process.execPath, join(root, "main.js"), "version"], { env: { ...process.env, AGENTHUB_INSTRUCTED_IPC: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect({ code, output: output.trim() }).toEqual({ code: 0, output: "blocked" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the exact spending-setting arity matches the real CLI parser", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { exactForm } = await import("../src/hub/instructed-exact.ts");
  const cwd = mkdtempSync(join(tmpdir(), "ahub-exact-arity-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(AGENTHUB_|CLAUDE|CODEX_|ORCA_|KIMI|QWEN|JCODE|PI_|OMNIROUTE|CI$)/.test(key)) env[key] = value;
  Object.assign(env, { HOME: cwd, AGENTHUB_HOME: join(cwd, "hub"), AMEM_HOME: join(cwd, "memory"), CLAUDE_CONFIG_DIR: join(cwd, "claude"), GIT_CONFIG_GLOBAL: "/dev/null" });
  try {
    for (const [argv, valid] of [
      [["settings", "set", "tasks.auto_pull", "true"], true],
      [["settings", "set", "tasks.auto_pull", "true", "--yes"], true],
      [["settings", "set", "tasks.auto_pull"], false],
      [["settings", "set", "tasks.auto_pull", "true", "extra"], false],
    ] as const) {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).not.toBe(0);
      expect(!!exactForm(argv)).toBe(valid);
      expect(error).toContain(valid ? "no hub running" : "usage: ahub settings");
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("the person-disabled mode witness survives a daemon restart and a file edit", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { realPath } = await import("../src/hub/project.ts");
  const { startDaemon } = await import("../src/hub/daemon.ts");
  const { ControlClient, stateDirFor } = await import("../src/hub/control-client.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-mode-restart-"))), cwd = join(root, "project"), home = join(root, "home"); mkdirSync(cwd); mkdirSync(home); mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, task_sweep: { enabled: false } }));
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME"] as const, previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "mem") });
  const stateDir = stateDirFor(cwd); let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ instructed: { mode: "off" } }));
    daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false });
    let consoleClient = await ControlClient.connect(stateDir, { role: "console" });
    const initial = await consoleClient.request({ t: "settings_get" });
    expect(initial.rows.find((row: { key: string }) => row.key === "instructed.mode").value).toBe("off");
    writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ instructed: { mode: "exact" } }));
    expect((await consoleClient.request({ t: "settings_get" })).rows.find((row: { key: string }) => row.key === "instructed.mode").value).toBe("off");
    expect((await consoleClient.request({ t: "settings_set", key: "instructed.mode", value: "exact" })).ok).toBe(true);
    expect((await consoleClient.request({ t: "settings_set", key: "instructed.mode", value: "intent" })).ok).toBe(true);
    const oldIntent = consoleClient.features.filter(feature => feature !== "instructed_intent");
    const intentRecovery = await consoleClient.request({ t: "recovery", op: "prepare", expectedInstanceId: consoleClient.instanceId, operationId: "intent-witness-floor", targetFeatures: oldIntent });
    expect(intentRecovery.ok).toBe(false); expect(intentRecovery.error).toContain("target lacks instructed_intent");
    const localPath = join(cwd, ".agenthub/config.local.json");
    writeFileSync(localPath, "{");
    const failedOff = await consoleClient.request({ t: "settings_set", key: "instructed.mode", value: "off" });
    expect(failedOff.ok).toBe(false); expect(failedOff.error).toContain("witness is off");
    const failedExact = await consoleClient.request({ t: "settings_set", key: "instructed.mode", value: "exact" });
    expect(failedExact.ok).toBe(false); expect(failedExact.error).toContain("witness unchanged");
    writeFileSync(localPath, JSON.stringify({ instructed: { mode: "intent" } }));
    const rawRecovery = await consoleClient.request({ t: "recovery", op: "prepare", expectedInstanceId: consoleClient.instanceId, operationId: "intent-raw-floor", targetFeatures: oldIntent });
    expect(rawRecovery.ok).toBe(false); expect(rawRecovery.error).toContain("target lacks instructed_intent");
    writeFileSync(localPath, JSON.stringify({ instructed: { mode: "exact" } }));
    const older = consoleClient.features.filter(feature => feature !== "instructed_exact");
    const recovery = await consoleClient.request({ t: "recovery", op: "prepare", expectedInstanceId: consoleClient.instanceId, operationId: "mode-witness-floor", targetFeatures: older });
    expect(recovery.ok).toBe(false); expect(recovery.error).toContain("target lacks instructed_exact");
    consoleClient.close(); await daemon.stop(); daemon = undefined;
    writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ instructed: { mode: "exact" } }));
    daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false });
    consoleClient = await ControlClient.connect(stateDir, { role: "console" });
    try {
      const view = await consoleClient.request({ t: "settings_get" });
      expect(view.rows.find((row: { key: string }) => row.key === "instructed.mode").value).toBe("off");
    } finally { consoleClient.close(); }
  } finally {
    await daemon?.stop(); keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("implicit intent allows recovery to an older target with a narrower exact default", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { realPath } = await import("../src/hub/project.ts"), { startDaemon } = await import("../src/hub/daemon.ts");
  const { ControlClient, stateDirFor } = await import("../src/hub/control-client.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-intent-recovery-"))), cwd = join(root, "project"), home = join(root, "home"); mkdirSync(cwd); mkdirSync(home); mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, task_sweep: { enabled: false } }));
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME"] as const, previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "mem") });
  const stateDir = stateDirFor(cwd); let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false });
    const client = await ControlClient.connect(stateDir, { role: "console" });
    try {
      const view = await client.request({ t: "settings_get" });
      expect(view.rows.find((row: { key: string }) => row.key === "instructed.mode").value).toBe("intent");
      const targetFeatures = client.features.filter(feature => feature !== "instructed_intent");
      const result = await client.request({ t: "recovery", op: "prepare", expectedInstanceId: client.instanceId, operationId: "implicit-intent-recovery", targetFeatures });
      expect(result.ok).toBe(true);
      expect((await client.request({ t: "recovery", op: "abort", expectedInstanceId: client.instanceId, operationId: "implicit-intent-recovery" })).ok).toBe(true);
    } finally { client.close(); }
  } finally {
    await daemon?.stop(); keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a lost witness seeds off or exact from the display but leaves intent and absence implicit", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { Database } = await import("bun:sqlite"), { realPath } = await import("../src/hub/project.ts");
  const { startDaemon } = await import("../src/hub/daemon.ts"), { ControlClient, stateDirFor } = await import("../src/hub/control-client.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-intent-seed-"))), home = join(root, "home"); mkdirSync(home);
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME"] as const, previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "mem") });
  try {
    for (const [name, display, expected] of [["absent", undefined, undefined], ["intent", "intent", undefined], ["exact", "exact", "exact"], ["off", "off", "off"]] as const) {
      const cwd = join(root, name); mkdirSync(cwd); mkdirSync(join(cwd, ".agenthub"));
      writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, task_sweep: { enabled: false } }));
      if (display !== undefined) writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ instructed: { mode: display } }));
      const stateDir = stateDirFor(cwd), daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false });
      try {
        const client = await ControlClient.connect(stateDir, { role: "console" });
        try {
          const view = await client.request({ t: "settings_get" });
          expect(view.rows.find((row: { key: string }) => row.key === "instructed.mode").value).toBe(expected ?? "intent");
        } finally { client.close(); }
        const db = new Database(join(stateDir, "hub.db"), { readonly: true });
        try { expect((db.query("SELECT mode FROM instructed_mode WHERE id = 1").get() as { mode: string } | null)?.mode).toBe(expected); } finally { db.close(); }
      } finally { await daemon.stop(); }
    }
  } finally {
    keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
