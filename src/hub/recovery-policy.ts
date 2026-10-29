/** Fresh, read-only privacy and policy proof for a host-sealed conductor recovery.
 * This does not reconstruct the daemon's memory-only private-turn flag: the live
 * admission path must also refuse contextPii before minting a recovery authority.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { defaultPeerRoles, definitionOf } from "../adapters/registry.ts";
import type { HubConfig } from "./daemon.ts";
import { conductorPeer } from "./conductor.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "./db-timeout.ts";
import { readInstanceConfig, type InstanceConfigLayer } from "./instance-config.ts";
import { effectiveInstanceRoles } from "./instances.ts";
import { realPath } from "./project.ts";
import { RecoveryAuthorityError } from "./recovery-authority.ts";
import { peerRosterConfig, rosterAllows } from "./roster.ts";
import { parseOverlay, parseRouting, type Routing } from "./routing.ts";

export interface RecoveryPolicyProject { root: string; id: string; stateDir: string }
export interface RecoveryPolicyCapture { policyDigest: string; boardDigest: string }
const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_ACTOR_TASKS = 4096;
const MAX_SIGNALS_BYTES = 65536;
const refuse = (): never => { throw new RecoveryAuthorityError(); };
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const stamp = (s: ReturnType<typeof lstatSync>): string => JSON.stringify([s.dev, s.ino, s.size, s.mode, s.nlink, s.mtimeMs, s.ctimeMs]);

/** Only bounded, regular, stable files; an absent optional policy is different from an unreadable one. */
function boundedText(file: string, optional = false): string | undefined {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_POLICY_BYTES || realPath(file) !== file) refuse();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
    if (length !== before.size || stamp(before) !== stamp(fstatSync(fd)) || stamp(before) !== stamp(lstatSync(file))) refuse();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}

