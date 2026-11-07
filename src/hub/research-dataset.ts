import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { familyOf as builtinFamilyOf } from "../adapters/registry.ts";
import { VERSION } from "../version.ts";
import { readEvents, type StampedEvent } from "./events.ts";
import { readInstanceConfig } from "./instance-config.ts";
import { hubHome, realPath } from "./project.ts";
import { latestTaskRecords, projectKey, closedAtOf, readStore, researchFile, type LabelRecord, type PeerUsage, type ResearchRecord, type TaskRecord } from "./research.ts";
import { buildResearchQuality, type QualityReport } from "./research-quality.ts";
import type { Addon } from "./tooling.ts";

/**
 * #1277 (#44): the research dataset, a projection of the record store and the event log into three files per project (`tasks.jsonl`, `manifest.json`, `quality.json`). It is built to
 * leave the machine, so it is an allowlist: a peer is only ever a family name (an instance id such as `codex-review` is a name the person chose), and the fields that carry a
 * project-chosen name (profile, role, session roles) are dropped. The records are already text-free, so a task title, a path or an envelope body is not here to leak; the
 * privacy test proves it on a canary fixture instead of trusting that.
 */
export const MANIFEST_SCHEMA = "agent-hub.research-dataset/v1";
export const UNKNOWN_FAMILY = "unknown";

export interface DatasetProject { id: string; root: string; stateDir: string }
export interface DatasetInput {
  project: DatasetProject;
  records: readonly ResearchRecord[];
  events: readonly StampedEvent[];
  /** Instance ids resolve to a family only through the project's own config; the registry default knows the shipped adapters. */
  familyOf?: (peer: string) => string | undefined;
}
export interface DatasetOptions { since?: number; now?: () => number; hubVersion?: string; /** The directory the target must be inside; the person's home unless a test says otherwise. */ home?: string }
export interface DatasetManifest {
  schema: typeof MANIFEST_SCHEMA; hubVersion: string; projectKeyHash: string;
  window: { since: string | null; until: string };
  /** Family names only, sorted; `unknown` stands for a peer no family is known for. */
  peers: string[];
  counts: { tasks: number; approved: number; cancelled: number; labels: number };
  recordedAt: string;
}
export interface DatasetResult { projectKeyHash: string; dir: string; counts: DatasetManifest["counts"] }

/** Why a target directory is refused, or undefined when it is allowed. Both sides are compared as real paths: a symlink out of the home or into the project does not pass. */
export function refuseTarget(target: string, projects: readonly { root: string; stateDir: string }[], home = homedir()): string | undefined {
  const absolute = resolve(target);
  // The nearest existing ancestor decides: the directory itself may not exist yet.
  let existing = absolute; const rest: string[] = [];
  while (!existsSync(existing)) { const up = dirname(existing); if (up === existing) return `no part of ${target} exists`; rest.unshift(basename(existing)); existing = up; }
  const real = join(realPath(existing), ...rest), realHome = realPath(home);
  if (real !== realHome && !real.startsWith(realHome + sep)) return `the dataset directory must be inside your home directory (${realHome})`;
  if (real === realHome) return "the dataset directory must be a directory of its own, not the home directory itself";
  for (const p of projects) {
    for (const dir of [p.root, p.stateDir]) {
      let inside: string; try { inside = realPath(dir); } catch { inside = resolve(dir); }
      if (real === inside || real.startsWith(inside + sep) || inside.startsWith(real + sep)) return `the dataset directory must be outside the project and its state directory (${inside})`;
    }
  }
  return undefined;
}

const family = (peer: string, familyOf: (peer: string) => string | undefined): string => familyOf(peer) ?? builtinFamilyOf(peer) ?? UNKNOWN_FAMILY;
const sumNullable = (a: number | null, b: number | null): number | null => a === null && b === null ? null : (a ?? 0) + (b ?? 0);

/** One task record as it goes into the dataset: every peer id folded into its family, fields that carry project-chosen names dropped. */
export function datasetTask(r: TaskRecord, familyOf: (peer: string) => string | undefined): TaskRecord {
  const fam = (peer: string) => family(peer, familyOf);
  const { profile: _p, profileClass: _pc, role: _r, roleIdentity: _ri, sessionRoles: _sr, peers, tooling, ...rest } = r;
  const byPeer: Record<string, number> = {};
  for (const [peer, n] of Object.entries(r.tokens.byPeer)) byPeer[fam(peer)] = (byPeer[fam(peer)] ?? 0) + n;
  const usage: Record<string, PeerUsage> = {};
  for (const [peer, u] of Object.entries(r.usage)) {
    const key = fam(peer), held = usage[key];
    usage[key] = held ? { input: sumNullable(held.input, u.input), output: sumNullable(held.output, u.output), cacheRead: sumNullable(held.cacheRead, u.cacheRead), total: sumNullable(held.total, u.total) } : { ...u };
  }
  const out: TaskRecord = { ...rest, owners: r.owners.map(fam), reviewer: r.reviewer === null ? null : fam(r.reviewer), tokens: { ...r.tokens, byPeer: sortKeys(byPeer) }, usage: sortKeys(usage) };
  if (peers) out.peers = [...new Set(peers.map(fam))].sort();
  if (tooling) {
    const byFamily: Record<string, Addon[]> = {};
    // A family with two peers that had different add-ons reads as the union: the dataset only says which add-ons were around.
    for (const [peer, addons] of Object.entries(tooling)) { const key = fam(peer), held = byFamily[key] ??= []; for (const a of addons) if (!held.some(h => h.name === a.name)) held.push(a); }
    out.tooling = sortKeys(byFamily);
  }
  return out;
}
const sortKeys = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const datasetLabel = (l: LabelRecord, familyOf: (peer: string) => string | undefined): LabelRecord => l.by === undefined ? l : { ...l, by: family(l.by, familyOf) };

