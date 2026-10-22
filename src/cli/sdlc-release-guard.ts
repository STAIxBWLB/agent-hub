/** Literal release targets only. Parsing never executes a command or reads the repository. */
export type ReleaseGuardRequest =
  | { kind: "tag-push"; version: string; tag: string; sourceRef: string; remote: string }
  | { kind: "gh-release"; version: string; tag: string; target?: string }
  | { kind: "npm-publish" };
export interface ReleasePushUpdate { localRef: string; localOid: string; remoteRef: string; remoteOid: string; version: string; }
type Refusal = { ok: false; reason: string };
export type ReleaseGuardParse = { ok: true; request: ReleaseGuardRequest } | Refusal;
export type ReleasePushParse = { ok: true; remoteName: string; remoteUrl: string; updates: ReleasePushUpdate[]; stdin: string } | Refusal;
const refuse = (): Refusal => ({ ok: false, reason: "release target is ambiguous, unsupported or invalid" });
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:[+][0-9A-Za-z.-]+)?$/;
const oid = (value: string) => /^[0-9a-f]{40}$/.test(value);
const zero = (value: string) => /^0{40}$/.test(value);
const literal = (value: string) => value.length > 0 && value.length <= 4096 && !/[\s\0-\x1f\x7f$`*?\\]/.test(value);
const ref = (value: string) => literal(value) && !value.startsWith("-") && !value.includes("..") && !value.includes("@{") && !value.includes("//") && !value.endsWith("/") && !value.endsWith(".") && !value.endsWith(".lock") && !"~^:[]()".split("").some(char => value.includes(char));
const versionOf = (tag: string): string | undefined => tag.startsWith("v") && SEMVER.test(tag.slice(1)) ? tag.slice(1) : undefined;

// Hook values are opaque Git data, not shell source. Unicode and shell-looking
// characters are valid in refs; only Git's forbidden ref syntax is rejected.
const hookText = (value: string) => value.length > 0 && value.length <= 4096 && !/[\p{Cc}]/u.test(value);
const hookRef = (value: string) => hookText(value) && !/[\0-\x20\x7f]/.test(value) && !"~^:?*[\\".split("").some(char => value.includes(char)) && !value.includes("..") && !value.includes("@{") && !value.includes("//") && !value.endsWith("/") && !value.endsWith(".") && !value.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"));

export function parseReleaseGuardArgv(argv: readonly string[]): ReleaseGuardParse {
  if (!Array.isArray(argv) || !argv.length || argv.length > 128 || !argv.every(word => typeof word === "string" && word.length <= 4096 && !/[\0-\x1f\x7f]/.test(word)) || Buffer.byteLength(argv.join("\0")) > 16 * 1024) return refuse();
  const [program, ...args] = argv;
  if (program === "git" && args[0] === "push") {
    if (args.length !== 3 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args[1] ?? "")) return refuse();
    const spec = args[2]!, parts = spec.split(":");
    if (parts.length > 2 || spec.startsWith("+")) return refuse();
    const destination = parts.length === 2 ? parts[1]! : parts[0]!;
    const tag = destination.startsWith("refs/tags/") ? destination.slice(10) : destination;
    const version = versionOf(tag), sourceRef = parts[0]!;
    if (!version || !ref(sourceRef) || parts.length === 2 && !destination.startsWith("refs/tags/")) return refuse();
    return { ok: true, request: { kind: "tag-push", version, tag, sourceRef, remote: args[1]! } };
  }
  if (program === "gh" && args[0] === "release" && args[1] === "create") {
    const tag = args[2] ?? "", version = versionOf(tag);
    if (!version) return refuse();
    let target: string | undefined;
    const valued = new Set(["--title", "-t", "--notes", "-n", "--notes-file", "-F", "--notes-start-tag", "--target"]);
    const flags = new Set(["--verify-tag", "--generate-notes", "--draft", "-d", "--prerelease", "-p", "--fail-on-no-commits"]);
    for (let i = 3; i < args.length; i++) {
      const flag = args[i]!;
      if (flags.has(flag)) continue;
      if (!valued.has(flag) || args[i + 1] === undefined) return refuse();
      const value = args[++i]!;
      if (flag === "--target") { if (target !== undefined || !ref(value)) return refuse(); target = value; }
    }
    return { ok: true, request: { kind: "gh-release", version, tag, ...(target === undefined ? {} : { target }) } };
  }
  if (program === "npm" && args[0] === "publish") {
    const flags = new Set(["--provenance", "--ignore-scripts", "--dry-run"]);
    for (let i = 1; i < args.length; i++) {
      if (flags.has(args[i]!)) continue;
      if (args[i] === "--access" && ["public", "restricted"].includes(args[i + 1] ?? "")) { i++; continue; }
      if (args[i] === "--tag" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args[i + 1] ?? "")) { i++; continue; }
      return refuse();
    }
    return { ok: true, request: { kind: "npm-publish" } };
  }
  return refuse();
}

/** Validate every hook row before selecting version-tag updates. Preserve the exact original input. */
export function parseReleasePushUpdates(remoteName: string, remoteUrl: string, stdin: string): ReleasePushParse {
  if (typeof remoteName !== "string" || typeof remoteUrl !== "string" || typeof stdin !== "string" || !hookText(remoteName) || !hookText(remoteUrl) || Buffer.byteLength(stdin) > 128 * 1024) return refuse();
  const lines = stdin.endsWith("\n") ? stdin.slice(0, -1).split("\n") : stdin.split("\n");
  if (stdin === "") lines.length = 0;
  if (lines.length > 128) return refuse();
  const updates: ReleasePushUpdate[] = [];
  for (const line of lines) {
    const fields = line.split(" ");
    if (fields.length !== 4) return refuse();
    const [localRef, localOid, remoteRef, remoteOid] = fields as [string, string, string, string];
    if ((!hookRef(localRef) && localRef !== "(delete)") || !hookRef(remoteRef) || !remoteRef.startsWith("refs/") || !oid(localOid) || !oid(remoteOid)) return refuse();
    if (!remoteRef.startsWith("refs/tags/v")) continue;
    const version = versionOf(remoteRef.slice(10));
    if (!version || zero(localOid) || localRef === "(delete)") return refuse();
    updates.push({ localRef, localOid, remoteRef, remoteOid, version });
  }
  return { ok: true, remoteName, remoteUrl, updates, stdin };
}
