import { DENY_NAMES, DENY_SEGMENTS } from "@staix/agent-mem/platform";
import { assessVersion, COMPAT } from "./compat.ts";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { peerChildEnv, stopOwnedProcess, trackGroup } from "../hub/child-process.ts";
import { realPath } from "../hub/project.ts";
import type { ReviewerBackend, ReviewerCauseClass, ReviewerLaunch, ReviewerPrepareContext } from "./reviewer-print.ts";

const TOOLS = ["hub_review", "hub_task_show"];
/** A version refusal names only versions and a command, so the daemon may show it (#691). */
class VersionRefusal extends Error {}
const CAP = 128 * 1024, MAX_SERVERS = 64;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Conservative translation of the portable core's regex sources; unfamiliar syntax refuses the receipt. */
export function codexCoreDenyGlobs(names: readonly string[] = DENY_NAMES, segments: readonly string[] = DENY_SEGMENTS): string[] {
  if (names.length > 64 || segments.length > 64) throw new Error("core deny policy bound exceeded");
  const globs: string[] = [];
  for (const source of names) {
    if (typeof source !== "string" || source.length > 256) throw new Error("unverified core deny pattern");
    const anchored = source.startsWith("^");
    let body = anchored ? source.slice(1) : source;
    const branch = "(\\.|$)", branchSuffix = anchored && body.endsWith(branch);
    const end = !branchSuffix && body.endsWith("$");
    if (!anchored && !end) throw new Error("unverified core deny pattern");
    if (branchSuffix) body = body.slice(0, -branch.length);
    else if (end) body = body.slice(0, -1);
    let literal = "";
    for (let i = 0; i < body.length; i++) {
      const char = body[i]!;
      if (char === "\\" && body[i + 1] === ".") { literal += "."; i++; }
      else if (/^[A-Za-z0-9_-]$/.test(char)) literal += char;
      else throw new Error("unverified core deny pattern");
    }
    if (!literal) throw new Error("empty core deny pattern");
    const glob = `/**/${anchored ? "" : "*"}${literal}${end ? "" : "*"}`;
    globs.push(glob, `${glob}/**`);
  }
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.length > 256 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(segment) || segment.split("/").some(part => part === "." || part === "..")) throw new Error("unverified core deny segment");
    globs.push(`/**/${segment}`, `/**/${segment}/**`);
  }
  return [...new Set(globs)];
}

