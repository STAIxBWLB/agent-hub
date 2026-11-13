import { isAbsolute, join } from "node:path";
import type { CompatId } from "../adapters/compat.ts";
import type { AdapterDefinition } from "../adapters/registry-types.ts";
import { childEnv } from "../hub/child-process.ts";
import { withoutOrcaEnv } from "../hub/orca-env.ts";
import type { RunCommand } from "./recovery-package.ts";
import type { PlannedProject } from "./upgrade.ts";

/** Host-selected native launch gates, never inferred from a peer's spelling or a reviewer policy. */
export interface RecoveryVersionGate { peer: string; compatId: CompatId; command?: readonly string[] }
export interface RecoveryVersionObservation {
  peer: string;
  compatId: CompatId;
  state: "accepted" | "refused" | "unknown";
  version?: string;
  /** Fixed guidance only: never native output, executable paths or target exception text. */
  message: string;
}
export interface RecoveryVersionPorts {
  run: RunCommand;
  /** The caller revalidates the verified target root/digest and its own authority across awaits. */
  current(): boolean;
}
const MAX_GATES = 64;
const MAX_OUTPUT_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const PEER = /^[a-z][a-z0-9_-]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The caller supplies its startup-bound project resolver and current configured executable argv. */
export function recoveryVersionGates(
  planned: PlannedProject,
  definition: (peer: string) => AdapterDefinition | undefined,
  commands: Partial<Record<CompatId, readonly string[]>> = {},
): RecoveryVersionGate[] {
  const gates: RecoveryVersionGate[] = [], seen = new Set<string>();
  for (const peer of planned.source.peers) {
    if (peer.state === "offline" || planned.reconnectOnly?.includes(peer.id) || seen.has(peer.id)) continue;
    seen.add(peer.id);
    const adapter = definition(peer.id), compatId = adapter?.session.restoreVersionGate;
    if (!adapter || !compatId || adapter.session.recoveryRefusal?.(peer, "plan")) continue;
    if (gates.length >= MAX_GATES) throw new Error("recovery version preflight has too many native gates");
    gates.push({ peer: peer.id, compatId, ...(commands[compatId] ? { command: [...commands[compatId]!] } : {}) });
  }
  return gates;
}

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const words = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 32
  && value.every(word => typeof word === "string" && word.length > 0 && word.length <= 4096 && !/[\p{Cc}\p{Cf}]/u.test(word));
const unknown = (gate: RecoveryVersionGate): RecoveryVersionObservation => ({ peer: gate.peer, compatId: gate.compatId, state: "unknown",
  message: `${gate.peer}: target version acceptance is unknown; check its configured executable and the target's ahub agents policy before restoring it` });

/**
 * Read an already verified target's own policy, probe only the selected executable, then assess with that target's current machine trust.
 * No result is cached or grants startup authority. The caller must run this again before pre-commit effects, including cached staging.
 * Every command crosses the injected port; synthetic tests never execute a native CLI or import an arbitrary target in this process.
 */
export async function readRecoveryVersionPreflight(
  targetRoot: string,
  projectRoot: string,
  gates: readonly RecoveryVersionGate[],
  ports: RecoveryVersionPorts,
): Promise<RecoveryVersionObservation[]> {
  if (!isAbsolute(targetRoot) || !isAbsolute(projectRoot) || !Array.isArray(gates) || gates.length > MAX_GATES
    || gates.some(gate => !PEER.test(gate.peer) || !/^[a-z][a-z0-9-]{0,63}$/.test(gate.compatId)
      || gate.command !== undefined && !words(gate.command))) throw new Error("invalid recovery version preflight scope");
  const module = JSON.stringify(join(targetRoot, "src/adapters/compat.ts"));
  const env = withoutOrcaEnv(childEnv({ ...process.env, JCODE_NO_TELEMETRY: "1", JCODE_DISABLE_CLAUDE_MCP: "1", AGY_CLI_DISABLE_AUTO_UPDATE: "1" }));
  const run = async (argv: string[]) => {
    if (!ports.current()) throw new Error("recovery version preflight authority changed");
    const result = await ports.run(argv, { cwd: projectRoot, env, timeoutMs: PROBE_TIMEOUT_MS });
    if (!ports.current()) throw new Error("recovery version preflight authority changed");
    if (result.code !== 0 || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) return undefined;
    return result.stdout;
  };
  const results: RecoveryVersionObservation[] = [];
  for (const gate of gates) {
    let observation = unknown(gate);
    try {
      // This target import is allowed only after the caller verified the package's retained root and digest.
      const policyText = await run([process.execPath, "-e", `// recovery-version-policy\nimport { COMPAT } from ${module}; const id = ${JSON.stringify(gate.compatId)}; const p = Object.hasOwn(COMPAT, id) ? COMPAT[id] : undefined; console.log(JSON.stringify(p ? { probe: p.probe } : null));`]);
      const policy: unknown = policyText === undefined ? undefined : JSON.parse(policyText);
      if (!plain(policy) || !words(policy.probe)) { results.push(observation); continue; }
      const [executable, ...prefix] = gate.command ?? [policy.probe[0]!];
      const native = await run([executable!, ...prefix, ...policy.probe.slice(1)]);
      if (native === undefined) { results.push(observation); continue; }
      const assessment = await run([process.execPath, "-e", `// recovery-version-assess\nimport { COMPAT, assessVersion, readTrust } from ${module}; const id = ${JSON.stringify(gate.compatId)}; const p = Object.hasOwn(COMPAT, id) ? COMPAT[id] : undefined; const v = p ? assessVersion(id, p.parse(${JSON.stringify(native)}), readTrust()) : undefined; console.log(JSON.stringify(v ? { ok: v.ok, state: v.state, version: v.version } : null));`]);
      const verdict: unknown = assessment === undefined ? undefined : JSON.parse(assessment);
      if (plain(verdict) && typeof verdict.version === "string" && verdict.version.length <= 64 && SEMVER.test(verdict.version)) {
        const version = verdict.version;
        if (verdict.ok === true && ["verified", "trusted", "in-line"].includes(String(verdict.state))) observation = { ...observation, state: "accepted", version,
          message: `${gate.peer}: target accepts installed version ${version}` };
        else if (verdict.ok === false && verdict.state === "refused") observation = { ...observation, state: "refused", version,
          message: `${gate.peer}: target refuses installed version ${version}; install a verified version, or accept this exact version on this machine with: ahub agents trust ${gate.compatId} ${version}` };
      }
    } catch { /* A failed policy/probe is unknown, never accepted or a leaked native exception. */ }
    // A changed target or authority invalidates all earlier observations, not merely the final gate.
    if (!ports.current()) return gates.map(unknown);
    results.push(observation);
  }
  return ports.current() ? results : gates.map(unknown);
}
