import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { renderStatus } from "../src/cli/output.ts";

// #572 AC1, the other half: an ACP peer the hub cannot steer (headless Kimi) never gets a turn cancelled to deliver.
// Its important messages wait, and status says how long once that passes budget.stale_min.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (condition: () => boolean) => { for (let i = 0; i < 300 && !condition(); i++) await Bun.sleep(10); expect(condition()).toBe(true); };

async function fixture(staleMin: number) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-busy-acp-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, "state"); mkdirSync(stateDir);
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, peers: { kimi: { start_mode: "headless" } }, roster: { kimi: true }, batch_ms: 0, budget: { ...DEFAULT_CONFIG.budget, stale_min: staleMin },
      kimi_cmd: ["bun", join(import.meta.dir, "fakes/acp-server.ts")],
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } } as never);
  cleanups.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
  expect((await client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  const status = async () => (await client.request({ t: "status" })).status;
  return { daemon, client, status };
}

test("an important message waiting on a busy ACP peer past budget.stale_min is reported, and the turn is never cancelled (#572 AC1)", async () => {
  const f = await fixture(1);
  f.daemon.bus.publish(newEnvelope("user", "SLOW work", { to: ["kimi"] }));
  await until(() => f.daemon.bus.peers.get("kimi")?.state === "busy");
  const important = newEnvelope("claude", "please move the checkout", { to: ["kimi"], priority: "important" });
  f.daemon.bus.publish({ ...important, ts: Date.now() - 5 * 60_000 }); // it has waited 5 min
  await until(() => f.daemon.bus.queuedImportant("kimi") === 1);
  const row = (await f.status()).peers.kimi;
  expect(row.queuedImportant).toBe(1);
  expect(row.importantWaitingSince).toBe(important.ts - 5 * 60_000);
  expect(row.importantWaitingNote).toMatch(/^1 important message waiting on a busy ACP peer for 5 min/);
  expect(f.daemon.bus.peers.get("kimi")!.state).toBe("busy"); // nothing was cancelled
  const text = renderStatus({ peers: { kimi: row } } as never, 120).map(line => line.map(span => span.text).join("")).join("\n");
  expect(text).toContain("important messages waiting on a busy ACP peer for 5 min");
});

test("a fresh important message waiting on a busy ACP peer says nothing yet (#572 AC1)", async () => {
  const f = await fixture(30);
  f.daemon.bus.publish(newEnvelope("user", "SLOW work", { to: ["kimi"] }));
  await until(() => f.daemon.bus.peers.get("kimi")?.state === "busy");
  f.daemon.bus.publish(newEnvelope("claude", "soon", { to: ["kimi"], priority: "important" }));
  await until(() => f.daemon.bus.queuedImportant("kimi") === 1);
  const row = (await f.status()).peers.kimi;
  expect(row.importantWaitingSince).toBeUndefined(); expect(row.importantWaitingNote).toBeUndefined();
});
