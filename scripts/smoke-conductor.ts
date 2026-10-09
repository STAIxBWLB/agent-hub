/** Real native TUI smoke for #194/#195, using Python's standard-library PTY.
 * Continuation: bun scripts/smoke-conductor.ts --resume-fixture <existing-fixture> --model <verified-account-model> --operator-file-input --run
 * Continuation preserves the existing configuration, tasks and journal, with no new tasks or writes.
 * Preparation: bun scripts/smoke-conductor.ts --config <non-secret-config.json> --root <scratch-directory> [--model <verified-account-model>]
 * Live, after resource admission: append --run; add --operator-file-input for a background outer harness. One fixture per Claude/Codex x off/own leg, executed serially.
 * The operator's stdin is forwarded to the actual ahub console. Approvals are never automated.
 * For native onboarding, append JSON string lines to the named .input.jsonl file; each line is actual PTY input.
 * Keep terminal transcripts private; only summary/report metadata is suitable for sharing.
 * This script records incomplete legs honestly and leaves private evidence for investigation.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { ControlClient, stateDirFor } from "../src/hub/control-client.ts";
import { readEvents, type StampedEvent } from "../src/hub/events.ts";
import { summarize, type Report } from "../src/hub/report.ts";
import { terminalText } from "../src/cli/console-state.ts";
import { realPath } from "../src/hub/project.ts";
import { readClaudeTranscriptUsage } from "../src/hub/usage.ts";

const flags = process.argv.slice(2);
function option(name: string): string | undefined { const at = flags.indexOf(name); if (at < 0) return undefined; const value = flags[at + 1]; if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`); return value; }
const resumeFixture = option("--resume-fixture") ? resolve(option("--resume-fixture")!) : undefined;
const sourceConfig = resumeFixture ? join(resumeFixture, ".agenthub", "config.json") : option("--config");
const scratch = option("--root") ?? (resumeFixture ? dirname(resumeFixture) : undefined);
if (!sourceConfig || !scratch) throw new Error("usage: bun scripts/smoke-conductor.ts --config <non-secret-config.json> --root <scratch-directory> [--model <verified-account-model>] [--run] [--operator-file-input]");
const model = option("--model"); const live = flags.includes("--run");
const fileInput = flags.includes("--operator-file-input");
const timeoutSeconds = Number(option("--timeout-s") ?? 1800);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 1800) throw new Error("--timeout-s must be 60..1800");
const selected = option("--peer"); if (selected && selected !== "claude" && selected !== "codex") throw new Error("--peer must be claude or codex");
const requestedFeed = option("--feed"); if (requestedFeed && requestedFeed !== "off" && requestedFeed !== "own") throw new Error("--feed must be off or own");
const entry = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const bundle = fileURLToPath(new URL("../plugins/agent-hub/server.js", import.meta.url));
const fixtureRoot = resolve(scratch); mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
const runRoot = mkdtempSync(join(fixtureRoot, resumeFixture ? "native-conductor-continuation-" : "native-conductor-")); chmodSync(runRoot, 0o700);
const baseConfig = JSON.parse(readFileSync(resolve(sourceConfig), "utf8"));
if (!baseConfig || typeof baseConfig !== "object" || Array.isArray(baseConfig)) throw new Error("config must be an object");
// The caller supplies routing/account settings, never auth material. Reject common literal secret fields.
function inspectSecrets(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(api[_-]?key|token|password|secret|authorization|access[_-]?key)$/i.test(key) && child) throw new Error("smoke configuration must use credential references, not literal secrets");
    inspectSecrets(child);
  }
}
inspectSecrets(baseConfig);
const env: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color" };
// These are this harness's children, representing the operator, not inherited agent shells.
for (const key of ["AGENTHUB_PEER_ID", "AGENTHUB_MODE", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete env[key];
// These private PTYs are not the caller's Orca terminal/worktree. Keep account
// configuration, but do not claim that terminal's recovery or hook ownership.
for (const key of Object.keys(env)) if (key.startsWith("ORCA_")) delete env[key];
const ptyScript = join(runRoot, "native-pty.py");
writeFileSync(ptyScript, String.raw`import os, pty, select, signal, struct, sys, termios, fcntl
pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
def stop(signum, frame):
    # The forked child owns a new session/group; never target any unrelated process.
    try: os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    raise SystemExit(128 + signum)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
stdin_open = True
try:
    while True:
        watch = [master] + ([sys.stdin.fileno()] if stdin_open else [])
        ready, _, _ = select.select(watch, [], [], 1)
        if master in ready:
            try: data = os.read(master, 65536)
            except OSError: break
            if not data: break
            os.write(sys.stdout.fileno(), data)
            # Native terminal capability queries need actual responses, not fake model output.
            if b"\x1b[6n" in data: os.write(master, b"\x1b[1;1R")
            if b"\x1b[c" in data or b"\x1b[0c" in data: os.write(master, b"\x1b[?1;2c")
            if b"\x1b[>c" in data: os.write(master, b"\x1b[>0;0;0c")
        if stdin_open and sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if data: os.write(master, data)
            else: stdin_open = False
finally:
    os.close(master)
    _, status = os.waitpid(pid, 0)
    raise SystemExit(os.waitstatus_to_exitcode(status))
`, { mode: 0o600 });
interface NativePty {
  input(text: string): void; close(): Promise<void>; pid: number;
}
function nativePty(argv: string[], cwd: string, name: string): NativePty {
  const outputPath = join(runRoot, `${name}.terminal.txt`);
  writeFileSync(outputPath, "", { mode: 0o600 });
  const inputPath = join(runRoot, `${name}.input.jsonl`); writeFileSync(inputPath, "", { mode: 0o600 });
  let inputOffset = 0;
  const child = Bun.spawn(["python3", ptyScript, ...argv], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pump = async (source: ReadableStream<Uint8Array>) => {
    const reader = source.getReader(); const decoder = new TextDecoder();
    try { while (true) { const { done, value } = await reader.read(); if (done) break; appendFileSync(outputPath, terminalText(decoder.decode(value, { stream: true }))); } }
    finally { reader.releaseLock(); }
  };
  const pumping = Promise.all([pump(child.stdout), pump(child.stderr)]);
  const inputTimer = setInterval(() => {
    const content = readFileSync(inputPath, "utf8");
    const end = content.lastIndexOf("\n") + 1;
    if (end <= inputOffset) return;
    for (const line of content.slice(inputOffset, end).split("\n")) {
      if (!line.trim()) continue;
      try { const text = JSON.parse(line); if (typeof text === "string") { child.stdin.write(text); void child.stdin.flush(); } } catch { /* leave malformed input inert */ }
    }
    inputOffset = end;
  }, 250);
  return { pid: child.pid, input: text => { child.stdin.write(text); void child.stdin.flush(); }, close: async () => {
    clearInterval(inputTimer); child.kill("SIGTERM");
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!exited) throw new Error(`owned PTY ${name} failed to terminate; do not start another leg`);
    await pumping;
  } };
}
async function command(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(terminalText(err || out).slice(0, 1000));
  return out;
}
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
async function until<T>(read: () => Promise<T | undefined>, label: string, seconds = timeoutSeconds): Promise<T> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { if (interrupted) throw new Error("operator interrupted native smoke"); const result = await read(); if (result !== undefined) return result; await Bun.sleep(1000); }
  throw new Error(`timeout waiting for ${label}`);
}
const markerProbe = "python3 -c 'import os,json; print(\"AHUB_NATIVE_MARKERS \"+json.dumps({k:(k in os.environ) for k in [\"AGENTHUB_PEER_ID\",\"CLAUDECODE\",\"CLAUDE_CODE_SESSION_ID\",\"CODEX_THREAD_ID\"]},sort_keys=True))'";
writeFileSync(join(runRoot, "claude-t0-inputs.txt"), `Native ! input (submit in actual Claude TUI):\n!${markerProbe}\n\nModel shell-tool request (independent evidence):\nExecute exactly this command once through the native shell tool, then report its verbatim boolean output: ${markerProbe}\n\nPlain-channel test: launch plain claude with candidate-mcp.json but without --dangerously-load-development-channels. Call hub_status once, then send a unique hub message from the operator and observe actual native turn completion/receipt. Compare with ahub claude; tool success alone is not push evidence.\n`, { mode: 0o600 });
const versions: Record<string, string> = {};
for (const peer of ["claude", "codex"]) {
  try { versions[peer] = (await command([peer, "--version"], runRoot)).trim(); }
  catch { versions[peer] = "unavailable"; }
}
const manifest: any = { kind: "native-conductor-smoke", preparedAt: new Date().toISOString(), versions, requestedCodexModel: model ?? null,
  providerVerification: "not established by model cache or preparation", approvalMode: fileInput ? "manual chat-authorized file input to native console" : "manual native console stdin", operatorInputSource: fileInput ? "chat/file-input" : "foreground stdin", resumeFixture: resumeFixture ?? null, originalSummary: resumeFixture ? join(dirname(resumeFixture), "summary.json") : null, timeoutSeconds, runRoot, live, legs: [] };
