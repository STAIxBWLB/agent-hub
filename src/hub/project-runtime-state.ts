import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { Project } from "./registry.ts";
import { configRepositoryPresent } from "./config-trust.ts";
import { childEnv } from "./child-process.ts";
import { hubGitSync } from "./git.ts";

export type RuntimeProject = Pick<Project, "id" | "root" | "stateDir">;
export interface ProjectRuntimeSelection { version: string; root: string; digest: string; kind: "restart" | "upgrade" }
export interface ProjectRuntimeIdentity extends ProjectRuntimeSelection {
  schema: 1; projectId: string; projectRoot: string; stateDir: string; instanceId: string | null;
}
export const PROJECT_RUNTIME_FILE = "runtime.json";
const LIMIT = 16 * 1024;
// ponytail: three opens bound publication churn; use snapshots bound to publication generations if continuous writers need progress.
const RUNTIME_REFERENCE_READ_ATTEMPTS = 3;
const version = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.exec(v)?.[0] === v;
const pathText = (v: unknown): v is string => typeof v === "string" && v.length <= 4096 && isAbsolute(v) && normalize(v) === v && !/[\x00-\x1f\x7f]/.test(v);
export const projectRuntimeFile = (project: RuntimeProject): string => join(project.stateDir, PROJECT_RUNTIME_FILE);
const invalid = (): Error => new Error("project runtime record is invalid; inspect runtime.json before starting");

export function parseProjectRuntime(project: RuntimeProject, input: unknown): ProjectRuntimeIdentity {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const row = input as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "digest,instanceId,kind,projectId,projectRoot,root,schema,stateDir,version"
    || row.schema !== 1 || row.projectId !== project.id || row.projectRoot !== project.root || row.stateDir !== project.stateDir
    || !version(row.version) || !pathText(row.root) || typeof row.digest !== "string" || row.digest.length !== 64 || !/^[a-f0-9]{64}$/.test(row.digest)
    || row.kind !== "restart" && row.kind !== "upgrade"
    || row.instanceId !== null && (typeof row.instanceId !== "string" || /^[a-zA-Z0-9-]{1,128}$/.exec(row.instanceId)?.[0] !== row.instanceId)) throw invalid();
  return { schema: 1, projectId: project.id, projectRoot: project.root, stateDir: project.stateDir,
    version: row.version, root: row.root, digest: row.digest, kind: row.kind, instanceId: row.instanceId as string | null };
}

const ACCESS = Symbol("project runtime access");
export interface ProjectRuntimeAccess {
  readonly [ACCESS]: true;
  readonly projectId: string; readonly projectRoot: string; readonly stateDir: string;
  read(): ProjectRuntimeIdentity | undefined;
  write(runtime: ProjectRuntimeSelection, instanceId: string | null): ProjectRuntimeIdentity;
}
const TRUST_GIT_MS = 2000;
const exactGlob = (value: string) => value.replace(/([*?[\]\\])/g, "\\$1");
const trustRefusal = (why: string): never => { throw new Error(`project runtime selection is machine-local: ${why}`); };

/** Plain folders remain supported. A repository must affirm this file is untracked using only its parent/ancestor paths. */
function requireRuntimeTrust(project: RuntimeProject): void {
  const file = projectRuntimeFile(project), checked = new Set<string>(), deadline = performance.now() + TRUST_GIT_MS;
  const git = (args: string[]) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) trustRefusal("git could not confirm runtime.json is untracked");
    return hubGitSync(args, { encoding: "utf8", env: childEnv(process.env), timeout: Math.max(1, Math.ceil(remaining)), maxBuffer: 256 * 1024 });
  };
  for (const cwd of new Set([project.root, dirname(file)])) {
    if (!configRepositoryPresent(cwd)) continue;
    let at = cwd;
    while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
    const top = git(["-C", at, "rev-parse", "--show-toplevel"]);
    if (top.status !== 0 || !isAbsolute(top.stdout.trim())) trustRefusal("git could not confirm runtime.json is untracked");
    const root = top.stdout.trim(), selected = relative(root, file).split(sep).join("/");
    if (checked.has(root) || selected === ".." || selected.startsWith("../") || isAbsolute(selected)) continue;
    checked.add(root);
    const parts = selected.split("/"), parent = parts.slice(0, -1).join("/");
    // ponytail: explicit custom stateDir ancestor listings can exceed 256 KiB (default unaffected); use an untracked dedicated state directory, then upgrade to exact ancestor index lookup.
    const specs = [`:(icase,literal)${parent || selected}`];
    for (let i = 1; i < parts.length - 1; i++) specs.push(`:(icase,glob)${exactGlob(parts.slice(0, i).join("/"))}`);
    const tracked = git(["-C", root, "ls-files", "-s", "-z", "--", ...specs]);
    if (tracked.status !== 0) trustRefusal("git could not confirm runtime.json is untracked");
    let opened: { dev: number; ino: number } | undefined;
    try { opened = statSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") trustRefusal("runtime.json identity is unavailable"); }
    for (const row of tracked.stdout.split("\0").filter(Boolean)) {
      const name = row.slice(row.indexOf("\t") + 1);
      if (name === selected || selected.startsWith(`${name}/`)) trustRefusal("runtime.json or its parent is committed to git");
      if (opened) {
        let info; try { info = statSync(join(root, name)); } catch { continue; }
        if (info.dev === opened.dev && info.ino === opened.ino) trustRefusal("runtime.json is committed to git");
      }
    }
  }
}

