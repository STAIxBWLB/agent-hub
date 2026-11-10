import type { ReleaseGit } from "./sdlc-release.ts";

export type ReleaseVersionPolicy =
  | { source: "package.json" }
  | { source: "release-notes"; notesPath: string }
  | { source: "none" };
export type ReleaseDocsPolicy = { source: "checker" } | { source: "none" };
export interface ReleasePolicy { version: ReleaseVersionPolicy; docs: ReleaseDocsPolicy }

export const DEFAULT_RELEASE_POLICY: ReleasePolicy = {
  version: { source: "package.json" },
  docs: { source: "checker" },
};
export const DEFAULT_RELEASE_NOTES_PATH = "docs/releases/v{version}.md";

const record = (value: unknown): Record<string, unknown> | undefined =>
  !!value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function checkedNotesPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || !value.includes("{version}")
    || (value.match(/\{version\}/g)?.length ?? 0) !== 1 || /[\p{Cc}\\:*?\[\]]/u.test(value)
    || value.startsWith("/") || value.startsWith("-") || /^[A-Za-z]:/.test(value)
    || value.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("-"))) {
    throw new Error("release.notesPath must be a safe repository-relative path with exactly one {version} placeholder");
  }
  return value;
}

/** Parse only the release contract; unrelated project configuration is deliberately outside this policy reader. */
export function parseReleasePolicy(config: unknown): ReleasePolicy {
  const root = record(config);
  if (!root) throw new Error("committed .agenthub/config.json must be a JSON object");
  if (root.release === undefined) return DEFAULT_RELEASE_POLICY;
  const release = record(root.release);
  if (!release || Object.keys(release).some(key => !["version", "notesPath", "docs"].includes(key))) {
    throw new Error("committed release config must contain only version, notesPath and docs");
  }
  const rawVersion = release.version === undefined ? "package.json" : release.version;
  if (rawVersion !== "package.json" && rawVersion !== "release-notes" && rawVersion !== "none") {
    throw new Error("release.version in committed .agenthub/config.json must be package.json, release-notes or none");
  }
  const rawDocs = release.docs === undefined ? "checker" : release.docs;
  if (rawDocs !== "checker" && rawDocs !== "none") throw new Error("release.docs in committed .agenthub/config.json must be checker or none");
  const notesPath = checkedNotesPath(release.notesPath === undefined ? DEFAULT_RELEASE_NOTES_PATH : release.notesPath);
  return {
    version: rawVersion === "release-notes" ? { source: rawVersion, notesPath }
      : rawVersion === "none" ? { source: rawVersion } : { source: rawVersion },
    docs: rawDocs === "none" ? { source: rawDocs } : { source: rawDocs },
  };
}

interface TreeEntry { mode: string; type: string; oid: string; path: string }
function treeEntry(git: ReleaseGit, commit: string, path: string): TreeEntry | undefined {
  const result = git(["--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", path]);
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > 16 * 1024) throw new Error("committed release policy tree is unreadable");
  const rows = result.stdout.split("\0").filter(Boolean);
  if (rows.length > 1) throw new Error("committed release policy path is ambiguous");
  if (!rows.length) return undefined;
  const match = rows[0]!.match(/^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t([^\0]+)$/);
  if (!match || match[4] !== path) throw new Error("committed release policy tree is malformed");
  return { mode: match[1]!, type: match[2]!, oid: match[3]!, path: match[4]! };
}

function regularBlob(git: ReleaseGit, commit: string, path: string): boolean {
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index++) {
    const parent = parts.slice(0, index).join("/");
    const entry = treeEntry(git, commit, parent);
    if (!entry || entry.mode !== "040000" || entry.type !== "tree") return false;
  }
  const file = treeEntry(git, commit, path);
  return !!file && (file.mode === "100644" || file.mode === "100755") && file.type === "blob";
}

/** Read policy only from the candidate commit. Missing shared config means the legacy defaults; unreadable data fails closed. */
export function readCommittedReleasePolicy(git: ReleaseGit, commit: string): ReleasePolicy {
  const agentHub = treeEntry(git, commit, ".agenthub");
  if (!agentHub) return DEFAULT_RELEASE_POLICY;
  if (agentHub.mode !== "040000" || agentHub.type !== "tree") throw new Error("committed .agenthub is not a regular directory");
  const path = ".agenthub/config.json";
  const configEntry = treeEntry(git, commit, path);
  if (!configEntry) return DEFAULT_RELEASE_POLICY;
  if ((configEntry.mode !== "100644" && configEntry.mode !== "100755") || configEntry.type !== "blob") {
    throw new Error("committed .agenthub/config.json is not a regular file");
  }
  const result = git(["show", `${commit}:${path}`]);
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > 256 * 1024) throw new Error("committed .agenthub/config.json is unreadable");
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error("committed .agenthub/config.json is malformed JSON"); }
  const policy = parseReleasePolicy(parsed);
  if (policy.docs.source === "none" && regularBlob(git, commit, "docs/verified.json")) {
    throw new Error("release.docs is none but the candidate commits docs/verified.json; remove release.docs from .agenthub/config.json or delete the manifest, then authorize again");
  }
  return policy;
}

/** Ensure every directory component and the final notes path are committed as non-symlink tree/blob entries. */
export function hasCommittedReleaseNotes(git: ReleaseGit, commit: string, path: string): boolean {
  try { return regularBlob(git, commit, path); } catch { return false; }
}
