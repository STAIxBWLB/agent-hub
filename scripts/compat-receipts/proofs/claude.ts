import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProofContext, ProofResult, ProofResults } from "../types.ts";

// Run the committed producer unchanged, including its native assertions and cleanup.
const PYTHON_BRIDGE = "import runpy,sys; producer=sys.argv[1]; sys.argv=sys.argv[1:]; runpy.run_path(producer,run_name='__main__')";
const TRANSPORT_CASES = ["allow", "deny", "missing-tool", "hook-deny", "hook-allow", "mcp-error", "disconnect", "pending", "deadline"] as const;
const WRAPPER_IDS = ["wrapper-cwd", "wrapper-root", "wrapper-executable", "wrapper-poison-env", "wrapper-host-env", "wrapper-tmp", "wrapper-replay", "wrapper-effect-once", "wrapper-quoted-paths", "wrapper-cleanup", "wrapper-binary-fence"] as const;
const result = (status: ProofResult["status"], cause: ProofResult["cause"]): ProofResult => ({ status, cause });

function receiptCases(file: string, maxBytes: number): Record<string, unknown>[] | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    const receipt: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!receipt || typeof receipt !== "object") return undefined;
    const value = receipt as Record<string, unknown>;
    if (value.account !== false || value.inference !== false || !Array.isArray(value.cases)) return undefined;
    return value.cases.every(row => row && typeof row === "object" && !Array.isArray(row)) ? value.cases : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function runClaudeProofs(context: ProofContext): Promise<ProofResults> {
  const output: ProofResults = {};
  const groups = [
    { name: "write", producer: "claude-permission-transport-native.py", args: [], cases: [...TRANSPORT_CASES], ids: TRANSPORT_CASES.map(name => `write-${name}`) },
    { name: "bash", producer: "claude-permission-transport-native.py", args: ["--tool", "Bash", "--server-name", "agent-hub", "--permission-tool", "hub_permission_request", "--require-tool-use-id"], cases: [...TRANSPORT_CASES], ids: TRANSPORT_CASES.map(name => `bash-${name}`) },
    { name: "rewrite", producer: "claude-permission-transport-native.py", args: ["--tool", "Bash", "--rewrite-bash", "--server-name", "agent-hub", "--permission-tool", "hub_permission_request", "--require-tool-use-id"], cases: ["allow", "deny"], ids: ["bash-rewrite-allow", "bash-rewrite-deny"] },
    { name: "wrapper", producer: "claude-shell-wrapper-native.py", args: ["--bun", process.execPath], cases: ["context", "normalized"], ids: [...WRAPPER_IDS] },
  ];
  const binary = context.artifact.command[0];
  const python = Bun.which("python3", { PATH: context.env.PATH ?? "" });
  if (!python || !binary || !isAbsolute(binary) || context.artifact.command.length !== 1) {
    for (const group of groups) for (const id of group.ids) output[id] = result("not-run", "input");
    return output;
  }
  for (const group of groups) {
    const destination = join(context.root, `claude-${group.name}`);
    const producer = fileURLToPath(new URL(`../../../docs/verification/${group.producer}`, import.meta.url));
    const run = await context.run([python, "-I", "-c", PYTHON_BRIDGE, producer, destination, "--claude", binary, "--expected-version", context.version, "--runtime-path", context.env.PATH ?? "", ...group.args], {
      cwd: context.cwd, env: context.env, signal: context.signal, timeoutMs: context.limits.legMs, maxBytes: context.limits.outputBytes,
    });
    const rows = receiptCases(join(destination, "receipt.json"), context.limits.outputBytes);
    const cause = !run.cleanup ? "cleanup" : run.timedOut ? "timeout" : context.signal.aborted ? "cancelled" : "proof-failed";
    for (const id of group.ids) output[id] = result("fail", cause);
    if (run.exitCode !== 0 || !run.cleanup || run.timedOut || context.signal.aborted || !rows || rows.length !== group.cases.length) continue;
    const byCase = new Map(rows.map(row => [row.case, row]));
    if (byCase.size !== group.cases.length || !group.cases.every(name => byCase.has(name))) continue;
    if (!rows.every(row => row.nativeGroupEmpty === true && (group.name !== "wrapper" || row.hostStopped === true))) {
      for (const id of group.ids) output[id] = result("fail", "cleanup");
      continue;
    }
    const passed = (name: string): boolean => {
      const row = byCase.get(name);
      return typeof row?.version === "string" && row.version.split(/\s+/)[0] === context.version && row.passed === true && row.nativeGroupEmpty === true && row.binaryUnchanged === true;
    };
    if (group.name !== "wrapper") {
      for (const [index, name] of group.cases.entries()) if (passed(name)) output[group.ids[index]!] = result("pass", "ok");
      continue;
    }
    // Each normalized case assertion below runs before passed=true in the producer.
    const control = byCase.get("context"), normalized = byCase.get("normalized");
    if (passed("context") && control?.persistentCwd === true && control.hostStopped === true) output["wrapper-cwd"] = result("pass", "ok");
    if (passed("normalized") && normalized?.hostStopped === true && normalized.rewrite === true && normalized.priorCd === true && normalized.environmentIsolation === true && normalized.replayRefused === true && normalized.effects === 1 && normalized.quotedPaths === true) {
      for (const id of WRAPPER_IDS) if (id !== "wrapper-cwd") output[id] = result("pass", "ok");
    }
  }
  return output;
}
