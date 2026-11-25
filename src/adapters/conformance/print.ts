import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEnvelope, USER } from "../../hub/envelope.ts";
import { sandboxAvailable } from "../../local/sandbox.ts";
import { ConfiguredPrintPeer, type ConfiguredPrintAdapterConfig } from "../configured-print.ts";

// used-by: src/adapters/conformance/index.ts
export function registerPrintConformance(): void {
  const run = async (script: string, timeoutS = 2) => {
    const cwd = mkdtempSync(join(tmpdir(), "ahub-print-conformance-"));
    const config: ConfiguredPrintAdapterConfig = { transport: "print", command: "/bin/sh", args: ["-c", script],
      stdin: true, versionArgs: ["-c", "printf fixture-v1"], versionPin: "fixture-v1", displayName: "Print fixture", timeoutS, roles: ["advisor"] };
    const peer = new ConfiguredPrintPeer("print-fixture", { declaration: config, cwd, stateDir: join(cwd, ".agenthub"),
      deny: () => [], privateTurn: () => false, publicText: () => true });
    const answers: { body: string; complete: boolean | undefined }[] = [];
    peer.onFinalAnswer = (body, _opts, complete) => answers.push({ body, complete });
    try {
      await peer.start();
      await peer.deliver([newEnvelope(USER, "fixture request")]);
      return { answers, wrote: existsSync(join(cwd, "write-proof")), state: peer.state };
    } finally {
      await peer.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  };

  test.skipIf(!sandboxAvailable())("print transport returns the bounded stdout answer", async () => {
    const result = await run("cat");
    expect(result.answers).toEqual([{ body: expect.stringContaining("fixture request"), complete: true }]);
    expect(result.state).toBe("idle");
  });

  test.skipIf(!sandboxAvailable())("print transport reports a timeout and joins the child", async () => {
    const result = await run("printf timeout-tail >&2; /bin/sleep 30", 1);
    expect(result.answers).toEqual([{ body: "Configured print timed out\ntimeout-tail", complete: false }]);
    expect(result.state).toBe("idle");
  });

  test.skipIf(!sandboxAvailable())("print transport reports a nonzero exit with stderr", async () => {
    const result = await run("printf fixture-diagnostic >&2; exit 7");
    expect(result.answers).toEqual([{ body: "Configured print exited unsuccessfully\nfixture-diagnostic", complete: false }]);
  });

  test.skipIf(!sandboxAvailable())("print transport marks an oversized successful answer", async () => {
    const result = await run("awk 'BEGIN { for(i=0;i<70000;i++) printf \"x\" }'");
    expect(result.answers[0]?.body).toEndWith("\n[print output truncated]");
    expect(result.answers[0]?.complete).toBe(true);
  });

  test.skipIf(!sandboxAvailable())("print transport cannot write to the project", async () => {
    const result = await run("if (printf unexpected > write-proof) 2>/dev/null; then exit 3; fi; printf blocked");
    expect(result.answers).toEqual([{ body: "blocked", complete: true }]);
    expect(result.wrote).toBe(false);
  });
}
