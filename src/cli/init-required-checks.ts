import { constants, openSync, fstatSync, readSync, closeSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { githubOriginRepository } from "../hub/task-repository.ts";
import { requiredChecksFor } from "../hub/sdlc-merge.ts";
import { hubGitSync } from "../hub/git.ts";
import { loadSdlc, sdlcGh, type SdlcGh } from "../hub/sdlc.ts";
import type { InitSettingsRequest } from "./init-settings.ts";

const DISCOVERY_DEADLINE_MS = 20_000;
const DISCOVERY_READ_MS = 5_000;
const DISCOVERY_BYTES = 512 * 1024;
const DISCOVERY_JOBS = 100;
const WORKFLOW_FILES = 32;
const WORKFLOW_BYTES = 256 * 1024;

export interface InitCheckDiscovery { names: string[]; source: "CI" | "workflows" | "unknown"; reason?: string }
const validNames = (names: unknown[]): names is string[] => names.length > 0 && names.length <= 32 && names.every(name => typeof name === "string" && name.trim() === name && name.length > 0 && name.length <= 120 && !/[\p{Cc}]/u.test(name));

/** Literal block-style jobs only. ponytail: expressions, matrices and YAML aliases need an explicit override until a bounded YAML resolver is specified. */
export function workflowCheckNames(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/), start = lines.findIndex(line => /^jobs:\s*(?:#.*)?$/.test(line));
  if (start < 0) return undefined;
  const names: string[] = [];
  let id: string | undefined, name: string | undefined, dynamic = false;
  const finish = () => { if (id) names.push(name ?? id); };
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#]/.test(line)) break;
    const job = /^  ([A-Za-z_][A-Za-z0-9_-]*):\s*(?:#.*)?$/.exec(line);
    if (job) { finish(); id = job[1]!; name = undefined; continue; }
    if (!id || !line.trim() || /^\s*#/.test(line)) continue;
    if (/^    (?:strategy|uses):/.test(line) || /^    <<:/.test(line)) dynamic = true;
    const named = /^    name:\s*(.*?)\s*$/.exec(line);
    if (named) {
      const raw = named[1]!;
      if (/\$\{|^[>|*&!{\[]/.test(raw)) { dynamic = true; continue; }
      try {
        if (raw.startsWith("'")) {
          const quoted = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(raw);
          if (!quoted) { dynamic = true; continue; }
          name = quoted[1]!.replaceAll("''", "'");
        } else if (raw.startsWith('"')) {
          const quoted = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(raw);
          if (!quoted) { dynamic = true; continue; }
          name = JSON.parse(quoted[1]!);
        } else name = raw.replace(/\s+#.*$/, "");
      } catch { dynamic = true; }
    }
    if (/^  \S/.test(line) && !job) dynamic = true;
  }
  finish();
  const unique = [...new Set(names)];
  return !dynamic && validNames(unique) ? unique : undefined;
}

function workflowChecks(cwd: string): InitCheckDiscovery {
  const unknown: InitCheckDiscovery = { names: [], source: "unknown", reason: "CI unavailable or workflows have no complete literal job names; pass --required-checks <a,b,...>" };
  const folder = join(cwd, ".github", "workflows");
  try {
    if (lstatSync(join(cwd, ".github")).isSymbolicLink() || lstatSync(folder).isSymbolicLink()) return unknown;
    const files = readdirSync(folder).filter(file => file.endsWith(".yml")).sort();
    if (!files.length || files.length > WORKFLOW_FILES) return unknown;
    const names: string[] = [];
    for (const file of files) {
      const fd = openSync(join(folder, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > WORKFLOW_BYTES) return unknown;
        const bytes = Buffer.alloc(WORKFLOW_BYTES + 1);
        let length = 0, count = 0;
        while ((count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) { length += count; if (length > WORKFLOW_BYTES) return unknown; }
        const after = fstatSync(fd);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || length !== after.size) return unknown;
        const text = bytes.subarray(0, length).toString("utf8");
        const found = workflowCheckNames(text);
        if (!found) return unknown;
        names.push(...found);
      } finally { closeSync(fd); }
    }
    const unique = [...new Set(names)];
    return validNames(unique) ? { names: unique, source: "workflows" } : unknown;
  } catch { return unknown; }
}

/** At most three capped reads under one deadline; any incomplete evidence falls back to bounded local workflow data. No shell or YAML execution. */
export async function discoverInitChecks(cwd: string, run: SdlcGh = sdlcGh): Promise<InitCheckDiscovery> {
  const deadline = performance.now() + DISCOVERY_DEADLINE_MS;
  try {
    const repo = githubOriginRepository(cwd);
    if (!repo) return workflowChecks(cwd);
    const read = async (args: string[]) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("discovery deadline");
      const reply = await run(args, Math.min(DISCOVERY_READ_MS, remaining), cwd, DISCOVERY_BYTES);
      if (reply.code !== 0 || Buffer.byteLength(reply.stdout) >= DISCOVERY_BYTES || performance.now() >= deadline) throw new Error("discovery unavailable");
      return JSON.parse(reply.stdout);
    };
    const local = hubGitSync(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd, encoding: "utf8", timeout: DISCOVERY_READ_MS });
    const remaining = deadline - performance.now();
    const target = local.status === 0 && remaining > 0 ? hubGitSync(["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"], { cwd, encoding: "utf8", timeout: Math.min(DISCOVERY_READ_MS, remaining) }) : undefined;
    let branch = local.status === 0 && target?.status === 0 ? local.stdout.trim().replace(/^refs\/remotes\/origin\//, "") : undefined;
    if (!branch) branch = (await read(["api", `repos/${repo}`])).default_branch;
    if (typeof branch !== "string" || !branch || /[\r\n]/.test(branch)) return workflowChecks(cwd);
    const runs = await read(["api", "--method", "GET", `repos/${repo}/actions/runs`, "-f", `branch=${branch}`, "-f", "status=completed", "-f", "per_page=1"]);
    const latest = runs.workflow_runs?.[0];
    if (!Number.isSafeInteger(latest?.id) || latest.id <= 0 || latest.status !== "completed" || latest.head_branch !== branch) return workflowChecks(cwd);
    const body = await read(["api", "--method", "GET", `repos/${repo}/actions/runs/${latest.id}/jobs`, "-f", `per_page=${DISCOVERY_JOBS}`]);
    const jobs = body.jobs;
    if (!Array.isArray(jobs) || body.total_count !== jobs.length || jobs.length >= DISCOVERY_JOBS) return workflowChecks(cwd);
    const names: unknown[] = [...new Set(jobs.map(job => job?.name))];
    return validNames(names) ? { names, source: "CI" } : workflowChecks(cwd);
  } catch { return workflowChecks(cwd); }
}

/** The CLI resolves discovery before preview or write; an override never contacts GitHub. */
export async function withInitChecks(cwd: string, request: InitSettingsRequest, discover = discoverInitChecks): Promise<InitSettingsRequest> {
  if (!["advise", "enforce"].includes(String(request.values["sdlc.mode"])) || Object.hasOwn(request.values, "sdlc.required_checks")) return request;
  if (requiredChecksFor(loadSdlc(cwd), githubOriginRepository(cwd)).length) return request;
  const result = await discover(cwd);
  if (!result.names.length && request.values["sdlc.mode"] === "enforce") throw new Error(`enforce needs required CI checks: ${result.reason}; nothing was written`);
  return { ...request, values: { ...request.values, "sdlc.required_checks": result.names } };
}
