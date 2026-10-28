import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoomCommand, runRoomCommand, type RoomConfirmationIO } from "../src/cli/room.ts";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";
import { HELP } from "../src/cli/help.ts";
import { RoomCommands } from "../src/rooms/commands.ts";
import { RoomStore } from "../src/rooms/store.ts";
import { encodeRoomMessage } from "../src/rooms/application.ts";
import { createInvite, createJoin, createRoomEpoch, openFrame, sealFrame } from "../src/rooms/wire.ts";
import { encodeBase64url, sha256 } from "../src/rooms/crypto.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const fixedFrame = encodeBase64url(new Uint8Array(32)), ownerFp = "1".repeat(64), senderFp = "2".repeat(64), ticket = "a".repeat(43);
const nonTTY: RoomConfirmationIO = { isTTY: () => false, answer: async () => { throw new Error("must not prompt"); } };
test("resolve accepts a canonical frame digest that starts with dashes", () => {
  const bytes = new Uint8Array(32); bytes[0] = 251; bytes[1] = 224;
  const frame = encodeBase64url(bytes); expect(frame.startsWith("--")).toBe(true);
  expect(parseRoomCommand(["resolve", "work", "--frame", frame, "--action", "discard"])).toMatchObject({ op: "mutation", action: "resolve", input: { frame, action: "discard" } });
});
async function printed(work: (lines: string[]) => Promise<void>) {
  const lines: string[] = [], original = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(" ")); };
  try { await work(lines); return lines; } finally { console.log = original; }
}

test("room resolve parser accepts only a canonical frame digest and exact accept/discard disposition", () => {
  for (const action of ["accept", "discard"] as const) {
    const args = ["resolve", "work", "--frame", fixedFrame, "--action", action];
    expect(parseRoomCommand(args)).toEqual({ op: "mutation", action: "resolve", input: { name: "work", frame: fixedFrame, action } });
    expect(classifyPeerCommand("room", args)).toBe("console"); expect(liveTestRefusal("room", args)).toBe(true);
  }
  expect(HELP.some(row => row.usage.includes("room resolve <name> --frame <digest> --action accept|discard"))).toBe(true);
  for (const rest of [[], ["--frame", fixedFrame], ["--action", "accept"], ["--frame", "A".repeat(42) + "B", "--action", "accept"],
    ["--frame", `${fixedFrame}=`, "--action", "discard"], ["--frame", fixedFrame, "--action", "retry"], ["--frame", fixedFrame, "--action", "accept", "--yes"],
    ["--frame", fixedFrame, "--action", "accept", "--frame", fixedFrame], ["--frame", fixedFrame, "--action", "discard", "--json"]]) {
    expect(() => parseRoomCommand(["resolve", "work", ...rest])).toThrow("usage:");
  }
});

test("room resolve confirms the preview sender before execute and never executes No, EOF, mismatch or missing confirmation", async () => {
  for (const action of ["accept", "discard"]) {
    const requests: Record<string, unknown>[] = [];
    const lines = await printed(async lines => {
      await runRoomCommand(["resolve", "work", "--frame", fixedFrame, "--action", action, "--confirm", senderFp.slice(0, 16)], async message => {
        requests.push(message);
        if (message.op === "preview") return { ok: true, owner: ownerFp, member: senderFp, ticket };
        expect(lines).toEqual([`Owner fingerprint: ${ownerFp}`, `Member fingerprint: ${senderFp}`]);
        expect(message).toEqual({ t: "room", op: "execute", ticket, confirm: senderFp.slice(0, 16) });
        return { ok: true, name: "work", kind: "disposed" };
      }, nonTTY);
    });
    expect(requests).toHaveLength(2); expect(lines).toContain("room resolve: disposed");
    expect(lines.some(line => line.includes("artifact") || line.includes("completed"))).toBe(false);
    for (const mode of ["no", "eof", "missing", "mismatch"]) {
      const requests: Record<string, unknown>[] = [];
      await printed(async () => {
        await expect(runRoomCommand(["resolve", "work", "--frame", fixedFrame, "--action", action, ...(mode === "mismatch" ? ["--confirm", ownerFp] : [])], async message => {
          requests.push(message); return { ok: true, owner: ownerFp, member: senderFp, ticket };
        }, { isTTY: () => mode === "no" || mode === "eof", answer: async () => { if (mode === "eof") throw new Error("EOF"); return "n"; } })).rejects.toThrow(mode === "no" || mode === "eof" ? "not confirmed" : "confirmation");
      });
      expect(requests).toHaveLength(1); expect(requests[0]?.op).toBe("preview");
    }
  }
});