/** This reserved sibling namespace is exclusively for captures withdrawn for pruning. */
export function assertExecutableRuntimeRoot(root: string): void {
  for (let at = root; ; at = dirname(at)) {
    if (basename(at).startsWith(".runtime-prune-")) throw new Error("runtime root is quarantined for pruning");
    if (dirname(at) === at) return;
  }
}

/** Host-only, project-bound admission for one call; callers create it before acquiring the registry lock. */
export function createProjectRuntimeAccess(project: RuntimeProject): ProjectRuntimeAccess {
  requireRuntimeTrust(project);
  const bound = { id: project.id, root: project.root, stateDir: project.stateDir };
  return Object.freeze({ [ACCESS]: true as const, projectId: bound.id, projectRoot: bound.root, stateDir: bound.stateDir,
    read: () => readProjectRuntimeReference(bound), write: (runtime: ProjectRuntimeSelection, instanceId: string | null) => writeRuntimeState(bound, runtime, instanceId) });
}
function accessFor(project: RuntimeProject, access?: ProjectRuntimeAccess): ProjectRuntimeAccess {
  if (!access) return createProjectRuntimeAccess(project);
  if (access[ACCESS] !== true || access.projectId !== project.id || access.projectRoot !== project.root || access.stateDir !== project.stateDir)
    throw new Error("project runtime access belongs to another project");
  return access;
}

export function readProjectRuntime(project: RuntimeProject, access?: ProjectRuntimeAccess): ProjectRuntimeIdentity | undefined {
  return accessFor(project, access).read();
}

function runtimeReferenceReplaced(file: string, opened: Stats): boolean {
  let named: Stats;
  try { named = lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && opened.nlink === 0) return true;
    throw invalid();
  }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > LIMIT) throw invalid();
  const replaced = opened.nlink === 0 || named.dev !== opened.dev || named.ino !== opened.ino;
  if (!replaced && (named.size !== opened.size || named.mtimeMs !== opened.mtimeMs || named.ctimeMs !== opened.ctimeMs)) throw invalid();
  return replaced;
}

/** Metadata-only retention reference: bounded binding/JSON checks confer no Git trust or execution authority. */
export function readProjectRuntimeReference(project: RuntimeProject): ProjectRuntimeIdentity | undefined {
  const file = projectRuntimeFile(project);
  for (let attempt = 0; attempt < RUNTIME_REFERENCE_READ_ATTEMPTS; attempt++) {
    let fd: number;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && attempt === 0) return undefined; throw invalid(); }
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > LIMIT) throw invalid();
      if (before.nlink !== 1) {
        if (before.nlink === 0 && runtimeReferenceReplaced(file, before)) continue;
        throw invalid();
      }
      const bytes = Buffer.alloc(LIMIT + 1);
      const count = readSync(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd);
      if (!after.isFile() || after.nlink !== 0 && after.nlink !== 1) throw invalid();
      if (runtimeReferenceReplaced(file, after)) continue;
      if (count > LIMIT || count !== before.size || after.nlink !== 1 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw invalid();
      return parseProjectRuntime(project, JSON.parse(bytes.subarray(0, count).toString("utf8")));
    } catch { throw invalid(); }
    finally { closeSync(fd); }
  }
  throw invalid();
}

/** Caller holds the shared runtime-capture lock until publication and its launch/reference effects finish. */
function writeRuntimeState(project: RuntimeProject, runtime: ProjectRuntimeSelection, instanceId: string | null): ProjectRuntimeIdentity {
  const record = parseProjectRuntime(project, { schema: 1, projectId: project.id, projectRoot: project.root, stateDir: project.stateDir,
    version: runtime.version, root: runtime.root, digest: runtime.digest, kind: runtime.kind, instanceId });
  assertExecutableRuntimeRoot(record.root);
  readProjectRuntimeReference(project); // refuse to overwrite an unknown binding or an unsafe file
  const body = JSON.stringify(record);
  if (Buffer.byteLength(body) > LIMIT) throw invalid();
  mkdirSync(project.stateDir, { recursive: true });
  const file = projectRuntimeFile(project), temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, body, { mode: 0o600, flag: "wx" }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
  return record;
}

export function writeProjectRuntimeState(project: RuntimeProject, runtime: ProjectRuntimeSelection, instanceId: string | null, access?: ProjectRuntimeAccess): ProjectRuntimeIdentity {
  return accessFor(project, access).write(runtime, instanceId);
}