function save() { writeFileSync(join(runRoot, "summary.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 }); }
/** Native completion is independent of the channel's idle state. Only the
 * current daemon's session and this fixture's own bounded transcript qualify. */
function claudeNative(stateDir: string, fixture: string, instanceId: string, sinceMs: number) {
  try {
    const session = JSON.parse(readFileSync(join(stateDir, "claude-session.json"), "utf8"));
    if (session.instanceId !== instanceId || typeof session.sessionId !== "string" || typeof session.transcriptPath !== "string") return undefined;
    const projects = realPath(join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"));
    const transcript = realPath(session.transcriptPath);
    const expected = join(projects, fixture.replace(/[^a-zA-Z0-9]/g, "-"), `${session.sessionId}.jsonl`);
    if (transcript !== realPath(expected) || basename(transcript) !== `${session.sessionId}.jsonl` || statSync(transcript).size > 32 * 1024 * 1024) return undefined;
    const rows: any[] = [];
    for (const line of readFileSync(transcript, "utf8").split("\n")) {
      try { const row = JSON.parse(line); if (row.sessionId === session.sessionId && (!row.cwd || realPath(row.cwd) === realPath(fixture))) rows.push(row); } catch { /* partial row is not completion */ }
    }
    const active = rows.filter(row => ["assistant", "user"].includes(row.type) && Date.parse(row.timestamp) >= sinceMs);
    const lastAssistant = active.filter(row => row.type === "assistant").at(-1);
    const endedAt = lastAssistant?.message?.stop_reason === "end_turn" ? Date.parse(lastAssistant.timestamp) : NaN;
    const lastActivity = Math.max(...active.map(row => Date.parse(row.timestamp)).filter(Number.isFinite));
    const durations = rows.filter(row => row.type === "system" && row.subtype === "turn_duration" && Date.parse(row.timestamp) >= sinceMs);
    const complete = Number.isFinite(endedAt) && lastActivity <= endedAt && durations.some(row => Date.parse(row.timestamp) >= endedAt);
    const usage = readClaudeTranscriptUsage(session.sessionId, transcript);
    const totals = usage.map(row => {
      const u = row.usage;
      if (!u) return undefined;
      if (u.totalTokens !== undefined) return u.totalTokens;
      const parts = [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens];
      return parts.every(n => n !== undefined) ? parts.reduce<number>((sum, n) => sum + n!, 0) : undefined;
    });
    const known = totals.filter((n): n is number => n !== undefined);
    return { complete, endedAt: Number.isFinite(endedAt) ? endedAt : null, completedTurns: durations.length,
      transcript, sessionId: session.sessionId, instanceId, usageRecords: usage.length, knownUsageRecords: known.length,
      tokens: known.length === usage.length && known.length ? known.reduce((sum, n) => sum + n, 0) : null };
  } catch { return undefined; }
}
/** Select one canonical measured source, never add rich usage to native counter increments. */
function measuredTokens(events: StampedEvent[], report: Report, peer: string) {
  const usage = report.usage.peers[peer];
  const increments = events.filter((event): event is Extract<StampedEvent, { type: "tokens" }> => event.type === "tokens" && event.peer === peer);
  const valid = increments.filter(event => Number.isSafeInteger(event.n) && event.n >= 0);
  const coverage = { nativeIncrementRecords: valid.length, invalidNativeIncrementRecords: increments.length - valid.length };
  if (usage && usage.records > 0 && usage.totalRecords === usage.records && usage.withoutUsage === 0) {
    return { tokens: usage.totalTokens, tokenSource: "rich-usage-total", ...coverage };
  }
  const total = report.peers[peer]?.tokens;
  if (valid.length > 0 && valid.length === increments.length && typeof total === "number" && Number.isSafeInteger(total) && total >= 0) {
    return { tokens: total, tokenSource: "native-token-increments", ...coverage };
  }
  return { tokens: null, tokenSource: null, ...coverage };
}
function scorePartial(leg: any, stateDir: string, peer: string, tasks?: any[]): void {
  const events = readEvents(join(stateDir, "events.jsonl")); const report = summarize(events);
  if (tasks) { leg.observedTasks = tasks.map(task => ({ id: task.id, owner: task.owner, reviewer: task.reviewer, state: task.state })); leg.completedTasks = tasks.filter(task => task.state === "approved").length; }
  else {
    const latest = new Map<number, string>();
    for (const event of events) if (event.type === "task") latest.set(event.id, event.state);
    leg.completedTasks = [...latest.values()].filter(state => state === "approved").length;
  }
  const approvals = events.filter(event => event.type === "permission" && event.event === "answered" && event.surface === "console");
  leg.consoleApprovals = approvals.length ? "observed in daemon audit" : "not established"; leg.consoleApprovalCount = approvals.length;
  leg.conductorTurns = peer === "claude" ? leg.nativeCompletion?.completedTurns ?? null : report.peers[peer]?.turns ?? null;
  const usage = report.usage.peers[peer]; const measured = measuredTokens(events, report, peer);
  leg.conductorTokens = peer === "claude" ? leg.nativeCompletion?.tokens ?? null : measured.tokens;
  leg.tokenSource = peer === "claude" ? leg.nativeCompletion ? "verified-native-transcript" : null : measured.tokenSource;
  leg.nativeIncrementRecords = measured.nativeIncrementRecords; leg.invalidNativeIncrementRecords = measured.invalidNativeIncrementRecords;
  leg.ownerUsage = Object.fromEntries(["local", "pi"].map(p => [p, { turns: report.peers[p]?.turns ?? null, ...measuredTokens(events, report, p) }]));
  leg.tokenCoverage = usage ? { records: usage.records, knownTotalRecords: usage.totalRecords, recordsWithUsage: usage.withUsage, recordsWithoutUsage: usage.withoutUsage } : null;
  leg.supervisionTurns = report.supervision[peer]?.turns ?? null; leg.supervisionTokens = report.supervision[peer]?.tokens ?? null;
  leg.turnsPerCompletedTask = leg.completedTasks && leg.conductorTurns !== null ? leg.conductorTurns / leg.completedTasks : null;
  leg.tokensPerCompletedTask = leg.completedTasks && leg.conductorTokens !== null ? leg.conductorTokens / leg.completedTasks : null;
  writeFileSync(join(runRoot, `${peer}-${leg.feed}-report.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}


const resumeConductor = resumeFixture ? Object.entries(baseConfig.roles ?? {}).find(([, roles]) => Array.isArray(roles) && roles.includes("conductor"))?.[0] : undefined;
if (resumeFixture && (!resumeConductor || (selected && selected !== resumeConductor) || (requestedFeed && requestedFeed !== baseConfig.conductor?.feed))) throw new Error("resume fixture role/feed must match its existing configuration");
const peerRuns = resumeFixture ? [resumeConductor!] : selected ? [selected] : ["claude", "codex"];
const feedRuns = resumeFixture ? [baseConfig.conductor?.feed ?? "own"] : requestedFeed ? [requestedFeed] : ["off", "own"];
const requestedLegs = peerRuns.flatMap(peer => feedRuns.map(feed => ({ peer, feed })));
manifest.requestedLegs = requestedLegs;
legs: for (const { peer, feed } of requestedLegs) {
  if (interrupted) break legs;
  const dir = resumeFixture ?? join(runRoot, `${peer}-${feed}`);
  if (!resumeFixture) {
    mkdirSync(join(dir, ".agenthub"), { recursive: true, mode: 0o700 });
  const config = { ...baseConfig, roles: { [peer]: ["conductor", "planner", "reviewer"], local: ["implementer"], pi: ["implementer"] },
    conductor: { feed, approval_wait_s: 5 }, pi: { ...baseConfig.pi, enabled: true, auto_start: false },
    memory: { ...baseConfig.memory, enabled: false }, task_sweep: { ...baseConfig.task_sweep, enabled: true, unaccepted_min: 60, idle_min: 60, review_min: 60 }, inference: { ...baseConfig.inference, enabled: false },
    mlx: { ...baseConfig.mlx, enabled: false }, approvals: { timeout_s: 300, notify: false }, snapshots: { enabled: false, keep: 1 }, recovery: { auto_resume_after_crash: false } };
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  const fixedModel = option("--local-model") ?? "vllm/deepseek-ai/DeepSeek-V4-Flash-0731";
  writeFileSync(join(dir, ".agenthub", "routing.toml"), `[local]\nfixed_model = ${JSON.stringify(fixedModel)}\n[classes.implement]\npeers = ["local", "pi"]\nlocal_allowed = true\npi_backend = "dgx"\n[classes.review]\npeers = ["${peer}"]\n`, { mode: 0o600 });
  writeFileSync(join(dir, "words.ts"), 'export const one = "one";\nexport const two = "two";\n');
  writeFileSync(join(dir, "AGENTS.md"), "# Disposable native smoke fixture\n\n- Work only in this directory; never read secrets or access external systems.\n- Two implementation tasks create alpha.txt and beta.txt with fixture text only.\n- Worker approval requests must be answered by the person in ahub console.\n- Use hub task accept and done; record actual checks. Do not implement another peer's assigned task.\n");
  await command(["git", "init", "--quiet", "--initial-branch=main"], dir);
  await command(["git", "config", "user.name", "Native smoke fixture"], dir);
  await command(["git", "config", "user.email", "smoke@example.invalid"], dir);
  await command(["git", "add", "AGENTS.md", "words.ts"], dir);
  await command(["git", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "chore: initialize disposable smoke fixture"], dir);
  if ((await command(["git", "remote"], dir)).trim()) throw new Error("smoke fixture unexpectedly has a remote");
  } else {
    if (!existsSync(join(dir, ".git")) || !existsSync(join(dir, "beta.txt"))) throw new Error("resume requires the existing git fixture and beta.txt");
    if ((await command(["git", "remote"], dir)).trim()) throw new Error("resume fixture must have no remotes");
  }
  const stateDir = stateDirFor(dir);
  const mcp = join(dir, ".agenthub", "candidate-mcp.json");
  if (!resumeFixture) writeFileSync(mcp, JSON.stringify({ mcpServers: { "agent-hub": { command: "bun", args: [bundle], env: { AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: dir, AGENTHUB_PEER_ID: peer } } } }, null, 2) + "\n", { mode: 0o600 });
  const prompt = resumeFixture ? `Continue the existing disposable native smoke, do not start a new round. Task #1 is already approved: leave its state and alpha.txt unchanged. Existing task #2 is in_progress, owner pi, reviewer ${peer}; beta.txt already contains BETA. Use hub_status and hub_task_show for task #2. Start headless pi with hub_peer_start if detached. If its queue has a needs_review hold, tell the person to inspect ahub queue show and decide ahub queue resolve; never resolve, retry, discard, or bypass the hold yourself. Once Pi is available, send only Pi a precise read-only continuation request: read existing beta.txt, verify exactly the 4 bytes BETA without writing any file, and call hub_task_done id 2 with the actual observed check (do not accept an already in_progress task). Do not create new tasks, write any files, reassign owners, or restart local. When native Pi marks task #2 done, independently inspect beta.txt and approve task #2 with hub_review only after its bytes match. Start every final response with [FYI]; never broadcast task instructions or answer approvals.` : `You are the conductor/reviewer for a disposable native smoke. Start local and headless pi with hub_peer_start. Do not hold peers before assigning: paused peers are unavailable to routing. Propose exactly two class implement tasks initially owned by local: task A must write alpha.txt containing exactly ALPHA then read it and call hub_task_done with the observed check; task B must write beta.txt containing exactly BETA then read it and call hub_task_done with the observed check. Give each task a precise path plan in refs/plan. Verify both returned owners are local; if assignment is unavailable, report it without creating duplicates. Reassign task B to pi with hub_task_assign while task A waits for human approval. After successful assignment, place and release your own holds on both peers to check the hold tools. Do not implement these tasks yourself. Never answer any permission request: tell the person to answer in ahub console. As reviewer, inspect the resulting files with Read and approve with hub_review only after their actual content matches. ${feed === "off" ? "The supervision feed is off; return after delegation and wait for a user review prompt." : "The own supervision feed is on; handle milestones without polling loops and report once both tasks are approved."} Create no additional tasks and never broadcast task instructions to owners. Start every final response with [FYI] so it stays in the console instead of causing duplicate owner turns. Use no network or unrelated files.`;
  writeFileSync(join(runRoot, `${peer}-${feed}-conductor-prompt.txt`), prompt + "\n", { mode: 0o600 });
  const leg: any = { peer, feed, fixture: dir, status: "prepared", nativeTuiTransport: "real PTY", nativeTuiLaunched: false, nativeConductorAttached: false, consolePtyLaunched: false, consoleApprovals: "not observed", completedTasks: 0, conductorTurns: null, conductorTokens: null, supervisionTurns: null, supervisionTokens: null, operatorInputSource: fileInput ? "chat/file-input" : "foreground stdin", terminalFiles: { conductor: join(runRoot, `${peer}-${feed}-tui.terminal.txt`), console: join(runRoot, `${peer}-${feed}-console.terminal.txt`) }, inputFiles: { conductor: join(runRoot, `${peer}-${feed}-tui.input.jsonl`), console: join(runRoot, `${peer}-${feed}-console.input.jsonl`) } };
  manifest.legs.push(leg); save();
  if (!live) continue;
  if (!process.stdin.isTTY && !fileInput) { leg.status = "blocked"; leg.reason = "live smoke requires foreground operator stdin or explicit --operator-file-input for manual console approvals"; save(); continue; }
  const previousRaw = process.stdin.isRaw;
  let hub: ControlClient | undefined; let tui: NativePty | undefined; let consolePty: NativePty | undefined; let input: ((data: Buffer) => void) | undefined;
  try {
    if (peer === "codex" && !model) throw new Error("pass --model only after verifying it with the installed account/provider; cached slugs do not establish access");
    await command([process.execPath, entry, "--project", dir, "up", "--no-console"], dir);
    if (interrupted) throw new Error("operator interrupted native smoke");
    hub = await ControlClient.connect(stateDir, { role: "console", projectRoot: dir });
    consolePty = nativePty([process.execPath, entry, "--project", dir, "console"], dir, `${peer}-${feed}-console`);
    leg.consolePtyLaunched = true; leg.status = "running"; save();
    // Read the native terminal transcript separately. stdin keys go directly to the genuine console process.
    if (!fileInput) {
      input = data => { if (data.includes(3)) interrupted = true; consolePty?.input(data.toString()); };
      process.stdin.setRawMode(true); process.stdin.on("data", input); process.stdin.resume();
    }
    console.log(`Native ${peer}/${feed}: operator keys reach ahub console via ${fileInput ? "chat-authorized .input.jsonl" : "foreground stdin"}. Terminal evidence: ${join(runRoot, `${peer}-${feed}-console.terminal.txt`)}`);
    const args = peer === "claude" ? ["--mcp-config", mcp, "--strict-mcp-config", "--allowedTools", "mcp__agent-hub__*", "Read", "--ax-screen-reader", prompt] : ["--model", model!, prompt];
    const nativeStartedMs = Date.now();
    tui = nativePty([process.execPath, entry, "--project", dir, peer, ...args], dir, `${peer}-${feed}-tui`);
    leg.nativeTuiLaunched = true; save();
    await until(async () => { const s = (await hub!.request({ t: "status" }, 3000)).status; return s?.peers?.[peer]?.attached !== false && ["idle", "busy"].includes(s?.peers?.[peer]?.state) ? true : undefined; }, "native conductor attachment", 120);
    leg.nativeConductorAttached = true; save();
    if (resumeFixture) {
      const listed = await hub.request({ t: "task", op: "hub_task_list", args: {} }, 3000);
      const existing = listed.ok ? JSON.parse(listed.text) : [];
      if (existing.length !== 2 || !existing.some((task: any) => task.id === 1 && task.state === "approved") || !existing.some((task: any) => task.id === 2 && task.owner === "pi")) throw new Error("resume fixture does not match the existing two-task contract");
    }
    let reviewPrompted = false;
    const completed = await until(async () => {
      const reply = await hub!.request({ t: "task", op: "hub_task_list", args: {} }, 3000);
      if (!reply.ok) return undefined;
      const tasks: any[] = JSON.parse(reply.text);
      scorePartial(leg, stateDir, peer, tasks);
      const queued = await hub!.request({ t: "queue", op: "list" }, 3000);
      if (queued.ok) leg.pendingQueue = queued.deliveries.filter((row: any) => row.state === "needs_review" || row.state === "queued").map((row: any) => ({ id: row.id, peer: row.peer, state: row.state, revision: row.revision, reason: row.reason ?? null }));
      save();
      if (feed === "off" && !reviewPrompted && tasks.length === 2 && tasks.every(t => ["in_review", "approved"].includes(t.state))) {
        reviewPrompted = true; tui!.input("Inspect alpha.txt and beta.txt using Read, then review both tasks with hub_review. Only approve actual matching contents.\r");
      }
      return tasks.length === 2 && tasks.every(t => t.state === "approved") ? tasks : undefined;
    }, "two reviewed tasks");
    if (!readFileSync(join(dir, "alpha.txt")).equals(Buffer.from("ALPHA")) || !readFileSync(join(dir, "beta.txt")).equals(Buffer.from("BETA"))) throw new Error("fixture output byte mismatch");
    await until(async () => {
      const status = (await hub!.request({ t: "status" }, 3000)).status;
      if (peer !== "claude") return status?.peers?.[peer]?.state === "idle" ? true : undefined;
      if (!status?.instanceId) return undefined;
      const native = claudeNative(stateDir, dir, status.instanceId, nativeStartedMs);
      const lastReview = Math.max(nativeStartedMs, ...readEvents(join(stateDir, "events.jsonl")).filter(e => e.type === "conduct" && e.peer === peer && e.action === "review").map(e => Date.parse(e.at)));
      if (!native?.complete || native.endedAt === null || native.endedAt < lastReview) return undefined;
      leg.nativeCompletion = native; save(); return true;
    }, "completed native conductor turn", 120);
    const histories = await Promise.all(completed.map(async t => JSON.parse((await hub!.request({ t: "task", op: "task_show", args: { id: t.id } }, 3000)).text)));
    const reassigned = histories.some(t => t.history.some((h: any) => h.by === peer && ["assigned", "reassigned"].includes(h.event) && h.owner === "pi"));
    const reviewed = histories.every(t => t.history.some((h: any) => h.by === peer && h.event === "approved"));
    const events = readEvents(join(stateDir, "events.jsonl")); const report = summarize(events);
    const started = ["local", "pi"].every(p => events.some(e => e.type === "conduct" && e.peer === peer && e.action === "peer_start" && e.target === p));
    const approvalConsole = events.some(e => e.type === "permission" && e.event === "answered" && e.surface === "console");
    leg.completedTasks = completed.length; leg.reassigned = reassigned; leg.reviewed = reviewed; leg.startedBothWorkers = started;
    leg.consoleApprovals = approvalConsole ? "observed in daemon audit" : "not established";
    leg.conductorTurns = peer === "claude" ? leg.nativeCompletion?.completedTurns ?? null : report.peers[peer]?.turns ?? null;
    const measured = measuredTokens(events, report, peer);
    leg.conductorTokens = peer === "claude" ? leg.nativeCompletion?.tokens ?? null : measured.tokens;
    leg.tokenSource = peer === "claude" ? leg.nativeCompletion ? "verified-native-transcript" : null : measured.tokenSource;
    leg.nativeIncrementRecords = measured.nativeIncrementRecords; leg.invalidNativeIncrementRecords = measured.invalidNativeIncrementRecords;
    leg.supervisionTurns = report.supervision[peer]?.turns ?? null; leg.supervisionTokens = report.supervision[peer]?.tokens ?? null;
    leg.turnsPerCompletedTask = leg.conductorTurns === null ? null : leg.conductorTurns / completed.length;
    leg.tokensPerCompletedTask = leg.conductorTokens === null ? null : leg.conductorTokens / completed.length;
    leg.ownerUsage = Object.fromEntries(["local", "pi"].map(p => [p, { turns: report.peers[p]?.turns ?? null, ...measuredTokens(events, report, p) }]));
    writeFileSync(join(runRoot, `${peer}-${feed}-report.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    leg.status = reassigned && reviewed && started && approvalConsole && leg.conductorTurns !== null && !leg.pendingQueue?.some((row: any) => row.state === "needs_review") ? "passed" : "incomplete";
  } catch (error) { scorePartial(leg, stateDir, peer); leg.status = "incomplete"; leg.reason = terminalText((error as Error).message).slice(0, 1000); }
  finally {
    if (input) {
      try { process.stdin.off("data", input); process.stdin.setRawMode(previousRaw); process.stdin.pause(); }
      catch (error) { leg.teardownError = terminalText((error as Error).message); }
    }
    // Only our PTY wrappers and the verified fixture daemon are stopped. No shared model/service shutdown.
    const stops = await Promise.allSettled([tui?.close(), consolePty?.close()]);
    const failures = stops.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) leg.teardownError = [leg.teardownError, ...failures.map(result => terminalText(String(result.reason)))].filter(Boolean).join("; ");
    try { hub?.close(); } catch (error) { leg.teardownError = [leg.teardownError, terminalText((error as Error).message)].filter(Boolean).join("; "); }
    try { await command([process.execPath, entry, "--project", dir, "kill"], dir); } catch (error) { leg.teardownError = [leg.teardownError, terminalText((error as Error).message)].filter(Boolean).join("; "); }
    if (leg.teardownError) leg.status = "incomplete";
    scorePartial(leg, stateDir, peer); save();
  }
  if (interrupted || leg.teardownError) break legs;
}
const skippedLegs = requestedLegs.filter(requested => !manifest.legs.some((leg: any) => leg.peer === requested.peer && leg.feed === requested.feed && leg.nativeTuiLaunched));
const allRequestedLegsRan = skippedLegs.length === 0;
const passed = live && !interrupted && allRequestedLegsRan && manifest.legs.length === requestedLegs.length && manifest.legs.every((leg: any) => leg.status === "passed" && !leg.teardownError);
manifest.interrupted = interrupted; manifest.allRequestedLegsRan = allRequestedLegsRan; manifest.skippedLegs = skippedLegs; manifest.passed = passed;
save();
process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
console.log(JSON.stringify({ summary: join(runRoot, "summary.json"), live, passed, interrupted, allRequestedLegsRan, skippedLegs, legs: manifest.legs.map((leg: any) => ({ peer: leg.peer, feed: leg.feed, status: leg.status, ...(leg.teardownError ? { teardownError: leg.teardownError } : {}) })) }));
if (live && !passed) process.exitCode = 1;
