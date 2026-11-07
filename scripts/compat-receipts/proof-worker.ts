import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { realPath } from "../../src/hub/project.ts";
import { isCompatId } from "../../src/adapters/compat.ts";
import { ReceiptError, type ProofContext, type ProofResults } from "./types.ts";
import { runBoundedReceiptCommand } from "./runner.ts";

const INPUT_CAP = 1024 * 1024;
function inside(root: string, value: string): boolean {
  const rel = relative(root, realPath(value));
  return isAbsolute(value) && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new ReceiptError("input");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Omit<ProofContext, "run" | "env" | "signal">;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > INPUT_CAP) throw new ReceiptError("input");
    data = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  const root = realPath(dirname(file));
  const info = lstatSync(root);
  if (!basename(root).startsWith("ahub-compat-receipt-") || !info.isDirectory() || !process.getuid || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new ReceiptError("input");
  const allowed = new Set(["HOME", "PATH", "LANG", "LC_ALL", "TZ", "TERM", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "AGENTHUB_HOME", "AMEM_HOME", "CODEX_HOME", "KIMI_CODE_HOME", "QWEN_HOME", "QWEN_RUNTIME_DIR", "CLAUDE_CONFIG_DIR"]);
  if (Object.keys(process.env).some(key => !allowed.has(key))) throw new ReceiptError("input");
  if (!isCompatId(data.id) || realPath(data.root) !== root || !inside(root, data.prefix) || !inside(root, data.cwd) || !inside(root, data.home)) throw new ReceiptError("input");
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "AGENTHUB_HOME", "AMEM_HOME", "CODEX_HOME", "KIMI_CODE_HOME", "CLAUDE_CONFIG_DIR"]) {
    const value = process.env[key];
    if (!value || !inside(root, value) || !lstatSync(realPath(value)).isDirectory()) throw new ReceiptError("input");
  }
  if (realPath(process.env.HOME!) !== realPath(data.home) || !data.artifact.command.length || !inside(data.prefix, data.artifact.command[0]!)) throw new ReceiptError("input");
  const signal = AbortSignal.timeout(data.limits.legMs);
  const context: ProofContext = { ...data, env: { ...process.env }, signal, run: runBoundedReceiptCommand };
  let result: ProofResults = {};
  if (data.id === "codex-review") {
    const { runReviewerProofs } = await import("./proofs/reviewers.ts");
    result = await runReviewerProofs(context);
  } else if (data.id === "kimi-review") {
    const { runKimiProofs } = await import("./proofs/kimi.ts");
    result = await runKimiProofs(context);
  } else if (data.id === "qwen") {
    const { runQwenProofs } = await import("./proofs/qwen.ts");
    result = await runQwenProofs(context);
  } else if (data.id === "claude-implementer") {
    const { runClaudeProofs } = await import("./proofs/claude.ts");
    result = await runClaudeProofs(context);
  }
  process.stdout.write(JSON.stringify(result));
}
if (import.meta.main) {
  try { await main(); }
  catch (error) { process.stdout.write(JSON.stringify({ failure: error instanceof ReceiptError ? error.causeCode : "proof-failed" })); process.exitCode = 1; }
}
