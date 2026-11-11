import { createHash } from "node:crypto";
import { chmodSync, constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readFileSync, readSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { executionText, EXECUTION_REFERENCE_LIMITS } from "../hub/execution-reference.ts";
import { hubGitSync } from "../hub/git.ts";
import { guidanceProbeCanonical, GUIDANCE_PROBE_LIMITS, PROBE_OUTPUT_LIMITS, type ProbeDataPolicyV1, type ProbeExcludedReason, type ProbeOutputEntry, type ProbeOutputExcluded,
  type ProbeOutputManifestV1, type ProbeRetainedRecord, type ProbeSlot, type ProbeTree } from "../hub/guidance-probes.ts";
import { foldSegment } from "../hub/permission-mode.ts";
import { realPath } from "../hub/project.ts";
import { isDenied } from "./deny.ts";
import { ProbeToolRefusal } from "./probe-errors.ts";

/** Availability ceilings, narrowed by the admitted budget. ponytail: manifest-declared materialization ceilings are the upgrade path. */
export const PROBE_WORKSPACE_LIMITS = Object.freeze({ fileBytes: 1024 * 1024, workspaceBytes: 64 * 1024 * 1024 });
export interface ProbeMaterializedFile { dataId: string; relative: string; sha256: string; bytes: Uint8Array }
export type ProbeSourceClass = "tree" | "task_source" | "closed_artifact" | "anonymized_deliverable" | "closed_round_evidence" | "improver_context";
export interface ProbeWorkspaceInput {
  role: ProbeSlot["role"];
  policy: ProbeDataPolicyV1;
  files: readonly ProbeMaterializedFile[];
  sourceTree?: { repo: string; tree: ProbeTree; files: readonly { dataId: string; path: string }[] };
  /** Trusted source-owner verification, never a declaration or model-selected classifier. */
  verifySource(file: ProbeMaterializedFile, role: ProbeSlot["role"]): ProbeSourceClass | Promise<ProbeSourceClass>;
  /** Completes the owner ledger reservation before this module creates a directory or writes bytes. */
  reserveStorage(bytes: number): void | Promise<void>;
  current(): void;
  maxBytes: number;
}
export interface ProbeWorkspace {
  readonly role: ProbeSlot["role"];
  readonly root: string;
  readonly home: string;
  readonly scratch: string;
  readonly output: string;
  readonly inputDigest: string;
  readonly files: readonly Readonly<{ dataId: string; relative: string; sha256: string; bytes: number }>[];
  readonly allowedWrites: readonly string[];
}
interface DirectoryIdentity { file: string; dev: number; ino: number }
interface WorkspaceState { parent: string; temporaryRoot: string; current(): void; reserveStorage(bytes: number): void | Promise<void>; maximum: number; charged: number; directories: readonly DirectoryIdentity[]; identities: readonly { file: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }[] }
const workspaces = new WeakMap<ProbeWorkspace, WorkspaceState>();
const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
function refused(): never { throw new Error("probe workspace source, role, path or resource proof is unavailable"); }
const integer = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const sha = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
const roleNames: readonly ProbeSlot["role"][] = ["worker", "proposal", "compose", "select", "reflect"];
function directoryIdentity(file: string): DirectoryIdentity {
  const stat = lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realPath(file) !== file) refused();
  return { file, dev: stat.dev, ino: stat.ino };
}
function requireDirectory(identity: DirectoryIdentity): void {
  const current = directoryIdentity(identity.file);
  if (current.dev !== identity.dev || current.ino !== identity.ino) refused();
}

