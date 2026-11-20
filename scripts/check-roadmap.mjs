import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2), committed = args.includes("--committed");
const root = resolve(args.find(arg => arg !== "--committed") ?? fileURLToPath(new URL("..", import.meta.url)));
const safeGit = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.pager=cat", "-c", "credential.helper=", "-c", "core.askpass="];
const deadline = Date.now() + 25_000;
const run = (program, argv, options = {}) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("roadmap validation deadline expired");
  return spawnSync(program, argv, { cwd: root, encoding: "utf8", timeout: Math.min(10_000, remaining), maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, ...options });
};
const git = (...argv) => run("git", [...safeGit, ...argv]);
const fail = message => { throw new Error(message); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const safePath = path => typeof path === "string" && path.length > 0 && path.length <= 1024 && !path.startsWith("-") && !path.startsWith("/") && !path.includes("\\") && !path.includes(":") && !path.split("/").some(part => part === ".." || part === "." || part === "");
try {
  const head = committed ? git("rev-parse", "--verify", "HEAD") : undefined;
  if (committed && (head.status !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim()))) fail("committed head unavailable");
  const read = file => {
    if (!committed) {
      if (!safePath(file)) fail("unsafe roadmap evidence path");
      const parts = file.split("/"); let parent = root;
      for (const part of parts.slice(0, -1)) { parent = join(parent, part); const stat = lstatSync(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("roadmap evidence parent is not a plain directory"); }
      const path = join(root, file), before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4 * 1024 * 1024) fail("roadmap evidence is not a bounded plain file");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) fail("roadmap evidence changed");
        const text = readFileSync(fd, "utf8"), after = fstatSync(fd);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail("roadmap evidence changed");
        return text;
      } finally { closeSync(fd); }
    }
    const result = git("show", `${head.stdout.trim()}:${file}`); if (result.status !== 0) fail(`committed ${file} unavailable`); return result.stdout;
  };
  const document = JSON.parse(read("docs/roadmap.json"));
  if (!plain(document) || document.version !== 1 || !Array.isArray(document.milestones) || document.milestones.length > 1000 || Object.keys(document).some(key => !["version", "milestones"].includes(key))) fail("invalid roadmap schema");
  const names = committed ? git("ls-tree", "-r", "-z", "--name-only", head.stdout.trim(), "--", "docs/design") : git("ls-files", "-z", "--", "docs/design");
  if (names.status !== 0) fail("spec inventory unavailable");
  const files = names.stdout.split("\0").filter(name => name.endsWith(".md"));
  if (files.length > 2000) fail("spec inventory incomplete");
  const specs = new Map();
  const scalar = value => {
    const text = value.trim();
    if (text.startsWith('"') && text.endsWith('"')) { try { const parsed = JSON.parse(text); if (typeof parsed === "string") return parsed; } catch {} fail("invalid quoted spec field"); }
    if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
    return text.replace(/\s+#.*$/, "").trim();
  };
  for (const file of files) {
    if (!safePath(file)) fail("unsafe spec path");
    const source = read(file); if (Buffer.byteLength(source) > 4 * 1024 * 1024) fail("spec file exceeds the read bound");
    const lines = source.split(/\r?\n/); if (lines[0] !== "---") continue;
    const end = lines.findIndex((line, i) => i > 0 && (line === "---" || line === "..."));
    if (end < 0 || Buffer.byteLength(lines.slice(0, end + 1).join("\n")) > 8192) fail("spec frontmatter unavailable");
    let id, collecting = false, paths = [], seenPaths = false;
    for (const line of lines.slice(1, end)) {
      const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
      if (field) {
        collecting = field[1] === "paths";
        if (field[1] === "id") { if (id !== undefined) fail("duplicate spec id field"); id = scalar(field[2]); }
        if (collecting) {
          if (seenPaths) fail("duplicate spec paths field"); seenPaths = true;
          const value = field[2].trim();
          if (value) { if (!value.startsWith("[") || !value.endsWith("]")) fail("invalid spec paths"); paths = value.slice(1, -1).split(",").map(scalar).filter(Boolean); }
        }
      } else if (collecting) {
        const entry = /^\s+-\s+(.+)$/.exec(line); if (entry) paths.push(scalar(entry[1]));
        else if (line.trim() && !line.trim().startsWith("#")) fail("invalid spec paths");
      }
    }
    if (id !== undefined) { if (!id || specs.has(id)) fail("duplicate or invalid spec id"); specs.set(id, { paths }); }
  }
  const ids = new Set(), issueStates = new Map();
  for (const row of document.milestones) {
    if (!plain(row) || Object.keys(row).some(key => !["id", "title", "outcome", "state", "horizon", "order", "target", "parent", "issues", "specs", "progress", "withheld"].includes(key)) || !integer(row.id) || row.id === 0 || ids.has(row.id) || typeof row.title !== "string" || !row.title || row.title.length > 300 || typeof row.outcome !== "string" || !row.outcome || row.outcome.length > 4000 || !["proposed", "planned", "active", "done", "dropped"].includes(row.state) || !["now", "next", "later"].includes(row.horizon) || !integer(row.order) || !(row.target === null || typeof row.target === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.target) && Number.isFinite(Date.parse(`${row.target}T00:00:00Z`)) && new Date(`${row.target}T00:00:00Z`).toISOString().slice(0, 10) === row.target) || !(row.parent === null || integer(row.parent) && row.parent > 0) || !Array.isArray(row.issues) || !Array.isArray(row.specs) || !plain(row.progress) || Object.keys(row.progress).some(key => !["tasks", "issues", "specs", "releases"].includes(key)) || !integer(row.withheld)) fail("invalid roadmap milestone");
    for (const [name, keys] of [["tasks", ["approved", "total"]], ["issues", ["closed", "total", "unknown"]], ["specs", ["fresh", "stale", "unverified", "unknown", "total"]], ["releases", ["shipped", "total", "unknown"]]]) {
      const counts = row.progress[name];
      if (!plain(counts) || Object.keys(counts).some(key => !keys.includes(key)) || keys.some(key => !integer(counts[key]))) fail(`invalid roadmap ${name} progress`);
      if (keys.filter(key => key !== "total").some(key => counts[key] > counts.total)) fail(`invalid roadmap ${name} progress`);
    }
    ids.add(row.id);
    for (const issue of row.issues) {
      if (!plain(issue) || typeof issue.ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}#[1-9][0-9]*$/.test(issue.ref) || !["open", "closed", "unknown"].includes(issue.state)) fail("invalid roadmap issue");
      const key = issue.ref.toLowerCase(), previous = issueStates.get(key); if (previous && previous !== issue.state) fail("conflicting roadmap issue states"); issueStates.set(key, issue.state);
    }
    for (const spec of row.specs) {
      if (!plain(spec) || typeof spec.id !== "string" || !["fresh", "stale", "unverified", "unknown"].includes(spec.state)) fail("invalid roadmap spec");
      const entry = specs.get(spec.id); if (!entry) fail(`unknown roadmap spec ${spec.id}`);
      if (!entry.paths.length) fail(`roadmap spec has no paths: ${spec.id}`);
      for (const path of entry.paths) {
        if (!safePath(path)) fail(`unsafe roadmap spec path: ${path}`);
        const found = committed ? git("ls-tree", "-r", "--name-only", head.stdout.trim(), "--", path) : git("ls-files", "--", path);
        if (found.status !== 0 || !found.stdout.trim()) fail(`missing roadmap spec path: ${path}`);
      }
    }
  }
  for (const row of document.milestones) if (row.parent !== null && (!ids.has(row.parent) || row.parent === row.id || document.milestones.find(parent => parent.id === row.parent)?.parent !== null)) fail("roadmap parent is missing or nested");
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    if (issueStates.size > 100) fail("roadmap issue inventory exceeds the GitHub read bound");
    for (const [ref, state] of issueStates) {
      if (state === "unknown") continue;
      const [repo, number] = ref.split("#"), result = run("gh", ["api", `repos/${repo}/issues/${number}`, "--hostname", "github.com", "--jq", ".state"]);
      if (result.status !== 0 || !["open", "closed"].includes(result.stdout.trim())) fail(`roadmap issue state unavailable: ${ref}`);
      if (result.stdout.trim() !== state) fail(`roadmap issue state differs: ${ref}`);
    }
  }
  console.log(`roadmap: OK (${document.milestones.length} milestones)`);
} catch (error) { console.error(`roadmap: ${error instanceof Error ? error.message : "validation unavailable"}`); process.exitCode = 1; }
