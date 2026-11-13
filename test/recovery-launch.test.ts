import { expect, test } from "bun:test";
import { createTerminal, type TerminalBinding, type TerminalRecoveryOptions } from "../src/cli/terminal-recovery.ts";

test("#1426 AC2 a rejected launch blocks before MAX_WAIT_MS even while the shell stays alive", async () => {
  const launch = { packageEntrypoint: "/fixture/main.js", command: "fixture", argv: [], env: {} };
  const binding: TerminalBinding = { peer: "pi", handle: "old", incarnationId: "old-i", worktreeId: "w", projectRoot: "/fixture", sessionId: "s", launch, launchMetadata: launch };
  const shown = { handle: "new", incarnationId: "new-i", worktreeId: "w", worktreePath: "/fixture", connected: true, orphaned: false };
  const now = Date.now, start = now(); let elapsed = 0;
  Date.now = () => start + elapsed;
  try {
    const options = {
      runner: async (argv: readonly string[]) => {
        if (argv[1] === "wait") { elapsed += Number(argv[argv.indexOf("--timeout-ms") + 1]); return { status: 1, stdout: JSON.stringify({ ok: false, error: { code: "timeout" } }) }; }
        return { result: { terminal: shown } };
      },
      launchFailure: () => ({ code: "version_refused", exitCode: 1, firstLine: "Version not verified: Pi 1.5.2" }),
    } as TerminalRecoveryOptions;
    const result = await createTerminal(binding, options);
    expect(elapsed, `restoration consumed ${elapsed}ms of MAX_WAIT_MS=600000 after its command already refused`).toBeLessThan(10_000);
    expect(result.blockers[0]?.code).toBe("launch-failed");
    expect(result.blockers[0]).toMatchObject({ failure: { code: "version_refused", exitCode: 1 } });
  } finally { Date.now = now; }
});