/** The same folded names as ordinary guards, with no Git, hub or dependency tree in a probe. */
export function probeRelativePath(value: string): boolean {
  return executionText(value, EXECUTION_REFERENCE_LIMITS.id) && !isAbsolute(value) && !value.includes("\\")
    && !/^[a-z]:/i.test(value) && !isDenied(value)
    && value.split("/").every(part => !!part && ![".", "..", ".git", ".agenthub", "node_modules", ".probe-temp"].includes(foldSegment(part)));
}
function permitted(role: ProbeSlot["role"], source: ProbeSourceClass, policy: ProbeDataPolicyV1): boolean {
  if (role === "worker") return policy.roles.worker.guidanceOnlyExperience === true && (source === "tree" || source === "task_source");
  if (role === "proposal" || role === "compose") return source === "tree" || source === "task_source" || source === "closed_artifact"
    || source === "improver_context" && policy.roles[role].improverContext === true;
  if (role === "select") return policy.roles.select.anonymizedDeliverables === true && (source === "task_source" || source === "anonymized_deliverable");
  return role === "reflect" && policy.roles.reflect.closedRoundOnly === true && source === "closed_round_evidence";
}
function sourceTreeFile(input: ProbeWorkspaceInput, file: ProbeMaterializedFile, paths: Map<string, string>): void {
  const source = input.sourceTree, path = paths.get(file.dataId);
  if (!source || !path || !probeRelativePath(path)) refused();
  const oid = source.tree.oid;
  if (!(source.tree.objectFormat === "sha1" && /^[a-f0-9]{40}$/.test(oid)
    || source.tree.objectFormat === "sha256" && /^[a-f0-9]{64}$/.test(oid))) refused();
  const repo = realPath(source.repo);
  const git = (args: string[], maximum: number) => {
    input.current();
    const result = hubGitSync(["-C", repo, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: maximum });
    input.current();
    if (result.error || result.status !== 0) refused();
    return result.stdout;
  };
  if (git(["rev-parse", "--show-object-format"], EXECUTION_REFERENCE_LIMITS.id).trim() !== source.tree.objectFormat
    || git(["cat-file", "-t", oid], EXECUTION_REFERENCE_LIMITS.id).trim() !== "tree") refused();
  const entry = git(["--literal-pathspecs", "ls-tree", "-z", "--full-tree", oid, "--", path], EXECUTION_REFERENCE_LIMITS.id * 2);
  const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(entry);
  if (!match || match[3] !== path) refused();
  const nativeObject = createHash(source.tree.objectFormat).update(`blob ${file.bytes.byteLength}`).update(Buffer.alloc(1)).update(file.bytes).digest("hex");
  if (nativeObject !== match[2]) refused();
}

