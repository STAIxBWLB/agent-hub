import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexPeer } from "../../src/adapters/codex-appserver.ts";
import { newEnvelope } from "../../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../../src/hub/peers.ts";
import { startFakeAppServer } from "../fakes/app-server.ts";
import { processTable } from "../../src/hub/child-process.ts";
import { until } from "./kit.ts";

class WatchdogCodex extends CodexPeer { expire(): void { this.onWatchdog(); } }
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "conformance-codex-")), fake = startFakeAppServer(), messages: string[] = [], receipts: DeliveryReceipt[] = [], usage: boolean[] = [];
  const peer = new WatchdogCodex("codex", { cwd: dir, upstreamUrl: fake.url, appPort: 0, proxyPort: 0, onUsage: (_reading, hard) => { usage.push(hard); } });
  peer.onMessage = text => { messages.push(text); }; peer.onDelivery = receipt => { receipts.push(receipt); };
  await peer.start();
  const seen: any[] = [], tui = new WebSocket(peer.proxyUrl);
  tui.onmessage = event => seen.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => { tui.onopen = () => resolve(); tui.onerror = () => reject(new Error("fake Codex TUI connection")); });
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "conformance-tui" } } }));
  await until(() => seen.some(row => row.id === 1), "Codex initialize consumed");
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { approvalPolicy: "untrusted" } }));
  await until(() => peer.state === "idle", "Codex thread adopted");
  return { peer, fake, messages, receipts, usage, tui, seen, async close() { try { tui.close(); await peer.stop(); } finally { fake.stop(); rmSync(dir, { recursive: true, force: true }); } } };
}

test("P4 Codex: permission overlays reach real turn RPC and ask restores the native baseline", async () => {
  const f = await fixture();
  try {
    for (const [mode, policy] of [["never-ask", "never"], ["ask", "untrusted"], ["ask-when-needed", "on-request"], ["ask", "untrusted"]] as const) {
      await f.peer.setPermissionMode(mode);
      const completed = f.messages.length;
      await f.peer.deliver([newEnvelope("user", `mode ${mode}`)]);
      await until(() => f.messages.length > completed && f.peer.state === "idle", "Codex policy turn settled");
      expect(f.fake.requests.filter(row => row.method === "turn/start").at(-1).params.approvalPolicy).toBe(policy);
    }
  } finally { await f.close(); }
});

test("P4 Codex: rejected admission is failed_safe; accepted quota failure remains needs_review", async () => {
  const f = await fixture();
  try {
    const refusal = f.peer.deliver([newEnvelope("user", "REFUSE_TURN")], "refusal").catch(error => error);
    await refusal;
    await until(() => f.receipts.some(receipt => receipt.id === "refusal"), "definitive rejection receipt");
    expect(f.receipts.find(receipt => receipt.id === "refusal")?.state).toBe("failed_safe");
    await until(() => f.peer.state === "idle", "Codex refusal releases occupancy");
    await f.peer.deliver([newEnvelope("user", "QUOTA")], "quota");
    await until(() => f.receipts.some(receipt => receipt.id === "quota" && receipt.state === "needs_review"), "accepted quota failure");
    expect(f.usage).toContain(true);
    expect(f.receipts.filter(receipt => receipt.id === "quota").map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
    expect(f.messages).toEqual([]);
  } finally { await f.close(); }
});

test("P4 Codex: watchdog fences a late result after observed native acceptance", async () => {
  const f = await fixture();
  try {
    await f.peer.deliver([newEnvelope("user", "SLOW:100")], "old");
    await until(() => f.receipts.some(receipt => receipt.state === "accepted"), "Codex native acceptance");
    f.peer.expire();
    // Forwarded turn/completed is a transport consumption barrier, not a guessed grace delay.
    await until(() => f.seen.some(row => row.method === "turn/completed"), "late result consumed");
    expect(f.messages).toEqual([]);
    expect(f.receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
    expect(f.peer.state).toBe("idle");
  } finally { await f.close(); }
});

test("P4 Codex: stopping owns the launcher's group and its native app-server child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conformance-codex-group-")), bin = join(dir, "codex"), launcher = join(dir, "launcher.pid"), native = join(dir, "native.pid");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(bin, `#!/bin/sh\necho $$ > ${quote(launcher)}\ntrap '' TERM\n${quote(process.execPath)} ${quote(join(import.meta.dir, "../fakes/codex-bin.ts"))} "$@" &\necho $! > ${quote(native)}\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const appPort = reservation.port!; reservation.stop(true);
  const peer = new CodexPeer("codex", { cwd: dir, bin, appPort, proxyPort: 0 });
  try {
    await peer.start();
    const leader = Number(readFileSync(launcher, "utf8")), child = Number(readFileSync(native, "utf8"));
    const before = processTable(); expect(before).toBeDefined();
    expect(before!.some(row => row.pid === child && row.pgid === leader)).toBe(true);
    await peer.stop();
    const after = processTable(); expect(after).toBeDefined();
    expect(after!.some(row => row.pid === child || row.pid === leader || row.pgid === leader)).toBe(false);
  } finally { await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
