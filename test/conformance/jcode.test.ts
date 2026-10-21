import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JcodePeer } from "../../src/adapters/jcode.ts";
import { newEnvelope } from "../../src/hub/envelope.ts";
import { createRegisteredPeer, expire } from "./factories.ts";
import { until } from "./kit.ts";
import { UNSUPPORTED_LEGS } from "./enrollment.ts";

test("P4 Jcode: watchdog waits for the consumed late native result without publishing it into a successor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conformance-jcode-watchdog-")), home = join(dir, "home"), release = join(dir, "release");
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const messages: string[] = [], failed: unknown[] = [];
  const peer = createRegisteredPeer<JcodePeer>("jcode", { jcode: { cwd: dir, home,
    command: [process.execPath, join(import.meta.dir, "../fakes/jcode-agent.ts"), "--steer-file", release],
  } });
  peer.onMessage = text => { messages.push(text); }; peer.onFailed = envelopes => { failed.push(envelopes); };
  try {
    await peer.start();
    expect(UNSUPPORTED_LEGS["jcode:native-mode-ack"]).toContain("no verified native permission-mode mapping");
    expect(peer.permissionModeState).toBe("unmanaged");
    await expect(peer.setPermissionMode("ask")).rejects.toThrow("no verified mode mapping");
    await peer.deliver([newEnvelope("user", "old Jcode turn")]);
    await until(() => existsSync(`${release}.busy`), "native Jcode consumed the held prompt");
    expire(peer);
    expect(peer.state).toBe("busy"); expect(messages).toEqual([]);
    writeFileSync(release, "release");
    // Returning idle proves the old prompt settled, not merely that a cancel notification was written.
    await until(() => peer.state === "idle", "Jcode late prompt result consumed after watchdog cancellation");
    expect(messages).toEqual([]); expect(failed).toEqual([]);
    await peer.deliver([newEnvelope("user", "successor Jcode turn")]);
    await until(() => messages.length === 1 && peer.state === "idle", "only the successor Jcode answer publishes");
    expect(messages).toEqual(["JCODE_REPLY"]);
  } finally { writeFileSync(release, "release"); await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