const inside = (file: string, root: string) => { const part = relative(root, file); return part === "" || part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid metadata");
  return value as Record<string, unknown>;
};
function toml(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  return `{${Object.entries(object(value)).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(",")}}`;
}
function metadata(file: string): string {
  try { const link = lstatSync(file), stat = statSync(file); return [link.dev, link.ino, link.mtimeMs, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw new Error("config metadata unavailable"); }
}
function configFiles(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const home = resolve(env.CODEX_HOME ?? join(homedir(), ".codex"));
  const files = [join(home, "config.toml"), join(home, "cloud-config-bundle-cache.json"), "/etc/codex/config.toml", "/etc/codex/requirements.toml", "/etc/codex/managed_config.toml"];
  // Include ancestors even outside the git root: no trust/layout assumption can hide a changed layer.
  for (let dir = cwd; ; dir = dirname(dir)) { files.push(join(dir, ".codex", "config.toml")); if (dirname(dir) === dir) break; }
  return files;
}
// Bounded host credential roots, not a universal private-home classifier. Never inspect their file contents.
const HOST_CREDENTIAL_PATHS = [".config", ".ssh", ".aws", ".azure", ".kube", ".docker", ".gnupg", ".codex", ".claude", ".kimi", ".kimi-code", ".gemini", ".git-credentials", ".vault-token", "Library/Keychains", ".local/share/keyrings", ".password-store"] as const;
const HOST_CREDENTIAL_ENV = ["XDG_CONFIG_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "KIMI_CODE_HOME", "KIMI_HOME", "GEMINI_CLI_HOME", "GNUPGHOME", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AZURE_CONFIG_DIR", "DOCKER_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS"] as const;
/** A credential root that cannot be resolved. `label` is a path class (a standard name or an env var name), never a path or contents. */
class CredentialRootError extends Error {
  constructor(readonly label: string, readonly kind: "dangling" | "unreadable" | "unsupported") { super("credential root refused"); }
}
interface CredentialRoot { path: string; label: string }
function hostCredentialRoots(env: NodeJS.ProcessEnv, cwd: string): CredentialRoot[] {
  const home = resolve(cwd, env.HOME || homedir());
  const homes = [...new Set([home, canonicalLabelled(home, "HOME")])];
  const roots: CredentialRoot[] = homes.flatMap(base => HOST_CREDENTIAL_PATHS.map(entry => ({ path: join(base, entry), label: `~/${entry}` })));
  const configured: CredentialRoot[] = HOST_CREDENTIAL_ENV.flatMap(key => env[key] ? [{ path: env[key]!, label: `$${key}` }] : []);
  if (env.KUBECONFIG) configured.push(...env.KUBECONFIG.split(delimiter).filter(Boolean).map(path => ({ path, label: "$KUBECONFIG" })));
  if (configured.length > 64) throw new Error("credential root bound exceeded");
  for (const { path: entry, label } of configured) {
    if (Buffer.byteLength(entry) > 4096 || /\p{Cc}/u.test(entry)) throw new CredentialRootError(label, "unsupported");
    roots.push({ path: entry.startsWith("~/") ? resolve(home, entry.slice(2)) : resolve(cwd, entry), label });
  }
  const seen = new Set<string>();
  return roots.filter(root => !seen.has(root.path) && seen.add(root.path));
}
function canonicalLabelled(lexical: string, label: string): string {
  try { return credentialCanonicalPath(lexical); }
  catch (error) { throw new CredentialRootError(label, (error as NodeJS.ErrnoException).code === "ENOENT" ? "dangling" : "unreadable"); }
}
/** Resolve absent descendants through the deepest existing ancestor; dangling links refuse admission. */
function credentialCanonicalPath(lexical: string): string {
  // Same strict ancestor algorithm as policyRealPath; importing path-policy here would cycle through the registry.
  let ancestor = lexical;
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  return join(realPath(ancestor), relative(ancestor, lexical));
}
function denyCredentialRoots(filesystem: Record<string, string>, roots: readonly CredentialRoot[], cwd: string): void {
  for (const { path: lexical, label } of roots) {
    // Native profile keys with glob metacharacters cannot represent these literal host locations safely.
    if (/[?*\[\]{}]/.test(lexical)) throw new CredentialRootError(label, "unsupported");
    const targets = new Set([lexical, canonicalLabelled(lexical, label)]);
    for (const target of targets) {
      if (/[?*\[\]{}]/.test(target) || inside(cwd, target)) throw new CredentialRootError(label, "unsupported");
      filesystem[target] = "deny"; filesystem[`${target.replace(/\/$/, "")}/**`] = "deny";
    }
  }
}

function resolveCommand(ctx: ReviewerPrepareContext, cwd: string): { command: string[]; files: string[] } {
  const [name = "codex", ...prefix] = ctx.command ?? [];
  const found = isAbsolute(name) ? name : Bun.which(name);
  if (!found) throw new Error("host executable unavailable");
  let binary = realPath(found);
  // Bind the actual native binary, not the mutable npm launcher/interpreter selection.
  if (basename(binary) === "codex.js") {
    const target = process.platform === "darwin" ? process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
      : process.platform === "linux" ? process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl" : undefined;
    if (!target || !["arm64", "x64"].includes(process.arch)) throw new Error("unverified native platform");
    const suffix = `${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`;
    const manifest = createRequire(binary).resolve(`@openai/codex-${suffix}/package.json`);
    binary = realPath(join(dirname(manifest), "vendor", target, "bin", "codex"));
  }
  const files = [binary];
  if (inside(binary, cwd)) throw new Error("project executable refused");
  for (const [index, arg] of prefix.entries()) {
    // Privileged host argv may include a fixture/launcher script, but never a project-owned one.
    if (isAbsolute(arg) && (index === 0 || /\.(?:js|ts|mjs|cjs|sh)$/.test(arg)) && existsSync(arg) && statSync(arg).isFile()) {
      const file = realPath(arg); if (inside(file, cwd)) throw new Error("project command prefix refused"); files.push(file);
    } else if (/\.(?:js|ts|mjs|cjs|sh)$/.test(arg)) throw new Error("unbound command prefix refused");
  }
  return { command: [binary, ...prefix], files };
}
interface Server { name: string; enabled: boolean; type: "stdio" | "http"; transport: Record<string, unknown> }
function inventory(text: string): Server[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw) || raw.length > MAX_SERVERS) throw new Error("inventory bound exceeded");
  const seen = new Set<string>();
  return raw.map(value => {
    const row = object(value), transport = object(row.transport);
    if (typeof row.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(row.name) || seen.has(row.name) || typeof row.enabled !== "boolean") throw new Error("invalid inventory identity");
    seen.add(row.name);
    const type = transport.type;
    if (type !== "stdio" && type !== "http" && type !== "streamable_http") throw new Error("unverified MCP transport");
    return { name: row.name, enabled: row.enabled, type: type === "stdio" ? "stdio" : "http", transport };
  });
}
/** The configured MCP list omits runtime-synthesized Apps; verify the fixed feature gate separately. */
function proveDisabledFeatures(text: string): void {
  const rows = text.trim().split(/\r?\n/).map(line => line.trim());
  if (rows.length > 512) throw new Error("feature inventory bound exceeded");
  for (const name of ["apps", "plugins", "hooks"]) {
    const matches = rows.filter(line => line.split(/\s+/)[0] === name);
    if (matches.length !== 1 || !new RegExp(`^${name}\\s+stable\\s+false$`).test(matches[0]!)) throw new Error("effective feature isolation unverified");
  }
}
function ownServer(text: string): Record<string, unknown> {
  const config = object(JSON.parse(text)), servers = object(config.mcpServers);
  if (Object.keys(servers).length !== 1 || !Object.hasOwn(servers, "agent-hub")) throw new Error("fixed hub MCP required");
  const hub = object(servers["agent-hub"]);
  if (Object.keys(hub).some(key => !["command", "args", "env"].includes(key)) || typeof hub.command !== "string" || !hub.command || hub.args !== undefined && (!Array.isArray(hub.args) || hub.args.some(arg => typeof arg !== "string"))) throw new Error("invalid hub transport");
  const env = hub.env === undefined ? {} : object(hub.env);
  if (Object.values(env).some(value => typeof value !== "string")) throw new Error("invalid hub environment");
  return { command: hub.command, args: hub.args ?? [], env, enabled: true, required: true, enabled_tools: TOOLS };
}

