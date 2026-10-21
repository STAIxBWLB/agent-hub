import { expect, test } from "bun:test";
import type { Envelope } from "../../hub/envelope.ts";
import { newEnvelope } from "../../hub/envelope.ts";
import type { PeerAdapter } from "../../hub/peers.ts";

export async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  expect(condition(), label).toBe(true);
}
export interface ConformanceFixture {
  peer: PeerAdapter;
  messages: string[];
  /** Claude's native hooks own busy; channel insertion itself has no native acceptance evidence. */
  busyOnDeliver: boolean;
  settle?(): Promise<void>;
  verifyTransport(): void | Promise<void>;
  close(): Promise<void>;
}
export interface AdapterConformance {
  kind: string;
  create(): Promise<ConformanceFixture>;
}

/** Shared observable contract; every invocation uses the real adapter and its fake native transport. */
export function registerConformance(adapter: AdapterConformance): void {
  test(`P4 ${adapter.kind}: transport delivery, synchronous occupancy and owned teardown`, async () => {
    const f = await adapter.create();
    try {
      expect(f.peer.id).toBe(adapter.kind);
      expect(f.peer.state).toBe("idle");
      const envelope: Envelope = newEnvelope("user", "conformance ping", { to: [adapter.kind] });
      const delivering = f.peer.deliver([envelope]);
      // Attach the rejection observer before teardown, even if an assertion fails while delivery is pending.
      const outcome = delivering.then(() => undefined, error => error as Error);
      expect(f.peer.state).toBe(f.busyOnDeliver ? "busy" : "idle");
      expect(await outcome).toBeUndefined();
      await f.settle?.();
      await until(() => f.messages.length === 1 && f.peer.state === "idle", `${adapter.kind} one settled reply`);
      expect(f.messages[0]).not.toBeEmpty();
      await f.verifyTransport();
      const metadata = f.peer.recoveryMetadata?.();
      expect(JSON.stringify(metadata ?? {})).not.toContain("conformance ping");
    } finally { await f.close(); }
    await until(() => f.peer.state === "offline", `${adapter.kind} stop observed offline`);
  }, 20_000);
}

/** Host-owned authenticated channel fixtures share the observable delivery contract, not a driven native factory. */
export function registerExternalChannelConformance(adapter: AdapterConformance): void { registerConformance(adapter); }
