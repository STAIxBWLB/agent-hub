import type { SdlcGh } from "./sdlc.ts";
import { GITHUB_PAGE_SIZE } from "./github-import.ts";

/** Create or recover one PR for a previously pushed, host-verified managed branch. */
export async function managedTaskPullRequest(input: { repo: string; branch: string; commit: string; task: number; issue?: number; current: () => void }, run: SdlcGh): Promise<number> {
  const { repo, branch, commit, task, issue, current } = input;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) || !Number.isSafeInteger(task) || task < 1 || !/^task\/[1-9][0-9]*-[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(branch) || !branch.startsWith(`task/${task}-`) || !/^[a-f0-9]{40}$/.test(commit) || issue !== undefined && (!Number.isSafeInteger(issue) || issue < 1)) throw new Error("managed PR identity is invalid; inspect the task and retry");
  const target = `github.com/${repo}`;
  const call: SdlcGh = async (args, timeout, cwd, cap) => { current(); const result = await run(args, timeout, cwd, cap); current(); return result; };
  const lookup = async (): Promise<{ number: number; draft: boolean } | undefined> => {
    const reply = await call(["pr", "list", "--repo", target, "--state", "open", "--head", branch, "--limit", String(GITHUB_PAGE_SIZE), "--json", "number,headRefName,headRefOid,headRepository,isCrossRepository,isDraft,state"], 10_000, undefined, 256 * 1024);
    if (reply.code !== 0) throw new Error("managed PR lookup unavailable; inspect GitHub and retry hub_task_done");
    let rows: unknown; try { rows = JSON.parse(reply.stdout); } catch { throw new Error("managed PR lookup malformed; inspect GitHub and retry hub_task_done"); }
    if (!Array.isArray(rows) || rows.length >= GITHUB_PAGE_SIZE) throw new Error("managed PR lookup incomplete; inspect GitHub and retry hub_task_done");
    if (!rows.length) return undefined;
    if (rows.length !== 1) throw new Error("managed branch has multiple open PRs; inspect GitHub before retrying");
    const row = rows[0];
    const name = (value: unknown) => value && typeof value === "object" && typeof (value as { nameWithOwner?: unknown }).nameWithOwner === "string" ? (value as { nameWithOwner: string }).nameWithOwner.toLowerCase() : undefined;
    if (!Number.isSafeInteger(row?.number) || row.number < 1 || row.state !== "OPEN" || row.headRefName !== branch || row.headRefOid !== commit || typeof row.isDraft !== "boolean" || row.isCrossRepository !== false || name(row.headRepository) !== repo.toLowerCase()) throw new Error("managed PR identity or head is unavailable; inspect GitHub before retrying");
    return { number: row.number, draft: row.isDraft };
  };
  let found = await lookup();
  if (!found) {
    const meta = await call(["api", `repos/${repo}`, "--hostname", "github.com", "--jq", ".default_branch"], 10_000, undefined, 4096);
    const base = meta.stdout.trim();
    if (meta.code !== 0 || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(base) || base.includes("..") || base.endsWith("/")) throw new Error("managed PR base branch unavailable; inspect GitHub before retrying");
    const body = [`hub task ${task}`, ...(issue === undefined ? [] : [`Refs #${issue}`])].join("\n\n");
    const created = await call(["pr", "create", "--repo", target, "--head", branch, "--base", base, "--title", `hub task ${task}`, "--body", body, "--draft"], 10_000, undefined, 4096);
    if (created.code !== 0) throw new Error("managed PR creation was not confirmed; inspect GitHub before retrying hub_task_done");
    found = await lookup();
    if (!found) throw new Error("managed PR creation was not found; inspect GitHub before retrying hub_task_done");
  }
  if (found.draft) {
    const ready = await call(["pr", "ready", String(found.number), "--repo", target], 10_000, undefined, 4096);
    if (ready.code !== 0) throw new Error("managed PR readiness was not confirmed; inspect GitHub before retrying hub_task_done");
    const verified = await lookup();
    if (!verified || verified.number !== found.number || verified.draft) throw new Error("managed PR readiness or head changed; inspect GitHub before retrying hub_task_done");
  }
  return found.number;
}