/** All reads are model-free and bounded; stdout/config/env values never become diagnostic text. */
async function prepare(ctx: ReviewerPrepareContext): Promise<ReviewerLaunch | { unavailable: string; causeClass?: ReviewerCauseClass; detail?: string }> {
  let root: string | undefined;
  // #722: the proof leg being run, so a refusal names a class and never text from the native CLI. `timedOut` is set by `run` only.
  let leg: ReviewerCauseClass = "binary", timedOut = false;
  try {
    const cwd = realPath(ctx.cwd), env = peerChildEnv(ctx.peer), bound = resolveCommand(ctx, cwd);
    const initialBinaryMetadata = bound.files.map(metadata).join(";");
    // Hash content once per receipt, then fence the identity with dev/ino/size/mtime/ctime metadata.
    const binaryHash = digest(bound.files.map(file => digest(readFileSync(file))).join(";"));
    if (bound.files.map(metadata).join(";") !== initialBinaryMetadata) throw new Error("binary changed while hashing");
    const watched = configFiles(cwd, env), initialConfig = watched.map(metadata).join(";");
    const deadline = performance.now() + 12_000;
    const current = () => {
      if (ctx.signal.aborted || watched.map(metadata).join(";") !== initialConfig) return false;
      return bound.files.map(metadata).join(";") === initialBinaryMetadata;
    };
    const run = (args: readonly string[], capture = true, maxBytes = CAP) => new Promise<string>((resolveOutput, reject) => {
      if (ctx.signal.aborted || performance.now() >= deadline) { if (!ctx.signal.aborted) timedOut = true; reject(new Error("metadata deadline")); return; }
      const [cmd, ...prefix] = bound.command;
      const child = spawn(cmd!, [...prefix, ...args], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", bytes = 0, failed = false, settled = false;
      const stop = () => { failed = true; void finish(null); };
      const timer = setTimeout(() => { if (!ctx.signal.aborted) timedOut = true; stop(); }, Math.max(1, Math.min(2000, deadline - performance.now())));
      ctx.signal.addEventListener("abort", stop, { once: true });
      const finish = async (code: number | null) => {
        if (settled) return; settled = true; clearTimeout(timer); ctx.signal.removeEventListener("abort", stop);
        try { await stopOwnedProcess(child, { group: true, termMs: 100, killMs: 500 }); }
        catch { reject(new Error("metadata cleanup unconfirmed")); return; }
        if (failed || ctx.signal.aborted || code !== 0) reject(new Error("metadata proof refused")); else resolveOutput(output);
      };
      child.once("spawn", () => { trackGroup(child); if (ctx.signal.aborted) stop(); });
      child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) stop(); else if (capture) output += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) stop(); });
      child.once("error", () => { failed = true; void finish(null); });
      child.once("close", code => { void finish(code); });
    });
    // #691: the verified versions and the person's trust live in compat.ts; every proof below still runs after trust.
    leg = "version";
    const verdict = assessVersion("codex-review", COMPAT["codex-review"].parse(await run(["--version"])));
    if (!verdict.ok) throw new VersionRefusal(verdict.reason);
    const version = verdict.version;
    leg = "mcp_inventory";
    if (Buffer.byteLength(ctx.mcpConfig) > CAP || ctx.privatePaths.length > 128) throw new Error("policy bounds exceeded");
    const hub = ownServer(ctx.mcpConfig);
    // Apps creates a runtime MCP server outside the configured inventory; independently pin and read back its gate.
    const policy = ["-c", "notify=[]", "--disable", "plugins", "--disable", "hooks", "--disable", "apps", "-c", 'web_search="disabled"', "-c", `projects=${toml({ [cwd]: { trust_level: "untrusted" } })}`];
    leg = "plugins_hooks_apps";
    proveDisabledFeatures(await run(["features", "list", ...policy]));
    leg = "mcp_inventory";
    const before = inventory(await run(["mcp", "list", "--json", ...policy]));
    if (before.some(row => row.name === "agent-hub")) throw new Error("ambient hub MCP collision");
    const servers: Record<string, unknown> = Object.assign(Object.create(null), { "agent-hub": hub });
    for (const server of before) servers[server.name] = server.type === "stdio" ? { command: "/usr/bin/false", enabled: false } : { url: "http://127.0.0.1:1", enabled: false };
    const mcp = ["-c", `mcp_servers=${toml(servers)}`];
    const after = inventory(await run(["mcp", "list", "--json", ...policy, ...mcp]));
    if (after.length !== before.length + 1 || after.some(row => row.name !== "agent-hub" && !before.some(old => old.name === row.name)) || after.filter(row => row.enabled).map(row => row.name).join(",") !== "agent-hub") throw new Error("MCP inventory changed or is not strict");
    const observed = object(JSON.parse(await run(["mcp", "get", "agent-hub", "--json", ...policy, ...mcp])));
    if (observed.name !== "agent-hub" || observed.enabled !== true || !Array.isArray(observed.enabled_tools) || JSON.stringify(observed.enabled_tools) !== JSON.stringify(TOOLS)) throw new Error("hub tool allowlist unverified");
    const observedTransport = object(observed.transport);
    const observedEnv = object(observedTransport.env ?? {}), intendedEnv = object(hub.env);
    if (observedTransport.type !== "stdio" || observedTransport.command !== hub.command || JSON.stringify(observedTransport.args ?? []) !== JSON.stringify(hub.args) || Object.keys(observedEnv).length !== Object.keys(intendedEnv).length || Object.entries(intendedEnv).some(([key, value]) => observedEnv[key] !== value)) throw new Error("hub transport changed");
    // A real native sandbox probes a fresh private fixture: the model never sees these files.
    leg = "sandbox_proof";
    root = realPath(mkdtempSync(join(tmpdir(), "ahub-codex-review-isolation-")));
    const privateFile = join(root, "private.env"), publicFile = join(root, "public.txt"), writeFile = join(root, "write-proof");
    const coreName = join(root, ".env"), coreStateDir = join(root, ".agenthub", "state"), coreState = join(coreStateDir, "private.txt");
    const fixtureHome = join(root, "host-home"), hostConfig = join(fixtureHome, ".config", "gh", "hosts.yml"), hostKube = join(fixtureHome, ".kube", "config"), hostDocker = join(fixtureHome, ".docker", "config.json"), hostAlias = join(root, "host-alias.yml");
    for (const file of [hostConfig, hostKube, hostDocker]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "synthetic host credential fixture"); }
    symlinkSync(hostConfig, hostAlias);
    mkdirSync(coreStateDir, { recursive: true });
    writeFileSync(coreName, "core name fixture"); writeFileSync(coreState, "core state fixture");
    const globRoot = join(root, "glob"), nested = join(globRoot, "nested"), globFile = join(nested, "private.env"), alias = join(root, "alias.env");
    mkdirSync(globRoot); mkdirSync(nested);
    writeFileSync(privateFile, "private fixture"); writeFileSync(publicFile, "public fixture"); writeFileSync(globFile, "glob private fixture");
    symlinkSync(globFile, alias);
    const filesystem: Record<string, string> = { "/": "read", [privateFile]: "deny", [join(globRoot, "**", "*.env")]: "deny" };
    leg = "credential_root";
    for (const glob of codexCoreDenyGlobs()) filesystem[glob] = "deny";
    denyCredentialRoots(filesystem, [...hostCredentialRoots(env, cwd), ...hostCredentialRoots({ HOME: fixtureHome }, cwd)], cwd);
    leg = "sandbox_proof";
    for (const entry of ctx.privatePaths) {
      if (typeof entry !== "string" || !entry || Buffer.byteLength(entry) > 4096 || /\p{Cc}/u.test(entry)) throw new Error("invalid private path policy");
      // Native Seatbelt supports *, ?, and closed character classes, not brace alternatives.
      if (/[{}]/.test(entry)) throw new Error("unverified private path pattern");
      const homePath = entry === "~" || entry.startsWith("~/");
      const absolute = homePath ? resolve(homedir(), entry.slice(2)) : isAbsolute(entry) ? entry : resolve(cwd, entry);
      const patterns = new Set([absolute]);
      if (!/[?*\[\]]/.test(absolute) && existsSync(absolute)) patterns.add(realPath(absolute));
      if (!isAbsolute(entry) && !homePath && entry !== "." && entry !== "..") {
        patterns.add(join(cwd, "**", entry));
        // ctx combines PII path patterns and local substring denies: broadening is safer than omission.
        if (!/[?*\[\]]/.test(entry)) patterns.add(join(cwd, "**", `*${entry.replace(/^\.\//, "").replace(/\/$/, "")}*`));
      }
      for (const pattern of patterns) { filesystem[pattern] = "deny"; filesystem[`${pattern.replace(/\/$/, "")}/**`] = "deny"; }
    }
    const profile = { filesystem, network: { enabled: false } }, permissions = ["-c", `permissions=${toml({ "ahub-review": profile })}`, "-c", 'default_permissions="ahub-review"'];
    // ponytail: drain the pinned catalog without retaining it, capped at 4 MiB; replace with quiet config validation when the native CLI provides it.
    await run(["debug", "models", "--bundled", ...policy, ...permissions], false, 4 * 1024 * 1024);
    const script = 'if /bin/cat "$1" >/dev/null 2>&1; then echo AHUB_CODEX_PUBLIC_READ; fi; if /bin/cat "$2" >/dev/null 2>&1; then exit 12; else echo AHUB_CODEX_PRIVATE_DENIED; fi; if (echo no > "$3") 2>/dev/null; then exit 13; else echo AHUB_CODEX_WRITE_DENIED; fi; if /bin/cat "$4" >/dev/null 2>&1; then exit 14; else echo AHUB_CODEX_GLOB_PRIVATE_DENIED; fi; if /bin/cat "$5" >/dev/null 2>&1; then exit 15; else echo AHUB_CODEX_ALIAS_PRIVATE_DENIED; fi; if /bin/cat "$6" >/dev/null 2>&1; then exit 16; else echo AHUB_CODEX_CORE_NAME_DENIED; fi; if /bin/cat "$7" >/dev/null 2>&1; then exit 17; else echo AHUB_CODEX_CORE_STATE_DENIED; fi; if /bin/cat "$8" >/dev/null 2>&1; then exit 18; else echo AHUB_CODEX_HOST_CONFIG_DENIED; fi; if /bin/cat "$9" >/dev/null 2>&1; then exit 19; else echo AHUB_CODEX_HOST_KUBE_DENIED; fi; if /bin/cat "${10}" >/dev/null 2>&1; then exit 20; else echo AHUB_CODEX_HOST_DOCKER_DENIED; fi; if /bin/cat "${11}" >/dev/null 2>&1; then exit 21; else echo AHUB_CODEX_HOST_ALIAS_DENIED; fi';
    const proof = await run(["sandbox", "-P", "ahub-review", "-C", cwd, ...policy, ...permissions, "/bin/sh", "-c", script, "proof", publicFile, privateFile, writeFile, globFile, alias, coreName, coreState, hostConfig, hostKube, hostDocker, hostAlias]);
    if (proof.trim() !== "AHUB_CODEX_PUBLIC_READ\nAHUB_CODEX_PRIVATE_DENIED\nAHUB_CODEX_WRITE_DENIED\nAHUB_CODEX_GLOB_PRIVATE_DENIED\nAHUB_CODEX_ALIAS_PRIVATE_DENIED\nAHUB_CODEX_CORE_NAME_DENIED\nAHUB_CODEX_CORE_STATE_DENIED\nAHUB_CODEX_HOST_CONFIG_DENIED\nAHUB_CODEX_HOST_KUBE_DENIED\nAHUB_CODEX_HOST_DOCKER_DENIED\nAHUB_CODEX_HOST_ALIAS_DENIED" || existsSync(writeFile)) throw new Error("native sandbox isolation unverified");
    leg = "binary";
    if (!current()) throw new Error("binary or config changed during proof");
    const cleanupRoot = root;
    const launchProfile = digest(toml({ profile, servers, policy }));
    return { command: bound.command, args: ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json", "--color", "never", "-C", cwd, ...policy, ...permissions, ...mcp, "-c", `developer_instructions=${toml(ctx.systemPrompt)}`, "-"], env,
      current: () => { try { return current(); } catch { return false; } },
      cleanup: () => rmSync(cleanupRoot, { recursive: true, force: true }),
      isolation: { backend: "codex", version, binary: `sha256:${binaryHash}`, profile: `sha256:${launchProfile}`, readOnly: true, strictMcp: true, ephemeral: true,
        evidence: ["model-free-mcp-inventory-disabled-ambient", "hub-tools-exact-allowlist", "plugins-and-hooks-disabled", "legacy-notify-disabled", "apps-disabled-effective-feature-readback", "web-search-disabled", "project-untrusted", "native-public-read-private-deny-write-deny", "native-glob-and-symlink-private-deny", "portable-core-name-and-state-deny", "standard-host-credential-roots-denied", "binary-config-stable", "binary-hash-once-metadata-fence", "session-ephemeral"] } };
  } catch (error) {
    if (root) { try { rmSync(root, { recursive: true, force: true }); } catch { /* unavailable remains refused */ } }
    // Name only the path class of an unusable credential root so a stale ~/.docker link is fixable; never a path or contents.
    if (error instanceof VersionRefusal) return { unavailable: error.message, causeClass: "version" };
    if (error instanceof CredentialRootError) {
      const why = { dangling: "a dangling link", unreadable: "an unreadable path", unsupported: "unsupported syntax or overlapping the checkout" }[error.kind];
      return { unavailable: `Codex reviewer isolation receipt unavailable (credential root ${error.label} is ${why}; remove or repair it)`, causeClass: "credential_root", detail: `${error.label}: ${why}` };
    }
    // A timeout is a proof command that ran out of time, whichever leg it was on; every other refusal names the leg that was running.
    return { unavailable: "Codex reviewer isolation receipt unavailable (version, MCP inventory, sandbox, configuration or process proof)", causeClass: timedOut ? "timeout" : leg };
  }
}

export const codexReviewerBackend: ReviewerBackend = {
  id: "codex", prepare,
  usage(event) {
    const row = event as { type?: string; usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } };
    return row?.type === "turn.completed" && row.usage ? { input_tokens: row.usage.input_tokens, output_tokens: row.usage.output_tokens, cache_read_input_tokens: row.usage.cached_input_tokens } : undefined;
  },
};