/** Materialize only verified admitted bytes. It never creates a Git worktree or exposes an object store. */
export async function materializeProbeWorkspace(input: ProbeWorkspaceInput): Promise<ProbeWorkspace> {
  if (!roleNames.includes(input.role) || !integer(input.maxBytes)
    || typeof input.current !== "function" || typeof input.reserveStorage !== "function" || typeof input.verifySource !== "function") refused();
  if (input.maxBytes > PROBE_WORKSPACE_LIMITS.workspaceBytes) throw new ProbeToolRefusal("workspace_ceiling");
  input.current();
  // Keep the host's checked declaration stable across source/reservation awaits.
  input = { ...input, policy: JSON.parse(guidanceProbeCanonical(input.policy, GUIDANCE_PROBE_LIMITS.snapshotBytes)) as ProbeDataPolicyV1,
    ...(input.sourceTree ? { sourceTree: { repo: input.sourceTree.repo, tree: { ...input.sourceTree.tree }, files: input.sourceTree.files.map(item => ({ ...item })) } } : {}) };
  const member = new Set(input.policy.roles[input.role].dataIds), declared = new Map(input.policy.admittedData.map(row => [row.id, row]));
  if (member.size !== input.policy.roles[input.role].dataIds.length || declared.size !== input.policy.admittedData.length) refused();
  const seenIds = new Set<string>(), foldedPaths = new Map<string, { spelling: string; directory: boolean }>(), treePaths = new Map<string, string>();
  for (const item of input.sourceTree?.files ?? []) {
    if (treePaths.has(item.dataId) || !probeRelativePath(item.path)) refused();
    treePaths.set(item.dataId, item.path);
  }
  let total = 0;
  const files: ProbeMaterializedFile[] = [];
  for (const original of input.files) {
    if (!executionText(original.dataId, EXECUTION_REFERENCE_LIMITS.id) || !probeRelativePath(original.relative)
      || !sha(original.sha256) || !(original.bytes instanceof Uint8Array) || seenIds.has(original.dataId) || !member.has(original.dataId)) refused();
    if (original.bytes.byteLength > PROBE_WORKSPACE_LIMITS.fileBytes) throw new ProbeToolRefusal("file_ceiling");
    const file = Object.freeze({ dataId: original.dataId, relative: original.relative, sha256: original.sha256, bytes: Buffer.from(original.bytes) });
    const admission = declared.get(file.dataId);
    if (!admission || !integer(admission.bytes) || admission.bytes !== file.bytes.length || admission.sha256 !== file.sha256
      || file.bytes.length > PROBE_WORKSPACE_LIMITS.fileBytes || digest(file.bytes) !== file.sha256) refused();
    seenIds.add(file.dataId); total += file.bytes.length;
    if (total > input.maxBytes) throw new ProbeToolRefusal("workspace_ceiling");
    const parts = file.relative.split("/");
    if (["scratch", "output"].includes(foldSegment(parts[0]!))) refused();
    for (let index = 1; index <= parts.length; index++) {
      const spelling = parts.slice(0, index).join("/"), directory = index < parts.length, key = parts.slice(0, index).map(foldSegment).join("/");
      const prior = foldedPaths.get(key);
      if (prior && (prior.spelling !== spelling || prior.directory !== directory || !directory)) refused();
      foldedPaths.set(key, { spelling, directory });
    }
    files.push(file);
  }
  if (seenIds.size !== member.size || [...member].some(id => !seenIds.has(id)) || [...treePaths.keys()].some(id => !seenIds.has(id))) refused();
  for (const file of files) {
    input.current();
    const source = await input.verifySource(file, input.role);
    input.current();
    if (!permitted(input.role, source, input.policy) || digest(file.bytes) !== file.sha256) refused();
    if (source === "tree") sourceTreeFile(input, file, treePaths);
    else if (treePaths.has(file.dataId)) refused();
  }
  const writes = input.policy.allowedWrites.map(row => {
    if (!["scratch", "output"].includes(row.root) || !probeRelativePath(row.relative)) refused();
    return `${row.root}/${row.relative}`;
  });
  if (new Set(writes.map(value => value.split("/").map(foldSegment).join("/"))).size !== writes.length) refused();
  input.current();
  await input.reserveStorage(total);
  input.current();
  // The complete setup charge has succeeded. No filesystem write occurs before it.
  const parent = realPath(mkdtempSync(join(tmpdir(), "ahub-probe-")));
  const directories = [directoryIdentity(parent)];
  const directoryMap = new Map(directories.map(entry => [entry.file, entry]));
  const setupFiles = new Map<string, { dev: number; ino: number }>();
  const root = join(parent, "workspace"), home = join(parent, "home"), temporaryRoot = join(root, ".probe-temp");
  const mkdir = (directory: string): void => {
    requireDirectory(directories[0]!);
    const actualRoot = directoryMap.get(root); if (actualRoot) requireDirectory(actualRoot);
    const existing = directoryMap.get(directory);
    if (existing) { requireDirectory(existing); return; }
    if (lstatSync(directory, { throwIfNoEntry: false })) refused();
    if (dirname(directory) !== parent) mkdir(dirname(directory));
    mkdirSync(directory, { mode: 0o700 }); const identity = directoryIdentity(directory); directories.push(identity); directoryMap.set(directory, identity);
  };
  try {
    chmodSync(parent, 0o700);
    for (const directory of [root, home, temporaryRoot, join(root, "scratch"), join(root, "output")]) mkdir(directory);
    const physicalRoots = [...directories];
    for (const file of files) {
      input.current();
      if (digest(file.bytes) !== file.sha256) refused();
      const dest = join(root, file.relative); mkdir(dirname(dest));
      const fd = openSync(dest, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
      try {
        const created = fstatSync(fd); setupFiles.set(dest, { dev: created.dev, ino: created.ino });
        writeFileSync(fd, file.bytes); const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.bytes.length) refused();
      } finally { closeSync(fd); }
    }
    input.current();
    const descriptors = files.map(({ dataId, relative, sha256, bytes }) => Object.freeze({ dataId, relative, sha256, bytes: bytes.length }));
    const workspace: ProbeWorkspace = Object.freeze({ role: input.role, root, home, scratch: join(root, "scratch"), output: join(root, "output"),
      inputDigest: digest(JSON.stringify(descriptors)), files: Object.freeze(descriptors), allowedWrites: Object.freeze(writes.map(path => join(root, path))) });
    const identities = descriptors.map(item => {
      const file = join(root, item.relative), stat = lstatSync(file);
      return { file, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    });
    for (const entry of directories) requireDirectory(entry);
    workspaces.set(workspace, { parent, temporaryRoot, current: input.current, reserveStorage: input.reserveStorage, maximum: input.maxBytes, charged: total, directories: physicalRoots, identities });
    return workspace;
  } catch (error) {
    // No child has been exposed. Remove only the same bounded fresh namespace we created, never a replacement.
    for (const entry of directories) requireDirectory(entry);
    const ownedDirs = new Map(directories.map(entry => [entry.file, entry]));
    const check = (directory: string) => {
      const handle = opendirSync(directory);
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          const file = join(directory, entry.name), ownedDirectory = ownedDirs.get(file), ownedFile = setupFiles.get(file);
          if (ownedDirectory) { requireDirectory(ownedDirectory); check(file); }
          else {
            const stat = lstatSync(file);
            if (!ownedFile || !stat.isFile() || stat.nlink !== 1 || stat.dev !== ownedFile.dev || stat.ino !== ownedFile.ino) refused();
          }
        }
      } finally { handle.closeSync(); }
    };
    check(parent); requireDirectory(directories[0]!); rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

/** Narrow physical ownership only, usable after role/privacy withdrawal to stop our own resources. */
export function probeWorkspacePhysical(workspace: ProbeWorkspace): void {
  const state = workspaces.get(workspace); if (!state) refused();
  for (const directory of state.directories) requireDirectory(directory);
}
export function probeWorkspaceCurrent(workspace: ProbeWorkspace): void {
  const state = workspaces.get(workspace); if (!state) refused(); state.current();
  probeWorkspacePhysical(workspace);
  for (const entry of state.identities) {
    const stat = lstatSync(entry.file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size !== entry.size
      || stat.mtimeMs !== entry.mtimeMs || stat.ctimeMs !== entry.ctimeMs) refused();
  }
}
export function probeWorkspacePrivateRoot(workspace: ProbeWorkspace): string { probeWorkspaceCurrent(workspace); return workspaces.get(workspace)!.parent; }
export function probeWorkspaceTemporaryRoot(workspace: ProbeWorkspace): string { probeWorkspaceCurrent(workspace); return workspaces.get(workspace)!.temporaryRoot; }
/** Local conservative ceiling, called before the owner ledger's compound admission; never performs a second ledger effect. */
export function reserveProbeWorkspaceBytes(workspace: ProbeWorkspace, bytes: number): void {
  probeWorkspaceCurrent(workspace); const state = workspaces.get(workspace)!;
  if (!integer(bytes)) refused();
  if (state.charged + bytes > state.maximum) throw new ProbeToolRefusal("workspace_ceiling");
  state.charged += bytes;
}
export async function reserveProbeWorkspaceStorage(workspace: ProbeWorkspace, bytes: number): Promise<void> {
  reserveProbeWorkspaceBytes(workspace, bytes); const state = workspaces.get(workspace)!;
  await state.reserveStorage(bytes); state.current();
  probeWorkspaceCurrent(workspace);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// T3 (#1226): output collection and owned cleanup. Contract: docs/design/guidance-probes.md "T3 receipts, reconcile and cleanup contract".
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Collect a finished session's declared output into a manifest: every regular, link-count-1 file under the output root is read through its captured
 * identity and hashed, and the identity is re-checked after the read. Anything else (a symlink, a hardlink, a device, a directory entry the policy does not
 * declare, a file past the per-file cap, a file that changed while read) is recorded as an exclusion and is NOT hashed. Bytes past `maxBytes` are not read.
 * Reads only; it deletes nothing and follows no link.
 */
export function collectProbeOutput(workspace: ProbeWorkspace, maxBytes: number): { manifest: ProbeOutputManifestV1; scratchBytes: number } {
  probeWorkspacePhysical(workspace);
  const entries: ProbeOutputEntry[] = [], excluded: ProbeOutputExcluded[] = [];
  let total = 0;
  const declared = workspace.allowedWrites.filter(path => path === workspace.output || path.startsWith(workspace.output + "/"));
  const within = (file: string): boolean => declared.some(path => file === path || file.startsWith(path + "/"));
  const exclude = (relative: string, reason: ProbeExcludedReason): void => { if (excluded.length < PROBE_OUTPUT_LIMITS.entries) excluded.push({ relative, reason }); };
  const walk = (directory: string, depth: number): void => {
    if (depth > 8) return;
    const handle = opendirSync(directory);
    try {
      for (let item = handle.readSync(); item; item = handle.readSync()) {
        const file = join(directory, item.name), relative = file.slice(workspace.root.length + 1);
        const before = lstatSync(file, { throwIfNoEntry: false });
        if (!before) continue;
        if (before.isSymbolicLink()) { exclude(relative, "not_regular"); continue; }
        if (before.isDirectory()) { walk(file, depth + 1); continue; }
        if (!before.isFile()) { exclude(relative, "not_regular"); continue; }
        if (before.nlink !== 1) { exclude(relative, "linked"); continue; }
        if (!within(file)) { exclude(relative, "outside_declared_writes"); continue; }
        if (before.size > PROBE_OUTPUT_LIMITS.fileBytes) { exclude(relative, "over_file_cap"); continue; }
        if (entries.length >= PROBE_OUTPUT_LIMITS.entries) { exclude(relative, "over_entry_cap"); continue; }
        if (total + before.size > maxBytes) { exclude(relative, "over_file_cap"); continue; }
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
          const opened = fstatSync(fd);
          if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) { exclude(relative, "changed_while_read"); continue; }
          bytes = Buffer.alloc(Math.min(opened.size, PROBE_OUTPUT_LIMITS.fileBytes));
          let read = 0; while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length - read, read); if (n === 0) break; read += n; }
          const after = fstatSync(fd);
          if (read !== opened.size || after.size !== opened.size || after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs) { exclude(relative, "changed_while_read"); continue; }
        } finally { closeSync(fd); }
        entries.push({ relative, sha256: digest(bytes), bytes: bytes.length }); total += bytes.length;
      }
    } finally { handle.closeSync(); }
  };
  walk(workspace.output, 0);
  let scratch = 0;
  const measure = (directory: string, depth: number): void => {
    if (depth > 8) return;
    const handle = opendirSync(directory);
    try {
      for (let item = handle.readSync(); item; item = handle.readSync()) {
        const file = join(directory, item.name), stat = lstatSync(file, { throwIfNoEntry: false });
        if (!stat) continue;
        if (stat.isDirectory()) measure(file, depth + 1); else if (stat.isFile()) scratch += stat.size;
      }
    } finally { handle.closeSync(); }
  };
  measure(workspace.scratch, 0);
  entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  return { manifest: { v: 1, entries, excluded, totalBytes: total }, scratchBytes: scratch };
}

