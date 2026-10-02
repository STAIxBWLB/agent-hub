import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPeer } from "../src/adapters/local-worker.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import type { OmniRoute } from "../src/omniroute/client.ts";

test("local peer reports successful provider calls once, including missing usage, without prompt data", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-local-usage-")));
  const records: { id: string; at: string; requestedModel: string; servedModel?: string; provider?: string; usage?: { inputTokens?: number; outputTokens?: number } }[] = [];
  let call = 0;
  const omni = {
    chat: async () => ++call === 1
      ? { message: { role: "assistant" as const, content: "answer" }, usage: { inputTokens: 7, outputTokens: 2 }, servedModel: "vendor/served", provider: "vllm" }
      : { message: { role: "assistant" as const, content: "answer" } },
    onCampus: async () => true,
    isAccessHost: () => false,
  } as unknown as OmniRoute;
  const peer = new LocalPeer("local", { cwd, omni, fixedModel: "coding", tools: { deny: [], permit: async () => true }, onUsage: (record) => records.push(record) });
  const waitIdle = async () => {
    for (let i = 0; i < 100 && peer.state !== "idle"; i++) await Bun.sleep(5);
    expect(peer.state).toBe("idle");
  };
  try {
    await peer.start();
    await peer.deliver([newEnvelope("user", "private prompt sentinel", { to: ["local"] })]);
    await waitIdle();
    await peer.deliver([newEnvelope("user", "another prompt", { to: ["local"] })]);
    await waitIdle();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ usage: { inputTokens: 7, outputTokens: 2 }, requestedModel: "coding", servedModel: "vendor/served", provider: "vllm" });
    expect(records[1]).toMatchObject({ requestedModel: "coding" });
    expect(records[1]).not.toHaveProperty("usage");
    expect(JSON.stringify(records)).not.toContain("private prompt sentinel");
    expect(records[0]).not.toMatchObject({ id: records[1]!.id });
  } finally {
    await peer.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