async function uncertain(left = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-rooms-resolve-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), directory = join(stateDir, "rooms"), owner = await RoomStore.open({ stateDir: directory }), guest = await RoomStore.open({ stateDir: join(root, "guest") });
  cleanups.push(() => owner.close(), () => guest.close());
  const initial = await createRoomEpoch({ owner: owner.identity, members: [{ ...owner.identity.public, label: "owner", exposedPeers: ["codex"] }] });
  await owner.install({ name: "work", broker: "ws://127.0.0.1:1/", wire: initial.wire, expectedDigest: null });
  const token = await createInvite({ owner: owner.identity, epoch: initial.epoch, broker: "ws://127.0.0.1:1/", expiresAt: Date.now() + 600000 });
  await owner.saveInvite("work", token);
  const request = await createJoin({ invite: token, identity: guest.identity, label: "guest", exposedPeers: ["claude"] });
  guest.savePendingJoin("work", { invite: token, request });
  const room = await owner.enroll("work", request); await guest.install({ name: "work", broker: room.broker, wire: room.wire, expectedDigest: null });
  const application = crypto.randomUUID();
  const wire = await sealFrame({ epoch: guest.get("work")!.current, identity: guest.identity, recipients: [owner.identity.public.fingerprint], sequence: guest.sequence,
    plaintext: encodeRoomMessage({ v: 1, type: "chat", envelope: { id: application, trace: crypto.randomUUID(), hop: 0, from: "claude", to: "codex", kind: "chat", priority: "status", body: "PRIVATE_RESOLUTION_CANARY", ts: Date.now() } }) });
  await openFrame({ wire, identity: owner.identity, current: room.current, replay: owner.replay });
  const frame = encodeBase64url(await sha256(wire));
  await owner.applicationIncoming("work", frame); expect(owner.claimApplication("work", frame)).toBe(true); owner.quarantineApplication("work", frame);
  if (left) owner.leave("work");
  const member = guest.identity.public.fingerprint, ownerFingerprint = owner.identity.public.fingerprint;
  owner.close(); guest.close();
  return { root, stateDir, directory, frame, application, member, owner: ownerFingerprint };
}

test("actual RoomCommands disposition works for a left room without dialing, publishing, claiming or signing a receipt", async () => {
  for (const action of ["accept", "discard"] as const) {
    const f = await uncertain(true), original = globalThis.WebSocket;
    let dials = 0;
    globalThis.WebSocket = class { constructor() { dials++; throw new Error("resolution must never dial"); } } as unknown as typeof WebSocket;
    const commands = new RoomCommands({ stateDir: f.stateDir, cwd: f.root }); cleanups.push(() => commands.stop());
    try {
      const preview = await commands.preview("resolve", { name: "work", frame: f.frame, action }, () => true);
      expect(preview).toMatchObject({ owner: f.owner, member: f.member });
      const result = await preview.commit();
      expect(result).toEqual({ name: "work", room: String((await commands.rows("work"))[0]!.room), owner: f.owner, member: f.member, kind: "disposed" });
      expect(result.artifact).toBeUndefined();
      await new Promise<void>(resolve => setImmediate(resolve)); expect(dials).toBe(0);
      await expect(commands.preview("resolve", { name: "work", frame: f.frame, action }, () => true)).rejects.toThrow("resolution_unavailable");
    } finally { commands.stop(); globalThis.WebSocket = original; }
    const restored = await RoomStore.open({ stateDir: f.directory }); cleanups.push(() => restored.close());
    expect(restored.get("work")?.left).toBe(true);
    expect(restored.incomingApplication("work", f.frame)).toMatchObject({ sender: f.member, application: f.application, state: "disposed", disposition: action, disposedBy: "user" });
    expect(restored.pendingInbox("work")).toEqual([]); expect(restored.applicationOutbox("work")).toEqual([]);
  }
});

test("actual incoming resolve preview refuses changed frame disposition and current authority before writes", async () => {
  const f = await uncertain(), commands = new RoomCommands({ stateDir: f.stateDir, cwd: f.root }); cleanups.push(() => commands.stop());
  let current = true;
  const stale = await commands.preview("resolve", { name: "work", frame: f.frame, action: "accept" }, () => current);
  current = false;
  await expect(stale.commit()).rejects.toThrow("state_changed");
  const first = await commands.preview("resolve", { name: "work", frame: f.frame, action: "accept" }, () => true);
  const second = await commands.preview("resolve", { name: "work", frame: f.frame, action: "discard" }, () => true);
  await second.commit(); await expect(first.commit()).rejects.toThrow("state_changed"); commands.stop();
  const restored = await RoomStore.open({ stateDir: f.directory }); cleanups.push(() => restored.close());
  expect(restored.incomingApplication("work", f.frame)).toMatchObject({ state: "disposed", disposition: "discard" });
  expect(restored.claimApplication("work", f.frame)).toBe(false); expect(restored.applicationReceipt("work", f.frame)).toBeUndefined();
  expect(restored.applicationOutbox("work")).toEqual([]);
});

