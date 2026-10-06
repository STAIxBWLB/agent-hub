import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PiPeer } from "../src/adapters/pi.ts";
import { processSignature } from "../src/pi/process-signature.ts";

const modulePath = join(import.meta.dir, "../src/pi/process-signature.ts");

// What `ps` renders without the shared contract's LC_ALL=C/TZ=UTC pin.
function rawPs(pid: number, env: Record<string, string>): string {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart=,comm="], { stdout: "pipe", env: { ...process.env, ...env } });
  if (result.exitCode !== 0) throw new Error("test owner process is not visible");
  return result.stdout.toString().trim();
}

// The signature the extension computes for `pid` when its process runs under a different
// timezone/locale than this test process (issue #174: parent UTC, child on system time).
function foreignSignature(pid: number, env: Record<string, string>): string {
  const code = `import(${JSON.stringify(modulePath)}).then((m) => process.stdout.write(m.processSignature(${pid}) ?? ""))`;
  const result = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  if (result.exitCode !== 0) throw new Error(`foreign signature failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

test("the owner signature is stable across the reader's timezone and locale, which raw ps output is not", () => {
  const home = processSignature(process.pid);
  expect(home).toBeDefined();
  // The regression this pins down: unpinned, the same process renders differently per TZ.
  expect(rawPs(process.pid, { TZ: "UTC" })).not.toBe(rawPs(process.pid, { TZ: "America/New_York" }));
  expect(foreignSignature(process.pid, { TZ: "UTC", LC_ALL: "C" })).toBe(home!);
  expect(foreignSignature(process.pid, { TZ: "America/New_York" })).toBe(home!);
  expect(foreignSignature(process.pid, { TZ: "Asia/Seoul", LC_ALL: "C" })).toBe(home!);
});

// issue #174: a valid native owner claiming from a child on a different timezone is accepted;
// wrong/reused pids, altered signatures, wrong tokens and identity changes stay refused, and the
// owner monitor and recoveryReady re-inspect with the same contract the claim was checked with.
test("Pi owner claim and liveness use the normalized signature across timezones", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-tz-test-"));
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "tui", backend: "mlx", cmd: ["pi"], stopGraceMs: 200, relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "mlx/fast" }] }, tools: [], executeTool: async () => "ok" });
  const owner = Bun.spawn(["sleep", "30"]);
  try {
    await peer.start();
    const launch = peer.tuiLaunch!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const url = launch.env.AGENTHUB_PI_BRIDGE_URL!;
    const claim = (body: Record<string, unknown>) => fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "session_start", sessionId: "tz-session", sessionFile: "/tmp/tz-session.jsonl", ...body }) });
    const token = launch.env.AGENTHUB_PI_OWNER_TOKEN;

    const missingPid = await claim({ ownerToken: token, pid: 999_999_999, signature: "0".repeat(64) });
    expect(missingPid.status).toBe(409);
    expect(await missingPid.json()).toMatchObject({ error: expect.stringContaining("identity is not verified") });
    // A signature over the same process rendered in another timezone is an altered signature.
    const altered = await claim({ ownerToken: token, pid: owner.pid, signature: createHash("sha256").update(rawPs(owner.pid, { TZ: "America/New_York" })).digest("hex") });
    expect(altered.status).toBe(409);

    const accepted = await claim({ ownerToken: token, pid: owner.pid, signature: foreignSignature(owner.pid, { TZ: "America/New_York" }) });
    expect(accepted.status).toBe(200);
    expect(peer.state).toBe("idle");
    // The owner monitor re-inspects every 500ms; a mismatched contract would fence the live owner.
    await Bun.sleep(700);
    expect(peer.state).toBe("idle");
    expect(peer.recoveryReady).toBe(true);

    const signature = processSignature(owner.pid)!;
    const wrongToken = await claim({ ownerToken: "other", pid: owner.pid, signature, sessionId: "other-session" });
    expect(wrongToken.status).toBe(409);
    const reusedPid = await claim({ ownerToken: token, pid: owner.pid, signature: processSignature(process.pid)! });
    expect(reusedPid.status).toBe(409);
    const sessionMismatch = await claim({ ownerToken: token, pid: owner.pid, signature, sessionId: "other-session" });
    expect(sessionMismatch.status).toBe(409);
  } finally {
    const launch = peer.tuiLaunch;
    if (launch && peer.state !== "offline") {
      const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
      const stopping = peer.stop();
      const command = await (await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/commands`, { headers })).json() as any;
      await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify({ type: "session_shutdown" }) });
      if (command.command) await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/ack`, { method: "POST", headers, body: JSON.stringify({ id: command.command.id, ok: true }) });
      await stopping;
    }
    owner.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 30_000);
