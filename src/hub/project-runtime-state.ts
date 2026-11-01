import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import type { Project } from "./registry.ts";

export type RuntimeProject = Pick<Project, "id" | "root" | "stateDir">;
export interface ProjectRuntimeSelection { version: string; root: string; digest: string; kind: "restart" | "upgrade" }
export interface ProjectRuntimeIdentity extends ProjectRuntimeSelection {
  schema: 1; projectId: string; projectRoot: string; stateDir: string; instanceId: string | null;
}
export const PROJECT_RUNTIME_FILE = "runtime.json";
const LIMIT = 16 * 1024;
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

/** Missing is distinct from malformed, linked, oversized or unreadable state. */
export function readProjectRuntime(project: RuntimeProject): ProjectRuntimeIdentity | undefined {
  let fd: number;
  try { fd = openSync(projectRuntimeFile(project), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw invalid(); }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT) throw invalid();
    const bytes = Buffer.alloc(LIMIT + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd);
    if (count > LIMIT || count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw invalid();
    return parseProjectRuntime(project, JSON.parse(bytes.subarray(0, count).toString("utf8")));
  } catch { throw invalid(); }
  finally { closeSync(fd); }
}

/** Caller holds the shared runtime-capture lock until publication and its launch/reference effects finish. */
export function writeProjectRuntimeState(project: RuntimeProject, runtime: ProjectRuntimeSelection, instanceId: string | null): ProjectRuntimeIdentity {
  const record = parseProjectRuntime(project, { schema: 1, projectId: project.id, projectRoot: project.root, stateDir: project.stateDir,
    version: runtime.version, root: runtime.root, digest: runtime.digest, kind: runtime.kind, instanceId });
  readProjectRuntime(project); // refuse to overwrite an unknown binding or an unsafe file
  const body = JSON.stringify(record);
  if (Buffer.byteLength(body) > LIMIT) throw invalid();
  mkdirSync(project.stateDir, { recursive: true });
  const file = projectRuntimeFile(project), temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, body, { mode: 0o600, flag: "wx" }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
  return record;
}
