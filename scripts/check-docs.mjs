import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Stamps record a human source review, not an automatic proof of the prose.
const root = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const errors = [];
const reports = [];
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const read = (path) => readFileSync(join(root, path), "utf8");
const safePath = (path) => typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.startsWith("-") && !path.split("/").includes("..") && !path.includes("\\") && !path.includes(":");

try {
  const manifest = JSON.parse(read("docs/verified.json"));
  if (manifest.schemaVersion !== 1 || !manifest.documents || typeof manifest.documents !== "object" || Array.isArray(manifest.documents)) throw new Error("invalid docs/verified.json schema");
  const required = ["README.md", "docs/security.md", "docs/operations.md", "docs/quickstart.md", ...readdirSync(join(root, "docs/agent-notes")).filter((name) => name.endsWith(".md")).map((name) => `docs/agent-notes/${name}`)];
  for (const path of required.sort()) if (!Object.hasOwn(manifest.documents, path)) errors.push(`missing manifest entry: ${path}`);
  const pkg = JSON.parse(read("package.json"));
  const version = read("README.md").match(/^Status: ([^,\s]+),/m)?.[1];
  if (version !== pkg.version) errors.push(`README status version ${version ?? "missing"} differs from package.json ${pkg.version}`);
  const head = git("rev-parse", "--verify", "HEAD");
  if (head.status !== 0) throw new Error("HEAD does not resolve");
  for (const [doc, entry] of Object.entries(manifest.documents).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!safePath(doc) || !existsSync(join(root, doc)) || !statSync(join(root, doc)).isFile()) { errors.push(`missing or invalid document: ${doc}`); continue; }
    const stamp = entry?.verifiedAgainst;
    if (typeof stamp !== "string" || !/^[0-9a-f]{40}$/.test(stamp) || git("cat-file", "-e", `${stamp}^{commit}`).status !== 0) { errors.push(`${doc}: verified commit does not resolve: ${String(stamp)}`); continue; }
    if (git("merge-base", "--is-ancestor", stamp, "HEAD").status !== 0) { errors.push(`${doc}: verified commit is not an ancestor of HEAD: ${stamp}`); continue; }
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
    if (commits || dirty.stdout) reports.push(`${doc}: stale (${commits} source commit${commits === 1 ? "" : "s"}${dirty.stdout ? "; uncommitted source changes" : ""})`);
  }
} catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
for (const report of reports) console.log(`docs: ${report}`);
for (const error of errors) console.error(`docs: ERROR ${error}`);
if (errors.length) process.exitCode = 1;
else console.log(`docs: OK (${reports.length} stale document${reports.length === 1 ? "" : "s"})`);
