import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realPath } from "../hub/project.ts";
import { sbplString } from "./deny.ts";
import { profile, sandboxAvailable, sandboxedExec } from "./sandbox.ts";
import { ProbeToolRefusal } from "./probe-errors.ts";
import { probeWorkspaceCurrent, probeWorkspacePhysical, probeWorkspacePrivateRoot, probeWorkspaceTemporaryRoot, reserveProbeWorkspaceStorage, type ProbeWorkspace } from "./probe-workspace.ts";

export interface ProbeConfinement {
  readonly workspace: ProbeWorkspace;
  readonly profile: string;
  readonly env: Readonly<Record<string, string>>;
  stop(): Promise<void>;
}
/** An uncertain command retains this owned stop handle; callers must join it before workspace cleanup. */
export class ProbeConfinementError extends ProbeToolRefusal {
  constructor(readonly stop: () => Promise<void> = async () => {},
    /** Private proof-only diagnostic, never copied into a public probe receipt or ordinary observer. */
    readonly diagnostic?: { stage: "control" | "lane" | "cleanup"; code: number | null; output: string }) {
    super("confinement_unavailable");
  }
}
interface ProofState { workspace: ProbeWorkspace; profile: string; digest: string; current(): void; stop(): Promise<void> }
interface OwnedProofPath { file: string; dev: number; ino: number; directory: boolean; optional?: boolean; removed?: boolean }
const proofs = new WeakMap<ProbeConfinement, ProofState>();
let proofOwner: { workspace: ProbeWorkspace; stop(): Promise<void> } | undefined;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const q = sbplString;
const literal = (value: string) => `(literal ${q(value)})`;
const subpath = (value: string) => `(subpath ${q(value)})`;
const outside = (filters: readonly string[]): string => `(require-all ${filters.map(filter => `(require-not ${filter})`).join(" ")})`;
const PROOF_TIMEOUT_MS = 5000;
const PROOF_TOKEN = "probe-boundary-canary";
// /bin/bash: on macOS /bin/sh is a stub that re-execs /bin/bash as its variant (/private/var/select/sh), so the proof's own `sh -c` cannot start without it.
// Only this model-free proof runs these programs: probe dispatch refuses bash and git before any command (test "probe dispatch refuses all invented non-file calls"),
// so the grant widens the profile, not what a probe tool can do.
const COMMANDS = ["/bin/sh", "/bin/cat", "/bin/ln", "/bin/mv", "/usr/bin/nc", "/bin/bash"] as const;
const SH_VARIANT_SELECTOR = "/private/var/select/sh";

function restrictedProfile(workspace: ProbeWorkspace, controlPort?: number): string {
  probeWorkspaceCurrent(workspace);
  const programs = [...new Set(COMMANDS.flatMap(file => [file, realPath(file)]))];
  // Never grant all of /System: its Volumes/Data aliases can lead back to operator files.
  const systemData = ["/System/Library", "/usr/lib", "/private/var/db/dyld",
    "/System/Volumes/Preboot/Cryptexes/OS/System/Library", "/System/Volumes/Preboot/Cryptexes/OS/usr/lib"];
  // literal("/") is the root directory node only, not its children: dyld reads that node's data at every process start, and without it every program
  // (nc, sh, cat) aborts with SIGABRT before it runs (bisected with plain sandbox-exec on macOS 27.0.1). No other grant rides on it.
  const data = [literal("/"), subpath(workspace.root), ...systemData.map(subpath),
    ...programs.map(literal), literal(SH_VARIANT_SELECTOR), literal("/dev/null"), literal("/dev/random"), literal("/dev/urandom")];
  // Traversal metadata is permitted only for ancestors of an actual runtime or owned role root.
  const ancestors = new Set<string>(["/"]);
  for (const root of [workspace.root, ...programs, SH_VARIANT_SELECTOR, ...systemData]) {
    for (let parent = dirname(root); ; parent = dirname(parent)) { ancestors.add(parent); if (parent === "/") break; }
  }
  return [profile(workspace.root, controlPort === undefined ? false : { proxyPort: controlPort }),
    `(deny file-read-data ${outside(data)})`,
    `(deny file-read-metadata ${outside([...data, ...[...ancestors].map(literal)])})`,
    `(deny file-write* ${outside([literal("/dev/null"), ...workspace.allowedWrites.map(subpath)])})`,
    `(deny process-exec ${outside(programs.map(literal))})`,
    ...(controlPort === undefined ? ["(deny network*)"] : []),
  ].join("\n");
}

/** Consume only an in-memory proof minted for these exact owned paths and this current role. */
export function requireProbeConfinement(proof: ProbeConfinement, workspace: ProbeWorkspace): void {
  const state = proofs.get(proof);
  if (!state || state.workspace !== workspace || proof.workspace !== workspace || proof.profile !== state.profile
    || digest(JSON.stringify(proof.env)) !== state.digest) throw new ProbeConfinementError();
  state.current();
}