/** A retained output directory the host itself created, with the identity it recorded at creation. Prune acts on nothing else. */
export type ProbeRetained = ProbeRetainedRecord;

/**
 * Copy the collected output into a fresh host-owned retention directory (mode 0700, O_EXCL files, link count 1) and return what was created. The retention
 * directory is outside the workspace so the workspace can be released at once; what is retained is exactly the manifest's entries, nothing else.
 */
export function retainProbeOutput(workspace: ProbeWorkspace, manifest: ProbeOutputManifestV1, root: string): ProbeRetained {
  probeWorkspacePhysical(workspace);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = realPath(mkdtempSync(join(root, "retained-")));
  const identity = directoryIdentity(directory);
  chmodSync(directory, 0o700);
  const files: { relative: string; dev: number; ino: number; bytes: number; ctimeNs: string }[] = [];
  try {
    for (const entry of manifest.entries) {
      const source = join(workspace.root, entry.relative);
      const before = lstatSync(source);
      if (!before.isFile() || before.nlink !== 1 || before.size !== entry.bytes) refused();
      const bytes = readFileSync(source);
      if (digest(bytes) !== entry.sha256) refused();
      // The manifest already holds only workspace-relative names; refuse anything that could leave the retention directory before joining.
      if (!probeRelativePath(entry.relative)) refused();
      const dest = join(directory, entry.relative);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      const fd = openSync(dest, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
      try { writeFileSync(fd, bytes); const created = fstatSync(fd, { bigint: true }); files.push({ relative: entry.relative, dev: Number(created.dev), ino: Number(created.ino), bytes: bytes.length, ctimeNs: created.ctimeNs.toString() }); }
      finally { closeSync(fd); }
    }
  } catch (error) {
    // Remove only what this call created, by identity, never a replaced name.
    removeRetained({ directory, dev: identity.dev, ino: identity.ino, files }, true);
    throw error;
  }
  return Object.freeze({ directory, dev: identity.dev, ino: identity.ino, files: Object.freeze(files.map(item => Object.freeze(item))) });
}

/** What a prune would remove from one retained directory, and why anything is kept. Read-only. */
export function previewRetained(retained: ProbeRetained): { remove: { relative: string; bytes: number }[]; keep: { relative: string; reason: string }[] } {
  const remove: { relative: string; bytes: number }[] = [], keep: { relative: string; reason: string }[] = [];
  const root = lstatSync(retained.directory, { throwIfNoEntry: false });
  if (!root || !root.isDirectory() || root.isSymbolicLink() || root.dev !== retained.dev || root.ino !== retained.ino) {
    return { remove, keep: [{ relative: ".", reason: "directory_replaced_or_missing" }] };
  }
  for (const file of retained.files) {
    const stat = lstatSync(join(retained.directory, file.relative), { throwIfNoEntry: false, bigint: true });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || Number(stat.dev) !== file.dev || Number(stat.ino) !== file.ino || stat.ctimeNs.toString() !== file.ctimeNs) keep.push({ relative: file.relative, reason: "identity_changed" });
    else remove.push({ relative: file.relative, bytes: Number(stat.size) });
  }
  return { remove, keep };
}

