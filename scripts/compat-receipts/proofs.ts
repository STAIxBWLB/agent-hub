import { constants, openSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAUSES, ReceiptError, type Cause, type ProofContext, type ProofResults } from "./types.ts";

/** Proof imports happen in a worker whose environment is already isolated, never in the caller. */
export async function runManifestProofs(context: ProofContext): Promise<ProofResults> {
  const request = join(context.root, `request-${randomUUID()}.json`);
  const fd = openSync(request, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ id: context.id, version: context.version, root: context.root, home: context.home, prefix: context.prefix,
      cwd: context.cwd, limits: context.limits, artifact: context.artifact, entry: context.entry }));
  } finally { closeSync(fd); }
  try {
    const result = await context.run([process.execPath, fileURLToPath(new URL("./proof-worker.ts", import.meta.url)), request], {
      cwd: context.cwd, env: context.env, signal: context.signal, timeoutMs: context.limits.legMs, maxBytes: context.limits.outputBytes,
    });
    if (!result.ownedStopConfirmed) throw new ReceiptError("cleanup");
    if (result.timedOut || context.signal.aborted) throw new ReceiptError("timeout");
    const parsed: unknown = JSON.parse(result.stdout);
    if (result.exitCode !== 0) {
      const failure = (parsed as { failure?: unknown })?.failure;
      throw new ReceiptError(typeof failure === "string" && CAUSES.includes(failure as Cause) ? failure as Cause : "proof-failed");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ReceiptError("proof-failed");
    return parsed as ProofResults;
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    throw new ReceiptError("proof-failed");
  } finally { unlinkSync(request); }
}
