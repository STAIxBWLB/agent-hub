import { createHash } from "node:crypto";
import { chmodSync, constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { executionText, EXECUTION_REFERENCE_LIMITS } from "../hub/execution-reference.ts";
import { hubGitSync } from "../hub/git.ts";
import { guidanceProbeCanonical, GUIDANCE_PROBE_LIMITS, type ProbeDataPolicyV1, type ProbeSlot, type ProbeTree } from "../hub/guidance-probes.ts";
import { foldSegment } from "../hub/permission-mode.ts";
import { realPath } from "../hub/project.ts";
import { isDenied } from "./deny.ts";

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
  if (!roleNames.includes(input.role) || !integer(input.maxBytes) || input.maxBytes > PROBE_WORKSPACE_LIMITS.workspaceBytes
    || typeof input.current !== "function" || typeof input.reserveStorage !== "function" || typeof input.verifySource !== "function") refused();
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
    const file = Object.freeze({ dataId: original.dataId, relative: original.relative, sha256: original.sha256, bytes: Buffer.from(original.bytes) });
    const admission = declared.get(file.dataId);
    if (!admission || !integer(admission.bytes) || admission.bytes !== file.bytes.length || admission.sha256 !== file.sha256
      || file.bytes.length > PROBE_WORKSPACE_LIMITS.fileBytes || digest(file.bytes) !== file.sha256) refused();
    seenIds.add(file.dataId); total += file.bytes.length;
    if (total > input.maxBytes) refused();
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
  if (!integer(bytes) || state.charged + bytes > state.maximum) refused();
  state.charged += bytes;
}
export async function reserveProbeWorkspaceStorage(workspace: ProbeWorkspace, bytes: number): Promise<void> {
  reserveProbeWorkspaceBytes(workspace, bytes); const state = workspaces.get(workspace)!;
  await state.reserveStorage(bytes); state.current();
  probeWorkspaceCurrent(workspace);
}
