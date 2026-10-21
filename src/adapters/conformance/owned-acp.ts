import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JcodePeer } from "../jcode.ts";
import { newEnvelope } from "../../hub/envelope.ts";
import { fakePaths } from "./fake-paths.ts";
import type { AdapterDefinition } from "../registry-types.ts";
import { createFromDefinition, expire } from "./factories.ts";
import { until } from "./kit.ts";


/** The owned-ACP protocol flavor and its unmanaged mode ceiling are supplied explicitly. */
export function registerOwnedAcpConformance(definition: AdapterDefinition, { label = definition.displayName, unmanagedReason }: { label?: string; unmanagedReason?: string } = {}): void {
  if (definition.start.daemonPort !== "owned-acp") throw new Error(definition.kind + ": conformance requires owned-acp transport factory");
  if (!unmanagedReason?.trim()) throw new Error(definition.kind + ": owned-ACP unmanaged mode reason must be explicit");
  test(`P4 ${label}: watchdog waits for the consumed late native result without publishing it into a successor`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "conformance-jcode-watchdog-")), home = join(dir, "home"), release = join(dir, "release");
    mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
    const messages: string[] = [], failed: unknown[] = [];
    const peer = createFromDefinition<JcodePeer>(definition, { jcode: { cwd: dir, home,
      command: [process.execPath, fakePaths.jcodeAgent, "--steer-file", release],
    } });
    peer.onMessage = text => { messages.push(text); }; peer.onFailed = envelopes => { failed.push(envelopes); };
    try {
      await peer.start();
      expect(unmanagedReason).toContain("no verified native permission-mode mapping");
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

}
