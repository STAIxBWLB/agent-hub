import { spawnSync } from "node:child_process";
import { assessVersion, COMPAT, describe, isCompatId, readTrust, trustFile, writeTrust, type CompatId, type CompatVerdict } from "../adapters/compat.ts";

/** #691: what `ahub agents` and `ahub doctor` show for each gated native CLI. */
export interface AgentVersionRow { id: CompatId; executable?: string; verdict: CompatVerdict; policy: string }

const PROBE_ENV = { JCODE_NO_TELEMETRY: "1", JCODE_DISABLE_CLAUDE_MCP: "1" };

/** The one place that decides what is run for an id: the configured argv (including pi.cmd) plus the probe words. */
function probeTarget(id: CompatId, commands: Partial<Record<CompatId, readonly string[]>>): { executable: string; args: string[] } | undefined {
  const [defaultBin, ...words] = COMPAT[id].probe;
  const [bin = defaultBin, ...prefix] = commands[id] ?? [defaultBin];
  const executable = Bun.which(bin) ?? undefined;
  return executable ? { executable, args: [...prefix, ...words] } : undefined;
}

function probeRow(id: CompatId, executable: string | undefined, stdout: string | undefined, trusted: ReturnType<typeof readTrust>): AgentVersionRow {
  if (!executable) return { id, verdict: { ok: false, state: "unknown", reason: `${COMPAT[id].label} not found on PATH` }, policy: describe(id) };
  return { id, executable, verdict: assessVersion(id, stdout === undefined ? undefined : COMPAT[id].parse(stdout), trusted), policy: describe(id) };
}

/** `commands` carries the configured argv (including pi.cmd); the probe words follow it. */
export function agentVersions(commands: Partial<Record<CompatId, readonly string[]>> = {}): AgentVersionRow[] {
  const trusted = readTrust();
  return (Object.keys(COMPAT) as CompatId[]).map(id => {
    const target = probeTarget(id, commands);
    if (!target) return probeRow(id, undefined, undefined, trusted);
    const result = spawnSync(target.executable, target.args, { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, ...PROBE_ENV } });
    return probeRow(id, target.executable, result.status === 0 ? result.stdout ?? "" : undefined, trusted);
  });
}

const PROBE_OUTPUT_CAP = 64 * 1024;
/** After the probe process ends, how long a descendant that kept the pipe open may still be read before the reader is cancelled. */
const PROBE_EXIT_GRACE_MS = 250;

/**
 * One bounded probe run. Output is read as a stream and counted as it arrives: past the cap the probe is killed and the
 * reader cancelled, so a chatty or endless CLI never accumulates in memory. A deadline kills the probe and cancels the
 * reader, and a descendant that inherited stdout cannot hold the reader past the grace after the probe's own exit.
 * ponytail: only the probe process is killed, not its descendants; a stray one ends on its own or when its pipe closes.
 * The upgrade is a process group via child_process (as `jcodeVersionAsync` does).
 */
async function runProbe(executable: string, args: readonly string[], timeoutMs: number, graceMs = PROBE_EXIT_GRACE_MS): Promise<string | undefined> {
  const child = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, ...PROBE_ENV }, timeout: timeoutMs, killSignal: "SIGKILL" });
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0, overflow = false, cancelled = false;
  const release = () => { if (cancelled) return; cancelled = true; void reader.cancel().catch(() => undefined); };
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        total += value.byteLength;
        if (total > PROBE_OUTPUT_CAP) { overflow = true; child.kill("SIGKILL"); release(); return; }
        chunks.push(value);
      }
    } catch { /* a cancelled or failed read ends the probe with what was counted */ }
  })();
  const deadline = setTimeout(() => { child.kill("SIGKILL"); release(); }, timeoutMs + graceMs);
  let grace: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await child.exited;
    grace = setTimeout(release, graceMs);
    await pump;
    return code === 0 && !overflow ? Buffer.concat(chunks).toString("utf8") : undefined;
  } finally { clearTimeout(deadline); clearTimeout(grace); release(); }
}

/** #843 AC3: the same probe for the daemon, which must not block its event loop for up to ten seconds an id. */
export async function agentVersionsAsync(commands: Partial<Record<CompatId, readonly string[]>> = {}, timeoutMs = 10_000, graceMs = PROBE_EXIT_GRACE_MS): Promise<AgentVersionRow[]> {
  const trusted = readTrust();
  return Promise.all((Object.keys(COMPAT) as CompatId[]).map(async id => {
    const target = probeTarget(id, commands);
    if (!target) return probeRow(id, undefined, undefined, trusted);
    try { return probeRow(id, target.executable, await runProbe(target.executable, target.args, timeoutMs, graceMs), trusted); }
    catch { return probeRow(id, target.executable, undefined, trusted); }
  }));
}

export function runAgents(args: string[], commands: Partial<Record<CompatId, readonly string[]>>, fail: (message: string) => never): void {
  const [sub, id, version, ...rest] = args.filter(arg => arg !== "--json");
  if (sub === "trust") {
    const revoke = rest.includes("--revoke");
    if (!isCompatId(id) || !version || rest.some(arg => arg !== "--revoke")) fail(`usage: ahub agents trust <${Object.keys(COMPAT).join("|")}> <version> [--revoke]`);
    // The issue requires saying what trust covers before it is recorded.
    if (!revoke) console.log(`${COMPAT[id].label} ${version}: ${COMPAT[id].trustNote}`);
    let rows;
    try { rows = writeTrust(id, version, revoke); } catch (error) { fail((error as Error).message); }
    if (revoke) return console.log(`revoked: ${id} ${version} (${rows.length} trusted on this machine, ${trustFile()})`);
    console.log(`trusted on this machine: ${COMPAT[id].label} ${version}\nUndo: ahub agents trust ${id} ${version} --revoke`);
    return;
  }
  if (sub !== undefined) fail("usage: ahub agents [--json] | ahub agents trust <id> <version> [--revoke]");
  const rows = agentVersions(commands);
  if (args.includes("--json")) return console.log(JSON.stringify(rows.map(row => ({ id: row.id, executable: row.executable ?? null, ...row.verdict, policy: row.policy })), null, 2));
  for (const row of rows) {
    const v = row.verdict;
    console.log(`${row.id.padEnd(13)} ${(v.version ?? "-").padEnd(10)} ${v.state.padEnd(9)} ${row.policy}${v.ok ? (v.note ? `\n${" ".repeat(14)}${v.note}` : "") : `\n${" ".repeat(14)}${v.reason}`}`);
  }
}
