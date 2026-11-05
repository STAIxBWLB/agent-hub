import { expect, test } from "bun:test";
import { projectRoomStatus } from "../src/rooms/status.ts";
import { encodeBase64url } from "../src/rooms/crypto.ts";
import { runRoomCommand } from "../src/cli/room.ts";

const room = encodeBase64url(new Uint8Array(32)), owner = "a".repeat(64), member = "b".repeat(64);
const base = { name: "work", room, owner, member, epoch: "2", state: "online" };
const delivery = "11111111-1111-4111-8111-111111111111";
async function capture(run: (lines: string[]) => Promise<void>): Promise<string> {
  const lines: string[] = [], original = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(" ")); };
  try { await run(lines); return lines.join("\n"); } finally { console.log = original; }
}

test("room liveness status keeps native state while displaying signed offline and unknown presence", async () => {
  const peers = [{ id: "codex@guest", state: "busy", presence: "offline" }, { id: "kimi@guest", state: "offline", presence: "unknown" }];
  expect(projectRoomStatus([{ ...base, remotePeers: peers }])[0]?.remotePeers).toEqual(peers);
  const output = await capture(async () => {
    await runRoomCommand(["status", "work"], async () => ({ ok: true, rooms: [{ ...base, remotePeers: peers }] }));
  });
  expect(output).toContain("peer codex@guest: offline");
  expect(output).toContain("peer kimi@guest: unknown");
  expect(output).not.toContain("codex@guest: busy");
});

test("legacy liveness is explicitly untracked with a broker upgrade step and no arbitrary text", async () => {
  const peers = [{ id: "codex@guest", state: "idle", presence: "idle", liveness: "untracked", detail: "PRIVATE_CANARY" }];
  const projected = projectRoomStatus([{ ...base, remotePeers: peers }]);
  expect(projected[0]?.remotePeers?.[0]).toEqual({ id: "codex@guest", state: "idle", presence: "idle", liveness: "untracked" });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_CANARY");
  const output = await capture(async () => {
    await runRoomCommand(["status", "work"], async () => ({ ok: true, rooms: [{ ...base, remotePeers: peers }] }));
  });
  expect(output).toContain("liveness not tracked (broker without ephemeral)");
  expect(output).toContain("upgrade the broker");
  expect(output).not.toContain("PRIVATE_CANARY");
});

test("malformed liveness metadata stays unknown without evaluating accessors", () => {
  let calls = 0;
  const peer = { id: "codex@guest", state: "idle", get presence() { calls++; return "idle"; } };
  expect(projectRoomStatus([{ ...base, remotePeers: [peer] }])[0]?.remotePeers).toBeNull();
  expect(calls).toBe(0);
  expect(projectRoomStatus([{ ...base, remotePeers: [{ id: "codex@guest", state: "idle", liveness: "PRIVATE_CANARY" }] }])[0]?.remotePeers).toBeNull();
  expect(projectRoomStatus([{ ...base, remotePeers: [{ id: "codex@guest", state: "idle" }] }])[0]?.remotePeers).toEqual([{ id: "codex@guest", state: "idle" }]);
});

test("the real room CLI lists outstanding IDs before execution and prints the epoch-rotated cause", async () => {
  let executions = 0;
  const previewOutput = await capture(async lines => {
    await runRoomCommand(["expose", "work", "codex", "--confirm", member.slice(0, 16)], async message => {
      if (message.op === "preview") return { ok: true, owner, member, ticket: "t".repeat(43), outstanding: [delivery], body: "PRIVATE_CANARY" };
      expect(lines.join("\n")).toContain(delivery);
      expect(message).not.toHaveProperty("outstanding");
      executions++;
      return { ok: true, name: "work" };
    });
  });
  expect(executions).toBe(1);
  expect(previewOutput).toContain("Outstanding deliveries on the old epoch (1)");
  expect(previewOutput).not.toContain("PRIVATE_CANARY");
  const status = await capture(async () => {
    await runRoomCommand(["status", "work"], async () => ({ ok: true, rooms: [{ ...base, deliveries: [{
      direction: "outbound", id: delivery, application: delivery, peer: "codex@guest", state: "needs_review", holdReason: "epoch rotated",
    }] }] }));
  });
  expect(status).toContain("reason epoch rotated; inspect ahub queue show");
});

test("invalid preview IDs refuse before execute, and a committed-rotation hold failure names the next step", async () => {
  let executes = 0;
  const output = await capture(async () => {
    await expect(runRoomCommand(["expose", "work", "--confirm", member.slice(0, 16)], async message => {
      if (message.op === "preview") return { ok: true, owner, member, ticket: "t".repeat(43), outstanding: ["PRIVATE_CANARY with text"] };
      executes++; return { ok: true };
    })).rejects.toThrow("invalid control reply");
  });
  expect(executes).toBe(0); expect(output).not.toContain("PRIVATE_CANARY");
  await capture(async () => {
    await expect(runRoomCommand(["expose", "work", "--confirm", member.slice(0, 16)], async message =>
      message.op === "preview" ? { ok: true, owner, member, ticket: "t".repeat(43), outstanding: [] }
        : { ok: false, code: "epoch_rotated_hold_unavailable", error: "PRIVATE_CANARY" })).rejects.toThrow("epoch rotated but delivery journal holds are unavailable; inspect ahub room status");
  });
});
