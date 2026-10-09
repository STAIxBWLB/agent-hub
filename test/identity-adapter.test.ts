import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";

for (const extra of [undefined, { AGENTHUB_PEER_ID: "user", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "stale-session", CODEX_THREAD_ID: "stale-thread", AGENTHUB_RECOVERY_OPERATION: "stale-operation", IDENTITY_CANARY: "kept" }]) {
  test(`Codex spawn sets its own identity ${extra ? "over conflicting launch markers" : "without optional environment"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenthub-identity-codex-"));
    const record = join(dir, "markers.json");
    const script = join(dir, "codex.js");
    writeFileSync(script, `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  peer: process.env.AGENTHUB_PEER_ID,
  claude: process.env.CLAUDECODE !== undefined,
  claudeSession: process.env.CLAUDE_CODE_SESSION_ID !== undefined,
  codexThread: process.env.CODEX_THREAD_ID !== undefined,
  recovery: process.env.AGENTHUB_RECOVERY_OPERATION !== undefined,
  canary: process.env.IDENTITY_CANARY,
}));
const url = new URL(process.argv[process.argv.indexOf("--listen") + 1]);
Bun.serve({ hostname: "127.0.0.1", port: Number(url.port), fetch: () => new Response("ok") });
`, { mode: 0o755 });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port!;
    reservation.stop(true);
    const peer = new CodexPeer("codex", { proxyPort: 0, appPort: port, cwd: dir, bin: script, ...(extra ? { env: extra } : {}) });
    try {
      await peer.start();
      const markers = JSON.parse(readFileSync(record, "utf8"));
      expect(markers.peer).toBe("codex");
      expect(markers.claude).toBe(false);
      expect(markers.claudeSession).toBe(false);
      expect(markers.codexThread).toBe(false);
      expect(markers.recovery).toBe(false);
      if (extra) expect(markers.canary).toBe("kept");
    } finally {
      await peer.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
}