/** Stable semantic encoding; never evaluate config accessors or serialize runtime objects. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) refuse();
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(",")}]`;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refuse();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string") || Object.values(fields).some(field => !Object.hasOwn(field, "value"))) refuse();
  return `{${Object.keys(fields).sort().filter(key => fields[key]!.value !== undefined).map(key => `${JSON.stringify(key)}:${canonical(fields[key]!.value, depth + 1)}`).join(",")}}`;
}

function freshRoles(layers: readonly InstanceConfigLayer[], scope: ReturnType<typeof readInstanceConfig>): Record<string, string[]> {
  const roles = defaultPeerRoles(true);
  for (const { raw } of layers) if (raw.roles !== undefined) {
    conductorPeer(raw.roles);
    for (const [id, list] of Object.entries(raw.roles as Record<string, string[]>)) {
      const definition = definitionOf(id), ceiling = definition?.routing?.allowedRoles;
      roles[id] = (ceiling ? list.filter(role => ceiling.includes(role)) : list).filter(role => role !== "planner" || !definition || definition.projection?.plannerEligible === true);
    }
  }
  const configured = Object.fromEntries(scope.catalog.definitions.filter(d => !definitionOf(d.kind)).map(d => [d.kind, [...d.roles]]));
  const extras = Object.fromEntries(Object.keys(scope.instances ?? {}).map(id => [id, effectiveInstanceRoles(id, scope.instances, roles, scope.catalog)]));
  return { ...configured, ...roles, ...extras };
}

function publicActorBoard(stateDir: string, peer: string, routing: Routing): string {
  const file = join(stateDir, "hub.db"), before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || realPath(file) !== file) refuse();
  const db = new Database(file, { readonly: true });
  db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
  try {
    db.run("BEGIN");
    // Metadata only. In particular no unrelated task titles, bodies, history or refs are read.
    const rows = db.query(`SELECT id, state, owner, reviewer,
      CASE WHEN typeof(signals) = 'text' AND length(CAST(signals AS BLOB)) <= ${MAX_SIGNALS_BYTES} THEN signals ELSE NULL END AS signals
      FROM tasks WHERE (owner = ? OR reviewer = ?) AND (state NOT IN ('approved', 'cancelled') OR state IS NULL)
      ORDER BY id LIMIT ${MAX_ACTOR_TASKS + 1}`).all(peer, peer) as { id: number; state: string; owner: string | null; reviewer: string | null; signals: string | null }[];
    if (rows.length > MAX_ACTOR_TASKS) refuse();
    let total = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id) || row.id <= 0 || !["proposed", "in_progress", "in_review", "changes_requested"].includes(row.state)
        || row.signals === null || (total += Buffer.byteLength(row.signals)) > MAX_POLICY_BYTES) refuse();
      const signals: unknown = JSON.parse(row.signals);
      if (!Array.isArray(signals) || signals.length > 1024 || signals.some(signal => typeof signal !== "string" || signal.length > 1024)) refuse();
      if (signals.includes("pii_path") || signals.includes("pii") && routing.constraints.pii === "local_only") refuse();
    }
    db.run("COMMIT");
    const after = lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || realPath(file) !== file) refuse();
    // Unrelated public board activity must not revoke a public conductor's offline continuity.
    return hash(canonical({ schema: 1, peer, private: false }));
  } finally { db.close(); }
}

/** The third argument is a fresh host loadConfig result, never request JSON or retained metadata. */
export function captureRecoveryPolicy(project: RecoveryPolicyProject, peer: string, currentConfig: HubConfig): RecoveryPolicyCapture {
  try {
    if (!project.id || !isAbsolute(project.root) || !isAbsolute(project.stateDir) || realPath(project.root) !== project.root || realPath(project.stateDir) !== project.stateDir) refuse();
    const layers: InstanceConfigLayer[] = [];
    for (const name of ["config.json", "config.local.json"] as const) {
      const text = boundedText(join(project.root, ".agenthub", name), true);
      if (text === undefined) continue;
      const raw: unknown = JSON.parse(text);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse();
      layers.push({ name, raw: raw as Record<string, unknown> });
    }
    // Explicit empty runtime definitions: never import a module or trust a retained display catalog.
    const scope = readInstanceConfig(project.root, layers, []);
    if (scope.adapter_modules?.length || scope.declaredExternalInstances?.length || currentConfig.adapter_modules?.length) refuse();
    const roles = freshRoles(layers, scope);
    if (conductorPeer(roles) !== peer || conductorPeer(currentConfig.roles) !== peer || canonical(roles) !== canonical(currentConfig.roles)
      || canonical(scope.instances ?? {}) !== canonical(currentConfig.instances ?? {}) || scope.instances?.[peer]?.readOnly === true
      || !scope.catalog.definitionOf(peer, scope.instances)) refuse();
    // roster is merged key by key by loadConfig; independently refresh the exact fields that admit the actor.
    const rawRoster = Object.assign({}, ...layers.map(layer => layer.raw.roster ?? {}));
    const roster = peerRosterConfig(rawRoster, scope.instances, scope.catalog);
    if (canonical(roster) !== canonical(currentConfig.roster) || !rosterAllows(roster, peer, currentConfig.pi.enabled, scope.instances, scope.catalog)) refuse();
    const main = boundedText(join(project.root, ".agenthub", "routing.toml"), true)
      ?? boundedText(resolve(import.meta.dir, "..", "..", "templates", "routing.toml"))!;
    const overlay = boundedText(join(project.root, ".agenthub", "routing.local.toml"), true);
    const routing = parseRouting(main, overlay === undefined ? undefined : parseOverlay(overlay));
    // ponytail: at most 2 MiB config, 2 MiB routing and 4096 actor-bound open rows (1 MiB signals).
    // A larger board fails closed; the upgrade path is an indexed durable per-actor privacy generation.
    const policy = canonical({ schema: 1, project: { root: project.root, id: project.id, stateDir: project.stateDir }, peer, roles, roster, instances: scope.instances ?? {},
      config: currentConfig, sources: layers, routing });
    if (Buffer.byteLength(policy) > 8 * MAX_POLICY_BYTES) refuse();
    return { policyDigest: hash(policy), boardDigest: publicActorBoard(project.stateDir, peer, routing) };
  } catch { return refuse(); }
}
