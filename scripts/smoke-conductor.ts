/** Real native TUI smoke for #194/#195, using Python's standard-library PTY.
 * Preparation: bun scripts/smoke-conductor.ts --config <non-secret-config.json> --root <scratch-directory> [--model <verified-account-model>]
 * Live, after resource admission: append --run. One fixture per Claude/Codex x off/own leg, executed serially.
 * The operator's stdin is forwarded to the actual ahub console. Approvals are never automated.
 * For native onboarding, append JSON string lines to the named .input.jsonl file; each line is actual PTY input.
 * Keep terminal transcripts private; only summary/report metadata is suitable for sharing.
 * This script records incomplete legs honestly and leaves private evidence for investigation.
 */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient, stateDirFor } from "../src/hub/control-client.ts";
import { readEvents } from "../src/hub/events.ts";
import { summarize } from "../src/hub/report.ts";
import { terminalText } from "../src/cli/console-state.ts";

const flags = process.argv.slice(2);
function option(name: string): string | undefined { const at = flags.indexOf(name); if (at < 0) return undefined; const value = flags[at + 1]; if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`); return value; }
const sourceConfig = option("--config"); const scratch = option("--root");
if (!sourceConfig || !scratch) throw new Error("usage: bun scripts/smoke-conductor.ts --config <non-secret-config.json> --root <scratch-directory> [--model <verified-account-model>] [--run]");
const model = option("--model"); const live = flags.includes("--run");
const timeoutSeconds = Number(option("--timeout-s") ?? 600);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 1800) throw new Error("--timeout-s must be 60..1800");
const selected = option("--peer"); if (selected && selected !== "claude" && selected !== "codex") throw new Error("--peer must be claude or codex");
const requestedFeed = option("--feed"); if (requestedFeed && requestedFeed !== "off" && requestedFeed !== "own") throw new Error("--feed must be off or own");
const entry = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const bundle = fileURLToPath(new URL("../plugins/agent-hub/server.js", import.meta.url));
const fixtureRoot = resolve(scratch); mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
const runRoot = mkdtempSync(join(fixtureRoot, "native-conductor-")); chmodSync(runRoot, 0o700);
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
  const outputPath = join(dirname(cwd), `${name}.terminal.txt`);
  writeFileSync(outputPath, "", { mode: 0o600 });
  const inputPath = join(dirname(cwd), `${name}.input.jsonl`); writeFileSync(inputPath, "", { mode: 0o600 });
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
  providerVerification: "not established by model cache or preparation", approvalMode: "manual native console input", runRoot, live, legs: [] };
function save() { writeFileSync(join(runRoot, "summary.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 }); }

for (const peer of selected ? [selected] : ["claude", "codex"]) for (const feed of requestedFeed ? [requestedFeed] : ["off", "own"]) {
  const dir = join(runRoot, `${peer}-${feed}`); mkdirSync(join(dir, ".agenthub"), { recursive: true, mode: 0o700 });
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
  const stateDir = stateDirFor(dir);
  const mcp = join(dir, ".agenthub", "candidate-mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { "agent-hub": { command: "bun", args: [bundle], env: { AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: dir, AGENTHUB_PEER_ID: peer } } } }, null, 2) + "\n", { mode: 0o600 });
  const prompt = `You are the conductor/reviewer for a disposable native smoke. Start local and headless pi with hub_peer_start. Hold both with hub_peer_hold. Propose exactly two class implement tasks initially owned by local: task A must write alpha.txt containing exactly ALPHA then read it and call hub_task_done with the observed check; task B must write beta.txt containing exactly BETA then read it and call hub_task_done with the observed check. Give each task a precise path plan in refs/plan. Reassign task B to pi with hub_task_assign before releasing both holds. Do not implement these tasks yourself. Never answer any permission request: tell the person to answer in ahub console. As reviewer, inspect the resulting files with Read and approve with hub_review only after their actual content matches. ${feed === "off" ? "The supervision feed is off; return after delegation and wait for a user review prompt." : "The own supervision feed is on; handle milestones without polling loops and report once both tasks are approved."} Use no network or unrelated files.`;
  writeFileSync(join(dir, "conductor-prompt.txt"), prompt + "\n", { mode: 0o600 });
  const leg: any = { peer, feed, fixture: dir, status: "prepared", nativeTui: true, consoleApprovals: "not observed", completedTasks: 0, conductorTurns: null, conductorTokens: null, supervisionTurns: null, supervisionTokens: null };
  manifest.legs.push(leg); save();
  if (!live) continue;
  if (!process.stdin.isTTY) { leg.status = "blocked"; leg.reason = "live smoke requires operator stdin for native console approvals"; save(); continue; }
  const previousRaw = process.stdin.isRaw;
  let hub: ControlClient | undefined; let tui: NativePty | undefined; let consolePty: NativePty | undefined; let input: ((data: Buffer) => void) | undefined;
  try {
    if (peer === "codex" && !model) throw new Error("pass --model only after verifying it with the installed account/provider; cached slugs do not establish access");
    await command([process.execPath, entry, "--project", dir, "up", "--no-console"], dir);
    hub = await ControlClient.connect(stateDir, { role: "console", projectRoot: dir });
    consolePty = nativePty([process.execPath, entry, "--project", dir, "console"], dir, `${peer}-${feed}-console`);
    // Read the native terminal transcript separately. stdin keys go directly to the genuine console process.
    input = data => { if (data.includes(3)) interrupted = true; consolePty?.input(data.toString()); };
    process.stdin.setRawMode(true); process.stdin.on("data", input); process.stdin.resume();
    console.log(`Native ${peer}/${feed}: operator keys go to ahub console. Terminal evidence: ${join(runRoot, `${peer}-${feed}-console.terminal.txt`)}`);
    const args = peer === "claude" ? ["--mcp-config", mcp, "--strict-mcp-config", "--allowedTools", "mcp__agent-hub__*", "Read", "--ax-screen-reader", prompt] : ["--model", model!, prompt];
    tui = nativePty([process.execPath, entry, "--project", dir, peer, ...args], dir, `${peer}-${feed}-tui`);
    await until(async () => { const s = (await hub!.request({ t: "status" }, 3000)).status; return s?.peers?.[peer]?.attached !== false && ["idle", "busy"].includes(s?.peers?.[peer]?.state) ? true : undefined; }, "native conductor attachment", 120);
    let reviewPrompted = false;
    const completed = await until(async () => {
      const reply = await hub!.request({ t: "task", op: "hub_task_list", args: {} }, 3000);
      if (!reply.ok) return undefined;
      const tasks: any[] = JSON.parse(reply.text);
      if (feed === "off" && !reviewPrompted && tasks.length === 2 && tasks.every(t => ["in_review", "approved"].includes(t.state))) {
        reviewPrompted = true; tui!.input("Inspect alpha.txt and beta.txt using Read, then review both tasks with hub_review. Only approve actual matching contents.\r");
      }
      return tasks.length === 2 && tasks.every(t => t.state === "approved") ? tasks : undefined;
    }, "two reviewed tasks");
    if (readFileSync(join(dir, "alpha.txt"), "utf8").trim() !== "ALPHA" || readFileSync(join(dir, "beta.txt"), "utf8").trim() !== "BETA") throw new Error("fixture output mismatch");
    await until(async () => { const status = (await hub!.request({ t: "status" }, 3000)).status; return status?.peers?.[peer]?.state === "idle" ? true : undefined; }, "completed conductor turn", 120);
    const histories = await Promise.all(completed.map(async t => JSON.parse((await hub!.request({ t: "task", op: "task_show", args: { id: t.id } }, 3000)).text)));
    const reassigned = histories.some(t => t.history.some((h: any) => h.by === peer && ["assigned", "reassigned"].includes(h.event) && h.owner === "pi"));
    const reviewed = histories.every(t => t.history.some((h: any) => h.by === peer && h.event === "approved"));
    const events = readEvents(join(stateDir, "events.jsonl")); const report = summarize(events);
    const started = ["local", "pi"].every(p => events.some(e => e.type === "conduct" && e.peer === peer && e.action === "peer_start" && e.target === p));
    const approvalConsole = events.some(e => e.type === "permission" && e.event === "answered" && e.surface === "console");
    leg.completedTasks = completed.length; leg.reassigned = reassigned; leg.reviewed = reviewed; leg.startedBothWorkers = started;
    leg.consoleApprovals = approvalConsole ? "observed in daemon audit" : "not established";
    leg.conductorTurns = report.peers[peer]?.turns ?? null;
    const usage = report.usage.peers[peer]; leg.conductorTokens = usage?.totalRecords ? usage.totalTokens : null;
    leg.supervisionTurns = report.supervision[peer]?.turns ?? null; leg.supervisionTokens = report.supervision[peer]?.tokens ?? null;
    leg.turnsPerCompletedTask = leg.conductorTurns === null ? null : leg.conductorTurns / completed.length;
    leg.tokensPerCompletedTask = leg.conductorTokens === null ? null : leg.conductorTokens / completed.length;
    leg.ownerUsage = Object.fromEntries(["local", "pi"].map(p => [p, { turns: report.peers[p]?.turns ?? null, tokens: report.usage.peers[p]?.totalRecords ? report.usage.peers[p]!.totalTokens : null }]));
    writeFileSync(join(runRoot, `${peer}-${feed}-report.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    leg.status = reassigned && reviewed && started && approvalConsole && leg.conductorTurns !== null ? "passed" : "incomplete";
  } catch (error) { leg.status = "incomplete"; leg.reason = terminalText((error as Error).message).slice(0, 1000); }
  finally {
    if (input) { process.stdin.off("data", input); process.stdin.setRawMode(previousRaw); process.stdin.pause(); }
    // Only our PTY wrappers and the verified fixture daemon are stopped. No shared model/service shutdown.
    try { await tui?.close(); await consolePty?.close(); } catch (error) { leg.teardownError = terminalText((error as Error).message); save(); throw error; }
    hub?.close();
    try { await command([process.execPath, entry, "--project", dir, "kill"], dir); } catch (error) { leg.teardownError = terminalText((error as Error).message); }
    save();
  }
}
save();
console.log(JSON.stringify({ summary: join(runRoot, "summary.json"), live, legs: manifest.legs.map((leg: any) => ({ peer: leg.peer, feed: leg.feed, status: leg.status })) }));
if (live && manifest.legs.some((leg: any) => leg.status !== "passed")) process.exitCode = 1;
