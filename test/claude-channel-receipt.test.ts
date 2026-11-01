import { realPath } from "../src/hub/project.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

test("new Claude plugin falls back to needs_review when an old hub rejects failed_safe (#434 follow-up)", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-channel-receipt-")));
  const receipts: Record<string, unknown>[] = [];
  let socket: { send(text: string): unknown } | undefined;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request, server) { return server.upgrade(request) ? undefined : new Response("not a websocket", { status: 400 }); }, websocket: {
    message(ws, data) {
      const message = JSON.parse(String(data));
      if (message.t === "hello") {
        socket = ws;
        ws.send(JSON.stringify({ t: "welcome", rid: message.rid, projectId: "channel-compat", instanceId: "old-hub", cwd: dir }));
      } else if (message.t === "delivery_receipt") {
        receipts.push(message);
        ws.send(JSON.stringify({ rid: message.rid, ok: message.state !== "failed_safe", ...(message.state === "failed_safe" ? { error: "invalid delivery receipt" } : {}) }));
      }
    },
  } });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ protocol: PROTOCOL, controlPort: server.port, projectId: "channel-compat", instanceId: "old-hub", cwd: dir }));
  writeFileSync(join(dir, "control-token"), "fixture-token");
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTHUB_STATE_DIR: dir, AGENTHUB_PROJECT_DIR: dir, AGENTHUB_PEER_ID: "claude" };
  delete env.AGENTHUB_CHANNEL; delete env.AGENTHUB_MODE;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/adapters/claude-channel.ts")], { cwd: dir, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let diagnostics = "";
  const stderr = (async () => { for await (const chunk of child.stderr) diagnostics = (diagnostics + Buffer.from(chunk).toString()).slice(-8192); })();
  const stdout = new Response(child.stdout).text();
  try {
    for (let i = 0; i < 200 && !diagnostics.includes('connected to hub as "claude"'); i++) await Bun.sleep(5);
    expect(diagnostics).toContain('connected to hub as "claude"');
    socket!.send(JSON.stringify({ t: "deliver", deliveryId: "old-delivery", generation: "old-generation", envs: [newEnvelope("user", "unseen work")] }));
    for (let i = 0; i < 100 && receipts.length < 2; i++) await Bun.sleep(5);
    expect(receipts.map(message => message.state)).toEqual(["failed_safe", "needs_review"]);
    expect(receipts[1]).toMatchObject({ deliveryId: "old-delivery", generation: "old-generation", reason: "this session cannot show channel pushes" });
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    await child.exited; clearTimeout(timer);
    await Promise.all([stderr, stdout]); server.stop(true); rmSync(dir, { recursive: true, force: true });
  }
});