/** Build one project's three files in memory; nothing is written. */
export function buildDataset(input: DatasetInput, options: DatasetOptions = {}): { tasks: string; manifest: DatasetManifest; quality: QualityReport } {
  const now = (options.now ?? Date.now)(), since = options.since ?? 0, familyOf = input.familyOf ?? (() => undefined);
  const fam = (peer: string) => family(peer, familyOf);
  const tasks = latestTaskRecords(input.records).filter(r => Date.parse(closedAtOf(r) ?? "") >= since);
  const keep = new Set(tasks.map(r => `${r.task}\n${r.createdAt}`));
  const labels = input.records.filter((r): r is LabelRecord => r.kind === "label" && keep.has(`${r.task}\n${r.createdAt}`));
  const rows = [...tasks.map(r => datasetTask(r, familyOf)), ...labels.map(l => datasetLabel(l, familyOf))];
  const peers = new Set<string>();
  for (const r of tasks) { for (const o of r.owners) peers.add(fam(o)); if (r.reviewer) peers.add(fam(r.reviewer)); for (const p of r.peers ?? []) peers.add(fam(p)); for (const p of Object.keys(r.tokens.byPeer)) peers.add(fam(p)); }
  const quality = buildResearchQuality(input.records, input.events, { ...(since > 0 ? { since } : {}), until: now }, familyOf);
  return {
    tasks: rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
    manifest: {
      schema: MANIFEST_SCHEMA, hubVersion: options.hubVersion ?? VERSION, projectKeyHash: projectKey(input.project.id),
      window: { since: since > 0 ? new Date(since).toISOString() : null, until: new Date(now).toISOString() }, peers: [...peers].sort(),
      counts: { tasks: tasks.length, approved: tasks.filter(r => r.outcome === "approved").length, cancelled: tasks.filter(r => r.outcome === "cancelled").length, labels: labels.length },
      recordedAt: new Date(now).toISOString(),
    },
    quality,
  };
}

/** A file written whole: a temp file in the same directory, then a rename, so a reader never sees half of it. Owner-only. */
function writeWhole(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/**
 * Write each project's dataset under `<target>/<projectKeyHash>/`. The target is checked against every given project (the ones that will be exported and the one the command ran in), not
 * only the one being written. A project directory that is a symlink is refused: it could point anywhere the check did not look.
 */
export function exportResearchDataset(target: string, inputs: readonly DatasetInput[], options: DatasetOptions = {}, guard: readonly { root: string; stateDir: string }[] = inputs.map(i => i.project)): DatasetResult[] {
  const refusal = refuseTarget(target, guard, options.home);
  if (refusal) throw new Error(refusal);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const results: DatasetResult[] = [];
  for (const input of inputs) {
    const built = buildDataset(input, options), key = built.manifest.projectKeyHash, dir = join(target, key);
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symbolic link; remove it first`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeWhole(join(dir, "tasks.jsonl"), built.tasks);
    writeWhole(join(dir, "quality.json"), JSON.stringify(built.quality, null, 2) + "\n");
    // The manifest goes last: a directory with a manifest is a complete one.
    writeWhole(join(dir, "manifest.json"), JSON.stringify(built.manifest, null, 2) + "\n");
    results.push({ projectKeyHash: key, dir, counts: built.manifest.counts });
  }
  return results;
}

/** The family of a peer id through the project's own config (instances resolve there); undefined when the config cannot be read, then only the shipped adapters' families apply. */
export function projectFamilyOf(root: string): ((peer: string) => string | undefined) | undefined {
  try {
    const config = readInstanceConfig(root);
    return peer => config.catalog.familyOf(peer, config.instances);
  } catch { return undefined; }
}

/**
 * One registered project's records, events and family lookup, read-only. Instance ids resolve through that project's own config (`readInstanceConfig`); a config that cannot be read leaves
 * the shipped adapters' families, and an id neither knows is `unknown`, never guessed from its spelling. Undefined when the project has no record file: it was never researched.
 */
export function datasetInputFor(project: DatasetProject, home = hubHome()): DatasetInput | undefined {
  const file = researchFile(project.id, home);
  if (!existsSync(file)) return undefined;
  const familyOf = projectFamilyOf(project.root);
  return { project, records: readStore(file), events: readEvents(join(project.stateDir, "events.jsonl")), ...(familyOf ? { familyOf } : {}) };
}