test("real resolve CLI refuses agent markers and live-test before control access and does not echo the frame", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-resolve-cli-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const env: Record<string, string | undefined> = { ...process.env, HOME: join(root, "home"), AGENTHUB_HOME: join(root, "ahub"), KIMI_CODE_HOME: join(root, "kimi") };
  for (const key of ["CODEX_THREAD_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "AGENTHUB_PEER_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_DELIVERY_ONLY"]) delete env[key];
  for (const marker of [{ CODEX_THREAD_ID: "fixture" }, {}]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...(Object.keys(marker).length ? [] : ["--live-test"]), "room", "resolve", "work", "--frame", fixedFrame, "--action", "discard", "--confirm", senderFp],
      { cwd: root, env: { ...env, ...marker }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timer));
    expect(code).not.toBe(0); expect(out).toBe(""); expect(err).not.toContain(fixedFrame); expect(err).not.toContain("no hub running");
    expect(err).toContain(Object.keys(marker).length ? "agent" : "live-test cannot");
  }
});

test("room human status shows safe disposition, receipt evidence and remote targets without bodies", async () => {
  const application = crypto.randomUUID(), outgoing = crypto.randomUUID(), remote = "claude@hub-other";
  const row = { name: "work", room: fixedFrame, owner: ownerFp, member: senderFp, epoch: "2", state: "online", body: "PRIVATE_STATUS_CANARY",
    remotePeers: [{ id: remote, state: "idle", body: "PRIVATE_STATUS_CANARY" }],
    deliveries: [
      { direction: "inbound", id: fixedFrame, application, peer: "codex", state: "disposed (accept, by person)", disposition: "accept", body: "PRIVATE_STATUS_CANARY" },
      { direction: "inbound", id: fixedFrame, application, peer: "codex", state: "disposed", disposition: "discard" },
      { direction: "outbound", id: outgoing, application, peer: remote, state: "completed (admitted)" },
      { direction: "outbound", id: outgoing, application, peer: remote, state: "needs_review", disposition: "discard", lateReceipt: "completed (admitted)" },
      { direction: "inbound", pending: 0, needsReview: 1, truncated: true },
    ] };
  const reply = async () => ({ ok: true, rooms: [row] });
  const lines = await printed(async () => runRoomCommand(["status", "work"], reply));
  const human = lines.join("\n");
  expect(human).toContain(`peer ${remote}: idle`);
  expect(human).toContain("disposed (accept, by person)"); expect(human).toContain("disposed (discard, by person)");
  expect(human).toContain("completed (admitted)"); expect(human).toContain("late receipt evidence completed (admitted)");
  expect(human).toContain("inbound: pending 0, needs_review 1; truncated"); expect(human).not.toContain("PRIVATE_STATUS_CANARY");
  const json = await printed(async () => runRoomCommand(["status", "work", "--json"], reply));
  const projected = JSON.parse(json.join("\n"));
  expect(projected[0].remotePeers).toEqual([{ id: remote, state: "idle" }]);
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_STATUS_CANARY");
});

test("room status rejects arbitrary metadata text instead of rendering it as delivery evidence", async () => {
  const application = crypto.randomUUID(), id = crypto.randomUUID(), basic = { name: "work", room: fixedFrame, owner: ownerFp, member: senderFp, epoch: "2", state: "online" };
  for (const extra of [
    { deliveries: [{ direction: "outbound", id, application, peer: "claude@hub-other", state: "PRIVATE_CANARY" }] },
    { deliveries: [{ direction: "outbound", id, application, peer: "claude@hub-other", state: "needs_review", lateReceipt: "PRIVATE_CANARY" }] },
    { deliveries: [{ direction: "inbound", id: fixedFrame, application, peer: "codex", state: "disposed", disposition: "PRIVATE_CANARY" }] },
    { remotePeers: [{ id: "PRIVATE_CANARY\nforged", state: "idle" }] },
    { remotePeers: [{ id: "claude@hub-other", state: ["idle"] }] },
  ]) await printed(async lines => {
    await expect(runRoomCommand(["status", "work"], async () => ({ ok: true, rooms: [{ ...basic, ...extra }] }))).rejects.toThrow("invalid control reply");
    expect(lines).toEqual([]);
  });
});