/** Model-free proof under the same lane profile. Unsupported or failed native proof is never a fixture pass. */
export async function verifyProbeConfinement(workspace: ProbeWorkspace, signal?: AbortSignal): Promise<ProbeConfinement> {
  if (!sandboxAvailable() || proofOwner || signal?.aborted) throw new ProbeConfinementError();
  probeWorkspaceCurrent(workspace);
  const pending = new Set<() => Promise<void>>();
  let active: Promise<unknown> | undefined;
  let closed = false;
  let cleaned = false;
  const owned = new Map<string, OwnedProofPath>();
  const remember = (file: string, directory: boolean): OwnedProofPath => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("probe setup resource ownership unavailable");
    const identity = { file, dev: stat.dev, ino: stat.ino, directory }; owned.set(file, identity); return identity;
  };
  const requireOwned = (identity: OwnedProofPath): boolean => {
    const stat = lstatSync(identity.file, { throwIfNoEntry: false });
    if (!stat && identity.optional) return false;
    if (!stat || stat.isSymbolicLink() || (identity.directory ? !stat.isDirectory() : !stat.isFile()) || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw new Error("probe setup resource ownership changed; retained for inspection");
    }
    return true;
  };
  const cleanup = () => {
    // Cleanup needs physical ownership, never the withdrawn actor/privacy execution authority.
    probeWorkspacePhysical(workspace);
    if (cleaned) return;
    for (const identity of owned.values()) if (!identity.removed) requireOwned(identity);
    for (const identity of owned.values()) if (!identity.directory && !identity.removed) {
      probeWorkspacePhysical(workspace); if (requireOwned(identity)) rmSync(identity.file); identity.removed = true;
    }
    for (const identity of [...owned.values()].filter(entry => entry.directory).sort((a, b) => b.file.length - a.file.length)) if (!identity.removed) {
      probeWorkspacePhysical(workspace); requireOwned(identity); rmdirSync(identity.file); identity.removed = true;
    }
    cleaned = true;
  };
  const stop = async () => {
    closed = true;
    if (active) await active;
    for (const close of [...pending]) { await close(); pending.delete(close); }
    cleanup();
    if (proofOwner?.workspace === workspace) proofOwner = undefined;
  };
  proofOwner = { workspace, stop };
  let server: ReturnType<typeof Bun.serve> | undefined;
  let retained = false;
  try {
    const laneProfile = restrictedProfile(workspace);
    const env = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: workspace.home, LANG: "C", TERM: "dumb" });
    const privateRoot = probeWorkspacePrivateRoot(workspace), temporaryRoot = probeWorkspaceTemporaryRoot(workspace);
    const roots = new Set([privateRoot, workspace.root, workspace.home, workspace.scratch, workspace.output]);
    const directory = (file: string): void => {
      probeWorkspacePhysical(workspace);
      const identity = owned.get(file);
      if (identity) { requireOwned(identity); return; }
      if (roots.has(file)) return;
      if (lstatSync(file, { throwIfNoEntry: false })) throw new ProbeConfinementError(stop);
      directory(dirname(file)); mkdirSync(file, { mode: 0o700 }); remember(file, true);
    };
    const write = (file: string) => {
      directory(dirname(file));
      const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fd); owned.set(file, { file, dev: stat.dev, ino: stat.ino, directory: false });
        writeFileSync(fd, PROOF_TOKEN);
      } finally { closeSync(fd); }
    };
    const labels = ["evaluator", "future-task", "other-arm", "control-receipt", ".git/objects/canary", "operator-file", "parent", "sibling"];
    const retainedBytes = Buffer.byteLength(PROOF_TOKEN) * (labels.length + 4);
    await reserveProbeWorkspaceStorage(workspace, retainedBytes);
    probeWorkspaceCurrent(workspace);
    if (signal?.aborted) throw new ProbeConfinementError(stop);
    const privateProof = realPath(mkdtempSync(join(privateRoot, "boundary-"))), positiveRoot = realPath(mkdtempSync(join(workspace.root, ".boundary-")));
    remember(privateProof, true); remember(positiveRoot, true);
    const readable = join(positiveRoot, "readable"), homeCanary = join(workspace.home, "credential-canary");
    write(readable); write(homeCanary);
    const readableIdentity = owned.get(readable)!;
    const hostLink = join(privateProof, "host-link-control"); linkSync(readable, hostLink);
    const hostIdentity = remember(hostLink, false); requireOwned(hostIdentity); rmSync(hostLink); hostIdentity.removed = true;
    const negatives = labels.map(label => join(privateProof!, label));
    for (const file of negatives) write(file);
    negatives.push(homeCanary);
    const writableRoot = workspace.allowedWrites[0];
    let writeControl: string | undefined, aliasControl: string | undefined;
    if (writableRoot) {
      directory(writableRoot);
      writeControl = join(writableRoot, ".probe-write-control"); write(writeControl);
      aliasControl = join(writableRoot, ".probe-alias-control");
      owned.set(aliasControl, { ...readableIdentity, file: aliasControl, optional: true });
    }
    let networkRequests = 0;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
      if (request.headers.has("origin")) return new Response("Origin refused", { status: 403 });
      networkRequests++; return new Response(PROOF_TOKEN);
    } });
    const positive = await fetch(`http://127.0.0.1:${server.port}/`, { signal: AbortSignal.timeout(PROOF_TIMEOUT_MS) });
    if (await positive.text() !== PROOF_TOKEN || networkRequests !== 1) throw new ProbeConfinementError(stop);
    if (signal?.aborted) throw new ProbeConfinementError(stop);
    networkRequests = 0;
    const run = async (argv: string[], commandProfile: string) => {
      probeWorkspaceCurrent(workspace);
      const command = sandboxedExec(argv, {
        cwd: workspace.root, profile: commandProfile, env: { ...env }, timeoutMs: PROOF_TIMEOUT_MS, ...(signal ? { signal } : {}),
        probe: { workspaceRoot: workspace.root, temporaryRoot, home: workspace.home, current: () => probeWorkspaceCurrent(workspace), physical: () => probeWorkspacePhysical(workspace) },
      });
      active = command;
      const result = await command; active = undefined;
      if (!result.quiescent) { if (result.stop) pending.add(result.stop); retained = true;
        throw new ProbeConfinementError(stop, { stage: "cleanup", code: result.code, output: result.output.slice(0, 1024) }); }
      probeWorkspaceCurrent(workspace);
      return result;
    };
    // Same utility and runtime constraints, with a single owned-loopback grant only for this positive control.
    const control = await run(["/usr/bin/nc", "-n", "-z", "-G", "1", "-w", "1", "127.0.0.1", String(server.port)], restrictedProfile(workspace, server.port));
    if (control.code !== 0 || signal?.aborted) throw new ProbeConfinementError(stop, { stage: "control", code: control.code, output: control.output.slice(0, 1024) });
    const script = [
      'set -eu',
      '[ "$(/bin/cat "$1")" = "probe-boundary-canary" ] || exit 11',
      'if [ "$2" = /dev/null ]; then printf x > /dev/null; else printf probe-boundary-canary > "$2"; fi',
      '[ -z "${OMNIROUTE_API_KEY-}${AWS_ACCESS_KEY_ID-}${AGENTHUB_CONTROL_TOKEN-}${HTTPS_PROXY-}${CODEX_THREAD_ID-}${AGENTHUB_PEER_ID-}" ] || exit 12',
      'readable="$1"; writable="$2"',
      'printf "PERMITTED\\n"',
      'port="$3"; alias="$4"; shift 4',
      'for file do if /bin/cat "$file" >/dev/null 2>&1; then exit 14; fi; if (printf bad > "$file") 2>/dev/null; then exit 15; fi; done',
      'first="$1"; if /bin/ln "$first" "$first.link" >/dev/null 2>&1; then exit 17; fi',
      'if /bin/ln -s "$first" "$first.alias" >/dev/null 2>&1; then exit 18; fi',
      'if /bin/mv "$first" "$first.moved" >/dev/null 2>&1; then exit 19; fi',
      'if [ "$alias" != /dev/null ]; then if /bin/ln "$readable" "$alias" >/dev/null 2>&1; then if (printf bad > "$alias") 2>/dev/null; then exit 20; fi; fi; fi',
      'if /usr/bin/nc -n -z -G 1 -w 1 127.0.0.1 "$port" >/dev/null 2>&1; then exit 16; fi',
      'printf "DENIED\\n"',
    ].join("\n");
    probeWorkspaceCurrent(workspace);
    const result = await run(["/bin/sh", "-c", script, "proof", readable, writeControl ?? "/dev/null", String(server.port), aliasControl ?? "/dev/null", ...negatives], laneProfile);
    probeWorkspaceCurrent(workspace);
    if (result.code !== 0 || result.output.trim() !== "PERMITTED\nDENIED" || networkRequests !== 0 || signal?.aborted)
      throw new ProbeConfinementError(stop, { stage: "lane", code: result.code, output: result.output.slice(0, 1024) });
    if (negatives.some(file => readFileSync(file, "utf8") !== PROOF_TOKEN)) throw new ProbeConfinementError(stop);
    if (readFileSync(readable, "utf8") !== PROOF_TOKEN) throw new ProbeConfinementError(stop);
    if (writeControl && readFileSync(writeControl, "utf8") !== PROOF_TOKEN) throw new ProbeConfinementError(stop);
    const proof: ProbeConfinement = Object.freeze({ workspace, profile: laneProfile, env, stop });
    proofs.set(proof, { workspace, profile: laneProfile, digest: digest(JSON.stringify(env)), current: () => { if (closed) throw new ProbeConfinementError(stop); probeWorkspaceCurrent(workspace); }, stop });
    return proof;
  } catch (error) {
    if (error instanceof ProbeConfinementError) throw error;
    throw new ProbeConfinementError(stop);
  } finally {
    if (server) await server.stop(true);
    if (!retained) {
      try { cleanup(); if (proofOwner?.workspace === workspace) proofOwner = undefined; }
      catch { throw new ProbeConfinementError(stop); }
    }
  }
}
