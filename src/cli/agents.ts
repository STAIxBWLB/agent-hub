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

/** #843 AC3: the same probe for the daemon, which must not block its event loop for up to ten seconds an id. */
export async function agentVersionsAsync(commands: Partial<Record<CompatId, readonly string[]>> = {}, timeoutMs = 10_000): Promise<AgentVersionRow[]> {
  const trusted = readTrust();
  return Promise.all((Object.keys(COMPAT) as CompatId[]).map(async id => {
    const target = probeTarget(id, commands);
    if (!target) return probeRow(id, undefined, undefined, trusted);
    try {
      const child = Bun.spawn([target.executable, ...target.args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, ...PROBE_ENV }, timeout: timeoutMs, killSignal: "SIGKILL" });
      const reading = new Response(child.stdout).text();
      const code = await child.exited;
      // A grandchild can keep the pipe open after the probe itself ended or was killed; never wait on it past the exit.
      const text = await Promise.race([reading, Bun.sleep(250).then(() => undefined)]);
      return probeRow(id, target.executable, code === 0 && text !== undefined && text.length <= 64 * 1024 ? text : undefined, trusted);
    } catch { return probeRow(id, target.executable, undefined, trusted); }
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