/**
 * Remove only the files and directories this host created, each verified by captured device and inode at the moment of removal. A name that is a
 * replacement, a symlink, a hardlink or a bystander is left exactly where it is. Never recurses through a name it did not create and never follows a link.
 * Returns what it removed and what it kept; a retained name makes the directory itself stay.
 */
export function removeRetained(retained: ProbeRetained, partial = false): { removed: string[]; kept: { relative: string; reason: string }[] } {
  const removed: string[] = [], kept: { relative: string; reason: string }[] = [];
  const root = lstatSync(retained.directory, { throwIfNoEntry: false });
  if (!root || !root.isDirectory() || root.isSymbolicLink() || root.dev !== retained.dev || root.ino !== retained.ino) {
    return { removed, kept: [{ relative: ".", reason: "directory_replaced_or_missing" }] };
  }
  const parents = new Set<string>();
  for (const file of retained.files) {
    const path = join(retained.directory, file.relative), stat = lstatSync(path, { throwIfNoEntry: false, bigint: true });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || Number(stat.dev) !== file.dev || Number(stat.ino) !== file.ino || stat.ctimeNs.toString() !== file.ctimeNs) { kept.push({ relative: file.relative, reason: "identity_changed" }); continue; }
    unlinkSync(path); removed.push(file.relative);
    for (let parent = dirname(path); parent !== retained.directory && parent.startsWith(retained.directory + "/"); parent = dirname(parent)) parents.add(parent);
  }
  // Directories this call may have created: removed only if now empty, deepest first; a non-empty one holds a bystander and stays.
  for (const parent of [...parents].sort((a, b) => b.length - a.length)) { try { rmdirSync(parent); } catch { kept.push({ relative: parent.slice(retained.directory.length + 1), reason: "not_empty" }); } }
  if (kept.length === 0 || partial) { try { rmdirSync(retained.directory); } catch { kept.push({ relative: ".", reason: "not_empty" }); } }
  return { removed, kept };
}
