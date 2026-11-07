import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import { checkKimiReviewPolicy, projectKimiReviewPolicyBinding, type KimiReviewPolicyBinding } from "./kimi-review-policy.ts";
import type { ReviewerPolicyProbe } from "./reviewer-policy-watch.ts";

/** Trusted host fixture only: two numeric cells, entered count then release flag. */
export interface KimiReviewPolicyWorkerOptions { gate?: SharedArrayBuffer }
export type KimiReviewPolicyFactory = (binding: KimiReviewPolicyBinding) => ReviewerPolicyProbe;

export function startKimiReviewPolicyWatch(binding: KimiReviewPolicyBinding, options: KimiReviewPolicyWorkerOptions = {}): ReviewerPolicyProbe {
  const projected = projectKimiReviewPolicyBinding(binding);
  if (options.gate && options.gate.byteLength !== 8) throw new Error("review policy fixture gate is invalid");
  let worker: Worker;
  try {
    worker = new Worker(new URL("./kimi-review-policy-worker.js", import.meta.url), {
      env: {}, execArgv: [], stdout: true, stderr: true,
      workerData: { binding: projected, ...(options.gate ? { gate: options.gate } : {}) },
    });
  } catch { throw new Error("review policy worker could not start; retry the review"); }
  let failed = false, stopping = false, exited = false, sequence = 0;
  let pending: { id: number; resolve: (current: boolean) => void } | undefined;
  let stopWork: Promise<void> | undefined;
  let resolveExit!: () => void;
  const exit = new Promise<void>(resolve => { resolveExit = resolve; });
  const settle = (current: boolean) => { const request = pending; pending = undefined; request?.resolve(current); };
  const fail = () => { failed = true; settle(false); };
  worker.on("error", fail);
  worker.on("exit", () => { exited = true; fail(); resolveExit(); });
  try {
    // Never inherit/forward worker output. Unexpected output invalidates the proof.
    worker.stdout?.on("data", fail); worker.stderr?.on("data", fail);
    worker.on("message", (message: unknown) => {
      if (stopping || failed) return;
      if (!message || typeof message !== "object" || Array.isArray(message)) return fail();
      const reply = message as Record<string, unknown>;
      if (Object.keys(reply).sort().join() !== "current,id" || !pending || reply.id !== pending.id || typeof reply.current !== "boolean") return fail();
      if (!reply.current) failed = true;
      settle(reply.current);
    });
  } catch { fail(); } // Return ownership even if runtime stream setup failed.
  return {
    check() {
      if (failed || stopping || exited) return Promise.resolve(false);
      if (pending || sequence >= Number.MAX_SAFE_INTEGER) { fail(); return Promise.resolve(false); }
      return new Promise<boolean>(resolve => {
        pending = { id: ++sequence, resolve };
        try { worker.postMessage({ id: sequence }); } catch { fail(); }
      });
    },
    stop() {
      if (stopWork) return stopWork;
      stopping = true; fail();
      stopWork = (async () => {
        if (!exited) await worker.terminate();
        await exit;
      })().catch(() => {
        stopWork = undefined; // The same owner may explicitly retry an unconfirmed join.
        throw new Error("review policy worker stop is unconfirmed; retry stopping the review");
      });
      return stopWork;
    },
  };
}

if (!isMainThread) {
  const port = parentPort;
  if (!port || Object.keys(process.env).length !== 0 || process.execArgv.length !== 0) throw new Error("review policy worker environment is invalid");
  const data = workerData as { binding: KimiReviewPolicyBinding; gate?: SharedArrayBuffer };
  const binding = projectKimiReviewPolicyBinding(data.binding);
  const gate = data.gate ? new Int32Array(data.gate) : undefined;
  if (gate && gate.length !== 2) throw new Error("review policy fixture gate is invalid");
  let last = 0;
  port.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("review policy request is invalid");
    const request = message as Record<string, unknown>;
    if (Object.keys(request).join() !== "id" || request.id !== last + 1) throw new Error("review policy request is invalid");
    last++;
    if (gate) {
      Atomics.add(gate, 0, 1); Atomics.notify(gate, 0);
      while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0);
    }
    port.postMessage({ id: last, current: checkKimiReviewPolicy(binding) });
  });
}
