import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { UsageRollup } from "../src/hub/usage-rollup.ts";
import { ControlClient, retryLaunchConnect } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

test("an expired fold slice commits one complete Unicode record and later passes retain rebuild parity (#719)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-fold-yield-")), log = join(dir, "events.jsonl");
  const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify({ v: 1, at: new Date(1_800_000_000_000 + i).toISOString(), type: "tokens", peer: "codex", n: i + 1, attribution: "unattributed", pad: "한글" }) + "\n");
  writeFileSync(log, lines.join(""));
  const rollup = new UsageRollup(join(dir, "hub.db"), log);
  try {
    expect(rollup.poll(0)).toEqual({ bytes: Buffer.byteLength(lines[0]!), done: false });
    let passes = 1;
    while (!rollup.poll(0).done) { passes++; expect(passes).toBeLessThan(13); }
    const expected = rollup.dump(); rollup.rebuild(); expect(rollup.dump()).toEqual(expected);
    expect(rollup.query({ by: "peer" }).rows[0]?.counted.value).toBe(78);
  } finally { rollup.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a native launch connection starts during a cold 50 MB roll-up pass (#719)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-cold-connect-")), stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  const log = join(stateDir, "events.jsonl");
  const row = JSON.stringify({ v: 1, at: "2026-10-23T00:00:00.000Z", type: "tokens", peer: "codex", n: 1, attribution: "unattributed", pad: "x".repeat(400) }) + "\n";
  // Write in bounded blocks instead of retaining a second 50 MB string fixture.
  const block = row.repeat(1000); for (let n = 0; n < 100; n++) appendFileSync(log, block);
  expect(statSync(log).size).toBeGreaterThan(50 * 1024 * 1024);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined, launchClient: ControlClient | undefined;
  const poll = UsageRollup.prototype.poll;
  const db = () => new Database(join(stateDir, "hub.db"), { readonly: true });
  try {
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
    const before = db();
    try { expect((before.query("SELECT byte_offset FROM rollup_state WHERE id = 1").get() as { byte_offset: number }).byte_offset).toBeLessThan(statSync(log).size); }
    finally { before.close(); }
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    let launch: Promise<ControlClient | Error> | undefined, pendingAtFold = false;
    UsageRollup.prototype.poll = function (maxMs) {
      // The launch socket starts inside the real daemon's catch-up pass, before its
      // synchronous fold. The separate expired-slice test proves the yield boundary.
      UsageRollup.prototype.poll = poll;
      const check = db();
      try { pendingAtFold = (check.query("SELECT byte_offset FROM rollup_state WHERE id = 1").get() as { byte_offset: number }).byte_offset < statSync(log).size; }
      finally { check.close(); }
      launch = retryLaunchConnect(timeout => ControlClient.connect(stateDir, { role: "console", projectRoot: root }, timeout), () => {}).then(value => value, error => error as Error);
      return poll.call(this, maxMs);
    };
    expect((await client.request({ t: "usage", by: "peer" }, 3000)).ok).toBe(true);
    expect(pendingAtFold).toBe(true); expect(launch).toBeDefined();
    const result = await launch!; if (result instanceof Error) throw result;
    launchClient = result;
    expect((await launchClient.request({ t: "status" }, 3000)).status.cwd).toBe(root);
  } finally { UsageRollup.prototype.poll = poll; launchClient?.close(); client?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
