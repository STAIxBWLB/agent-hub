import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Stamps record a human source review, not an automatic proof of the prose.
const args = process.argv.slice(2);
const requireFresh = args.includes("--require-fresh");
const jsonOutput = args.includes("--json");
const committed = args.includes("--committed");
const root = resolve(args.find((arg) => !["--require-fresh", "--json", "--committed"].includes(arg)) ?? fileURLToPath(new URL("..", import.meta.url)));
const errors = [];
const reports = [];
const documents = [];
let headId;
let packageVersion;
// Node-side equivalent of hub/git.ts: a readback must not execute repository-configured helpers.
const safeGitConfig = ["core.fsmonitor=false", "core.hooksPath=/dev/null", "diff.external=", "core.pager=cat", "credential.helper=", "core.askpass="];
const git = (...args) => spawnSync("git", ["--no-pager", ...safeGitConfig.flatMap(value => ["-c", value]), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 2000, maxBuffer: 256 * 1024 });
const read = (path) => {
  if (!committed) return readFileSync(join(root, path), "utf8");
  const result = git("show", `${headId}:${path}`);
  if (result.status !== 0) throw new Error("committed documentation evidence unavailable");
  return result.stdout;
};
const safePath = (path) => typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.startsWith("-") && !path.split("/").includes("..") && !path.includes("\\") && !path.includes(":");

try {
  if (committed) {
    const head = git("rev-parse", "--verify", "HEAD");
    if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) throw new Error("HEAD does not resolve");
    headId = head.stdout.trim();
    const dirty = git("status", "--porcelain", "--untracked-files=all", "--", "docs", "README.md", "package.json");
    if (dirty.status !== 0 || dirty.stdout) errors.push("documentation evidence files are dirty or unavailable");
  }
  const manifest = JSON.parse(read("docs/verified.json"));
  if (manifest.schemaVersion !== 1 || !manifest.documents || typeof manifest.documents !== "object" || Array.isArray(manifest.documents)) throw new Error("invalid docs/verified.json schema");
  const required = ["README.md", "docs/security.md", "docs/operations.md", "docs/quickstart.md", ...readdirSync(join(root, "docs/agent-notes")).filter((name) => name.endsWith(".md")).map((name) => `docs/agent-notes/${name}`)];
  for (const path of required.sort()) if (!Object.hasOwn(manifest.documents, path)) errors.push(`missing manifest entry: ${path}`);
  const pkg = JSON.parse(read("package.json"));
  if (typeof pkg.version === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:[+][0-9A-Za-z.-]+)?$/.test(pkg.version)) packageVersion = pkg.version;
  const version = read("README.md").match(/^Status: ([^,\s]+),/m)?.[1];
  if (version !== pkg.version) errors.push(`README status version ${version ?? "missing"} differs from package.json ${pkg.version}`);
  const head = git("rev-parse", "--verify", "HEAD");
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) throw new Error("HEAD does not resolve");
  if (committed && headId !== head.stdout.trim()) throw new Error("HEAD changed during documentation readback");
  headId = head.stdout.trim();
  for (const [doc, entry] of Object.entries(manifest.documents).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const record = { ...(safePath(doc) ? { path: doc } : {}), state: "unknown" }; documents.push(record);
    if (!safePath(doc) || !existsSync(join(root, doc)) || !statSync(join(root, doc)).isFile()) { errors.push(`missing or invalid document: ${doc}`); continue; }
    const stamp = entry?.verifiedAgainst;
    if (typeof stamp !== "string" || !/^[0-9a-f]{40}$/.test(stamp) || git("cat-file", "-e", `${stamp}^{commit}`).status !== 0) { errors.push(`${doc}: verified commit does not resolve: ${String(stamp)}`); continue; }
    record.verifiedAgainst = stamp;
    if (git("merge-base", "--is-ancestor", stamp, "HEAD").status !== 0) { record.state = "nonancestor"; errors.push(`${doc}: verified commit is not an ancestor of HEAD: ${stamp}`); continue; }
    if (!Array.isArray(entry.paths) || entry.paths.length === 0 || entry.paths.some((path) => !safePath(path))) { errors.push(`${doc}: invalid covered paths`); continue; }
    let valid = true;
    for (const path of entry.paths) {
      // Git pathspecs let a scope cover a directory or an explicit wildcard (upgrade*.ts).
      if (!/[?*\[]/.test(path) && existsSync(join(root, path))) continue;
      const files = git("ls-files", "-z", "--", path);
      const matches = files.stdout.split("\0").filter(Boolean);
      if (files.status !== 0 || matches.length === 0 || matches.some((file) => !existsSync(join(root, file)))) { errors.push(`${doc}: covered path no longer exists: ${path}`); valid = false; }
    }
    if (!valid) continue;
    const count = git("rev-list", "--count", `${stamp}..HEAD`, "--", ...entry.paths);
    const dirty = git("status", "--porcelain", "--untracked-files=all", "--", ...entry.paths);
    if (count.status !== 0 || dirty.status !== 0) { errors.push(`${doc}: cannot compute source drift`); continue; }
    const commits = Number(count.stdout.trim());
    if (!Number.isSafeInteger(commits) || commits < 0) { errors.push(`${doc}: invalid source commit count`); continue; }
    record.commits = commits; record.dirty = !!dirty.stdout; record.state = commits || dirty.stdout ? "stale" : "fresh";
    if (commits || dirty.stdout) reports.push(`${doc}: stale (${commits} source commit${commits === 1 ? "" : "s"}${dirty.stdout ? "; uncommitted source changes" : ""})`);
  }
} catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
if (!jsonOutput) for (const report of reports) console.log(`docs: ${report}`);
if (requireFresh && reports.length) errors.push("release requires fresh documentation stamps");
if (requireFresh && errors.length) errors.push("release refused: merge the release PR with a merge commit and verify all documentation stamps before tagging");
if (jsonOutput) console.log(JSON.stringify({ schemaVersion: 1, ...(headId ? { head: headId } : {}), ...(packageVersion ? { version: packageVersion } : {}), documents, errors: errors.length, fresh: !errors.length && !reports.length }));
else for (const error of errors) console.error(`docs: ERROR ${error}`);
if (errors.length) process.exitCode = 1;
else if (!jsonOutput) console.log(`docs: OK (${reports.length} stale document${reports.length === 1 ? "" : "s"})`);
