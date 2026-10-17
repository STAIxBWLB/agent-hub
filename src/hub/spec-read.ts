import { spawn } from "node:child_process";
import { hostExecutable } from "./host-executable.ts";
import type { Task } from "./board.ts";
import { childEnv, stopOwnedProcess, trackGroup } from "./child-process.ts";

const BODY_LIMIT = 64 * 1024, RESULT_LIMIT = 80 * 1024, STDOUT_LIMIT = 512 * 1024;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
export interface SpecResult { number: number; title: string; state: string; updated_at: string; html_url: string; body: string; }
/** PATH/shorter timeout are host-owned fixture seams, never tool inputs. */
export interface SpecOptions { path?: string; timeoutMs?: number; projectDir?: string; }
export interface FetchSpecOptions extends SpecOptions { screen: (whole: string) => boolean | Promise<boolean>; }
function validRepo(repo: string): void { if (!REPO.test(repo)) throw new Error("other repository"); }

/** Resolve only task-bound issue references; foreign references never fall through to local #N. */
export function specRefs(task: Pick<Task, "title" | "detail" | "refs"> & Partial<Pick<Task, "external">>, repo: string): number[] {
  const references: { repo?: string; number: number }[] = [];
  // Bare detail numbers name hub tasks. File paths are not issue references.
  for (const section of [{ text: task.title, bare: true }, { text: task.detail, bare: false }]) {
    for (const match of section.text.matchAll(/(?<![A-Za-z0-9_./-])(?:https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\b|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)\b|#([1-9][0-9]*)\b)/g)) {
      const qualified = match[1] ?? match[3];
      if (!qualified && !section.bare) continue;
      references.push({ repo: qualified, number: Number(match[2] ?? match[4] ?? match[5]) });
    }
  }
  if (!references.length && task.external === undefined && !task.refs.repo) return [];
  validRepo(repo);
  if (task.refs.repo && task.refs.repo.toLowerCase() !== repo.toLowerCase()) throw new Error("other repository");
  const issues = new Set<number>();
  if (task.external !== undefined) {
    const source = task.external;
    if (!source || source.provider !== "github" || typeof source.repo !== "string") throw new Error("not found");
    validRepo(source.repo);
    if (source.repo.toLowerCase() !== repo.toLowerCase()) throw new Error("other repository");
    if (!Number.isSafeInteger(source.issue) || source.issue < 1 || typeof source.url !== "string"
      || source.url.toLowerCase() !== `https://github.com/${repo}/issues/${source.issue}`.toLowerCase()) throw new Error("not found");
    issues.add(source.issue);
  }
  for (const reference of references) {
    if (reference.repo && reference.repo.toLowerCase() !== repo.toLowerCase()) throw new Error("other repository");
    if (!Number.isSafeInteger(reference.number)) throw new Error("not found");
    issues.add(reference.number);
    if (issues.size > 3) throw new Error("too many spec references");
  }
  return [...issues];
}

interface GhResult { code: number; stdout: string; }
/** One fixed-argv authenticated boundary, no shell, no retries and no retained stderr. */
function gh(args: string[], opts: SpecOptions): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...childEnv(), GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", ...(opts.path === undefined ? {} : { PATH: opts.path }) };
    if (opts.path !== undefined) {
      for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[key];
      env.GH_CONFIG_DIR = opts.path;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hostExecutable("gh", opts.projectDir ?? process.cwd(), opts.path ?? process.env.PATH), args, { env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
      trackGroup(child);
    }
    catch { reject(new Error("gh unavailable")); return; }
    let output: Buffer[] = [], size = 0, failure: string | undefined;
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason; output = [];
      void stopOwnedProcess(child, { group: true, termMs: 100, killMs: 500 }).catch(() => {});
    };
    const timeout = opts.timeoutMs === undefined || !Number.isFinite(opts.timeoutMs) ? 15_000 : Math.max(1, Math.min(15_000, opts.timeoutMs));
    const timer = setTimeout(() => stop("timeout"), timeout);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return;
      size += chunk.length;
      if (size > STDOUT_LIMIT) stop("too large"); else output.push(chunk);
    });
    child.once("error", () => { clearTimeout(timer); reject(new Error("gh unavailable")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (failure) reject(new Error(failure));
      else resolve({ code: code ?? 1, stdout: Buffer.concat(output).toString("utf8") });
    });
  });
}

/** Startup-only availability evidence; daemon caches it until restart. */
export async function specAvailable(opts: SpecOptions = {}): Promise<{ available: boolean; reason?: string }> {
  try {
    const result = await gh(["auth", "status", "--hostname", "github.com"], opts);
    return result.code === 0 ? { available: true } : { available: false, reason: "gh unauthenticated" };
  } catch (error) { return { available: false, reason: error instanceof Error ? error.message : "gh unavailable" }; }
}

export async function fetchSpec(repo: string, n: number, opts: FetchSpecOptions): Promise<SpecResult> {
  validRepo(repo);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("not found");
  const raw = await gh(["api", "-X", "GET", `repos/${repo}/issues/${n}`], opts);
  let value: unknown;
  try { value = JSON.parse(raw.stdout); } catch { throw new Error(raw.code === 4 ? "unauthenticated" : "not found"); }
  if (raw.code !== 0) {
    const status = (value as { status?: unknown })?.status;
    throw new Error(raw.code === 4 || status === 401 ? "unauthenticated" : "not found");
  }
  if (!value || typeof value !== "object") throw new Error("not found");
  const row = value as Record<string, unknown>;
  if (typeof row.repository_url !== "string" || row.repository_url.toLowerCase() !== `https://api.github.com/repos/${repo}`.toLowerCase()
    || typeof row.html_url !== "string" || ![`https://github.com/${repo}/issues/${n}`, `https://github.com/${repo}/pull/${n}`].some(url => row.html_url!.toString().toLowerCase() === url.toLowerCase())) throw new Error("other repository");
  if (row.number !== n || typeof row.title !== "string" || typeof row.state !== "string" || typeof row.updated_at !== "string" || (row.body !== null && typeof row.body !== "string")) throw new Error("not found");
  const result: SpecResult = { number: n, title: row.title, state: row.state, updated_at: row.updated_at, html_url: row.html_url, body: row.body ?? "" };
  const length = bytes(result.body);
  if (length > BODY_LIMIT) throw new Error(`spec too large (${length} > 65536); ask the reviewer to put the contract in the repo`);
  if (bytes(JSON.stringify(result)) > RESULT_LIMIT) throw new Error("too large");
  let allowed = false;
  try { allowed = await opts.screen(`${result.title}\n${result.body}`); } catch { /* policy unavailable withholds the entire spec */ }
  if (allowed !== true) throw new Error("spec withheld by privacy policy");
  return result;
}
