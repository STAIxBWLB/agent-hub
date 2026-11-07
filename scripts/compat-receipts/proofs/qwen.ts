import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realPath } from "../../../src/hub/project.ts";
import type { CommandResult, ProofContext, ProofResult, ProofResults } from "../types.ts";

const ACP = "native-acp-auth-session-modes", PERMISSION = "actual-published-permission-handler", NETWORK = "preload-network-cleanup";
const ids = ["artifact-private-install-integrity", "reviewed-optional-lifecycle-replay", ACP, PERMISSION, NETWORK, "native-macos-repetition", "additional-linux"] as const;
const within = (root: string, value: string): boolean => {
  const suffix = relative(realPath(root), realPath(value));
  return suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix);
};
const proof = (status: ProofResult["status"], cause: ProofResult["cause"]): ProofResult => ({ status, cause });
function read(file: string, maximum: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = fstatSync(fd); if (!info.isFile() || info.size > maximum) throw new Error("invalid proof file"); return readFileSync(fd); }
  finally { closeSync(fd); }
}
function record(file: string, maximum: number): Record<string, unknown> | undefined {
  try { const value: unknown = JSON.parse(read(file, maximum).toString("utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
  catch { return undefined; }
}
function commandFailure(run: CommandResult, context: ProofContext): ProofResult {
  return proof("fail", !run.ownedStopConfirmed ? "cleanup" : run.timedOut ? "timeout" : context.signal.aborted ? "cancelled" : "proof-failed");
}
function cleanEnvironment(context: ProofContext): NodeJS.ProcessEnv {
  if (!context.env.PATH || !context.env.HOME || !isAbsolute(context.env.HOME) || realPath(context.env.HOME) !== realPath(context.home) || !within(context.root, context.home)) throw new Error("private HOME required");
  const env: NodeJS.ProcessEnv = { PATH: context.env.PATH, LANG: "C", LC_ALL: "C", TZ: "UTC", NO_COLOR: "1", CI: "1" };
  for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "AGENTHUB_HOME", "AMEM_HOME", "CODEX_HOME", "KIMI_CODE_HOME", "QWEN_HOME", "QWEN_RUNTIME_DIR", "CLAUDE_CONFIG_DIR"]) {
    const value = context.env[key];
    if (value === undefined) continue;
    if (!isAbsolute(value) || !within(context.root, value)) throw new Error("private environment required");
    env[key] = value;
  }
  return env;
}

/** Canonical promotions live beside this module; no historical proof body is embedded in the harness. */
export async function runQwenProofs(context: ProofContext): Promise<ProofResults> {
  const output: ProofResults = {};
  for (const id of ids) output[id] = proof("not-run", id === "reviewed-optional-lifecycle-replay" ? "source-review-required" : "producer-not-importable");
  const directory = join(context.root, "qwen-producer"), guard = fileURLToPath(new URL("./qwen-network.cjs", import.meta.url));
  let exported: string | undefined;
  try {
    if (context.id !== "qwen") throw new Error("Qwen producer id required");
    const env = cleanEnvironment(context), packageRoot = realPath(context.artifact.packageRoot);
    if (context.artifact.method !== "npm-exact" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(context.artifact.integrity) || !within(context.prefix, packageRoot)) throw new Error("exact private artifact required");
    const cli = join(packageRoot, "cli-entry.js"), command = context.artifact.command;
    if (command.length !== 1 || !isAbsolute(command[0]!) || realPath(command[0]!) !== realPath(cli)) throw new Error("candidate CLI mismatch");
    const metadata = record(join(packageRoot, "package.json"), context.limits.outputBytes);
    if (metadata?.name !== "@qwen-code/qwen-code" || metadata.version !== context.version) throw new Error("candidate identity mismatch");
    const chunks = join(packageRoot, "chunks"), chunkInfo = lstatSync(chunks);
    if (!chunkInfo.isDirectory() || chunkInfo.isSymbolicLink() || !within(packageRoot, chunks)) throw new Error("candidate chunk scope mismatch");
    const matches = readdirSync(chunks).filter(name => /^acpAgent-[A-Za-z0-9_-]+\.js$/.test(name));
    if (matches.length !== 1) throw new Error("candidate ACP chunk unavailable");
    const chunk = join(chunks, matches[0]!), source = read(chunk, context.limits.artifactBytes), cliSource = read(cli, context.limits.artifactBytes);
    const metadataSource = read(join(packageRoot, "package.json"), context.limits.outputBytes);
    const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
    const unchanged = () => digest(read(chunk, context.limits.artifactBytes)) === digest(source) && digest(read(cli, context.limits.artifactBytes)) === digest(cliSource)
      && digest(read(join(packageRoot, "package.json"), context.limits.outputBytes)) === digest(metadataSource);
    const node = Bun.which("node", { PATH: env.PATH! }), python = Bun.which("python3", { PATH: env.PATH! });
    if (!node || !python) throw new Error("producer runtime unavailable");
    mkdirSync(directory, { mode: 0o700 });
    const acpFile = join(directory, "acp-result.json"), acpConfig = join(directory, "acp-input.json");
    writeFileSync(acpConfig, JSON.stringify({ root: join(directory, "acp"), node, cli, version: context.version, output: acpFile, guard,
      runtimePath: env.PATH, maxBytes: context.limits.outputBytes, rpcTimeoutMs: Math.min(30_000, context.limits.legMs) }), { flag: "wx", mode: 0o600 });
    output["artifact-private-install-integrity"] = proof("pass", "ok");
    const acp = await context.run([python, "-I", fileURLToPath(new URL("./qwen-acp.py", import.meta.url)), acpConfig], {
      cwd: context.cwd, env, signal: context.signal, timeoutMs: context.limits.legMs, maxBytes: context.limits.outputBytes,
    });
    const native = record(acpFile, context.limits.outputBytes);
    const nativePassed = acp.exitCode === 0 && acp.ownedStopConfirmed && !acp.timedOut && !context.signal.aborted && unchanged()
      && native?.schemaVersion === 1 && native.version === context.version && native.passed === true && native.promptsSent === 0
      && ["identity", "protocol", "auth", "session", "fixtureModel", "modes"].every(key => native?.[key] === true);
    output[ACP] = nativePassed ? proof("pass", "ok") : commandFailure(acp, context);
    const group = native?.groupGone === true, network = native?.guardPositiveControl === true && typeof native.networkAttempts === "number" && native.networkAttempts >= 0;
    output[NETWORK] = !group ? proof("fail", "cleanup") : network && acp.exitCode === 0 && acp.ownedStopConfirmed && !acp.timedOut && unchanged() ? proof("pass", "ok") : commandFailure(acp, context);
    if (context.signal.aborted) return output;
    // The exports-only copy preserves candidate-relative imports and never edits
    // the original published chunk. O_EXCL refuses a pre-existing candidate path.
    const exportPath = join(chunks, "compat-receipt-qwen-exports.mjs");
    const fd = openSync(exportPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    exported = exportPath;
    try { writeFileSync(fd, Buffer.concat([source, Buffer.from("\nexport{SubAgentTracker,toPermissionOptions,resolvePermissionOutcome};\n")])); }
    finally { closeSync(fd); }
    const permissionFile = join(directory, "permission-result.json"), permissionConfig = join(directory, "permission-input.json"), permissionNetwork = join(directory, "permission-network.log");
    writeFileSync(permissionConfig, JSON.stringify({ moduleUrl: pathToFileURL(exported).href, output: permissionFile }), { flag: "wx", mode: 0o600 });
    const permission = await context.run([node, fileURLToPath(new URL("./qwen-permission.mjs", import.meta.url)), permissionConfig], {
      cwd: context.cwd, env: { ...env, NODE_OPTIONS: `--require ${JSON.stringify(guard)}`, PROBE_NETWORK_LOG: permissionNetwork }, signal: context.signal,
      timeoutMs: context.limits.legMs, maxBytes: context.limits.outputBytes,
    });
    const callback = record(permissionFile, context.limits.outputBytes), noPermissionNetwork = !lstatSync(permissionNetwork, { throwIfNoEntry: false }) || read(permissionNetwork, context.limits.outputBytes).length === 0;
    output[PERMISSION] = permission.exitCode === 0 && permission.ownedStopConfirmed && !permission.timedOut && !context.signal.aborted && unchanged()
      && noPermissionNetwork && callback?.schemaVersion === 1 && callback.passed === true && callback.permissionRequests === 2
      && callback.exactOptions === true && callback.allowOnce === true && callback.cancelledRespond === "cancel" && callback.unofferedRejected === true
      ? proof("pass", "ok") : commandFailure(permission, context);
    if (!unchanged()) for (const id of ["artifact-private-install-integrity", ACP, PERMISSION, NETWORK]) output[id] = proof("fail", "integrity");
    const complete = [ACP, PERMISSION, NETWORK].every(id => output[id]?.status === "pass");
    output["native-macos-repetition"] = process.platform === "darwin" && process.arch === "arm64" ? complete ? proof("pass", "ok") : proof("fail", "proof-failed") : proof("not-run", "platform");
    output["additional-linux"] = process.platform === "linux" ? complete ? proof("pass", "ok") : proof("fail", "proof-failed") : proof("not-run", "platform");
  } catch {
    for (const id of ["artifact-private-install-integrity", ACP, PERMISSION, NETWORK]) if (output[id]?.status !== "pass") output[id] = proof("fail", context.signal.aborted ? "cancelled" : "proof-failed");
  } finally {
    if (exported) try { rmSync(exported); } catch { output[PERMISSION] = proof("fail", "cleanup"); }
  }
  // These are producer/native-group observations only. The outer disposable
  // runner, not this module, owns process-lifetime containment and eligibility.
  return output;
}
