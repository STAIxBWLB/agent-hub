import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hubGitSync } from "./git.ts";
import { sanitize } from "./envelope.ts";
import { foldSegment } from "./permission-mode.ts";
import { isDenied } from "../local/deny.ts";
import { MAX_PROJECTION_INPUT, type TextProjections } from "./text-projection.ts";
import { repoGitArgs, repoGitEnv, type Repo } from "./snapshots.ts";

export const PROJECTED_DIFF_BYTES = 12000;
const MAX_FILES = 8, DIFF_MS = 8000;
const HEADER = "Projected text only (authorship and raw restore safety are independent):";
const treeId = (tree: string) => /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(tree);
export function projectionPath(repo: Repo, path: string, deny: string[] = []): boolean {
  const parts = path.split("/"), folded = parts.map(foldSegment).join("/");
  return !!path && !path.startsWith("/") && path.startsWith(repo.prefix) && parts.every(part => !!part && part !== "." && part !== ".." && ![".git", ".agenthub"].includes(foldSegment(part))) && !isDenied(path, deny) && !isDenied(folded, deny.map(foldSegment));
}
/** null is an absent file; undefined is unavailable evidence or a non-regular object. */
export function snapshotBytes(repo: Repo, tree: string, path: string, deadline = performance.now() + DIFF_MS): Buffer | null | undefined {
  if (!treeId(tree) || !projectionPath(repo, path) || performance.now() >= deadline) return undefined;
  const run = (args: string[], encoding: "utf8" | "latin1" = "utf8", maxBuffer = 8192) => hubGitSync(repoGitArgs(repo, args), { encoding, maxBuffer, timeout: Math.ceil(Math.max(1, Math.min(DIFF_MS, deadline - performance.now()))), env: repoGitEnv(repo) });
  const entry = run(["ls-tree", "-z", tree, "--", `:(literal)${path}`]);
  if (entry.status !== 0) return undefined;
  if (!entry.stdout) return null;
  const match = /^(100644|100755) blob ([a-f0-9]+)\t/.exec(entry.stdout);
  if (!match || entry.stdout.slice(match[0].length) !== path + "\0" || !treeId(match[2]!)) return undefined;
  if (performance.now() >= deadline) return undefined;
  const size = run(["cat-file", "-s", match[2]!]);
  const length = Number(size.stdout.trim());
  if (size.status !== 0 || !Number.isSafeInteger(length) || length < 0 || length > MAX_PROJECTION_INPUT || performance.now() >= deadline) return undefined;
  // Latin1 preserves all byte values through the existing bounded git wrapper.
  const blob = run(["cat-file", "blob", match[2]!], "latin1", MAX_PROJECTION_INPUT + 1);
  if (blob.status !== 0 || blob.stdout.length !== length) return undefined;
  return Buffer.from(blob.stdout, "latin1");
}
function hunks(repo: Repo, before: string, after: string, deadline: number): string | undefined {
  if (performance.now() >= deadline) return undefined;
  const scratch = mkdtempSync(join(tmpdir(), "ahub-projected-diff-"));
  try {
    const a = join(scratch, "before"), b = join(scratch, "after"); writeFileSync(a, before, { mode: 0o600 }); writeFileSync(b, after, { mode: 0o600 });
    const diff = hubGitSync(repoGitArgs(repo, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=2", "--", a, b]), { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: Math.ceil(Math.max(1, Math.min(DIFF_MS, deadline - performance.now()))), env: repoGitEnv(repo) });
    if (diff.status !== 0 && diff.status !== 1) return undefined;
    const start = diff.stdout.indexOf("@@");
    if (start < 0) return diff.status === 0 ? "(projected text unchanged)" : undefined;
    return diff.stdout.slice(start).replace(/\n$/, "");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
/** Presentation of checked snapshot bytes, never evidence of authorship or restore safety. */
export function projectedDiff(options: { repo: Repo; from: string; to: string; paths: string[]; projections: TextProjections; deny?: string[]; privatePath?: (path: string) => boolean; nameable?: (text: string) => boolean }): string | undefined {
  const { repo, projections } = options;
  if (!projections.enabled) return undefined;
  const deadline = performance.now() + DIFF_MS, rows: string[] = []; let bytes = Buffer.byteLength(HEADER) + 1, files = 0;
  const add = (text: string) => { const safe = sanitize(text); if (bytes + Buffer.byteLength(safe) + 1 > PROJECTED_DIFF_BYTES) return false; rows.push(safe); bytes += Buffer.byteLength(safe) + 1; return true; };
  for (const path of [...new Set(options.paths)]) {
    if (!projections.handles(path) || !projectionPath(repo, path, options.deny) || options.nameable?.(path) === false) continue;
    if (files++ >= MAX_FILES || performance.now() >= deadline) { add("(remaining projection previews omitted: count or time limit)"); break; }
    if (options.privatePath?.(path)) { if (!add(`${path}: (projection withheld: private path)`)) break; continue; }
    const before = snapshotBytes(repo, options.from, path, deadline), after = snapshotBytes(repo, options.to, path, deadline);
    if (before === undefined || after === undefined) { if (!add(`${path}: (projection unavailable: snapshot file is unknown)`)) break; continue; }
    if (before === null && after === null) { if (!add(`${path}: (projection unavailable: file is absent from both snapshots)`)) break; continue; }
    const a = before === null ? null : projections.projectBytes(join(repo.top, path), before, deadline);
    if (a === undefined) continue;
    const b = after === null ? null : projections.projectBytes(join(repo.top, path), after, deadline);
    if (a === undefined || b === undefined) continue; // converter failure keeps the ordinary file-only view
    if (a && b && a.configHash !== b.configHash) { if (!add(`${path}: (projection unavailable: converter changed during comparison)`)) break; continue; }
    const diff = hunks(repo, a?.text ?? "", b?.text ?? "", deadline);
    if (diff === undefined) { if (!add(`${path}: (projection unavailable: diff could not be read)`)) break; continue; }
    const text = options.nameable?.(diff) === false ? `${path}: (projection withheld: private-data pattern)` : `${path}:\n${diff}`;
    if (!add(text)) { add("(remaining projection previews omitted: output limit)"); break; }
  }
  return rows.length ? `${HEADER}\n${rows.join("\n")}` : undefined;
}
