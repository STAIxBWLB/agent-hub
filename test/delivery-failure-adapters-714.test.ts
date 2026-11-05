import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpPeer } from "../src/adapters/acp.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../src/hub/peers.ts";

class WatchdogPeer extends AcpPeer {
  expireWatchdog(): void { this.onWatchdog(); }
}

test("an accepted ACP turn records a typed timeout at watchdog expiry and no late duplicate (#1178)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-failure-watchdog-714-"));
  const peer = new WatchdogPeer("kimi", {
    cwd: root,
    cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts"), "--mode-after-cancel"],
  });
  const receipts: DeliveryReceipt[] = [];
  let accepted!: () => void;
  const acceptance = new Promise<void>(resolve => { accepted = resolve; });
  peer.onDelivery = receipt => {
    receipts.push(receipt);
    if (receipt.id === "watchdog-delivery" && receipt.state === "accepted") accepted();
  };
  try {
    await peer.start();
    await peer.deliver([newEnvelope("user", "ACK_SLOW private-body-canary", { to: ["kimi"] })], "watchdog-delivery");
    await acceptance;
    expect(receipts.map(receipt => receipt.state)).toEqual(["accepted"]);
    peer.expireWatchdog();
    expect(receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
    expect(receipts.at(-1)?.failureCause).toBe("timeout");
    expect(JSON.stringify(receipts)).not.toContain("private-body-canary");
    // The fake answers this RPC after the cancelled result, proving it was consumed.
    await peer.setPermissionMode("ask");
    expect(receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
    expect(peer.state).toBe("offline");
  } finally {
    await peer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
