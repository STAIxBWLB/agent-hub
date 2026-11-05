import { expect, test } from "bun:test";
import { generateHubIdentity } from "../src/rooms/crypto.ts";
import { canonicalBytes, createRoomEpoch, decodeFrame, openFrame, openOwnFrame, sealFrame } from "../src/rooms/wire.ts";

async function fixture() {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const { epoch } = await createRoomEpoch({ owner, members: [
    { ...owner.public, label: "owner", exposedPeers: ["codex"] },
    { ...guest.public, label: "guest", exposedPeers: ["codex"] },
  ] });
  let seq = 0;
  const sequence = { reserve: async () => String(++seq), isCurrent: () => true };
  const plaintext = new TextEncoder().encode("immutable retained outbound request");
  const wire = await sealFrame({ epoch, identity: owner, recipients: [guest.public.fingerprint], plaintext, sequence });
  return { owner, guest, epoch, sequence, plaintext, wire };
}

test("local outbound recovery authenticates its immutable send without receiver admission", async () => {
  const f = await fixture();
  expect(await openOwnFrame({ wire: f.wire, identity: f.owner, epoch: f.epoch })).toEqual(f.plaintext);
  let admissions = 0;
  const received = await openFrame({ wire: f.wire, identity: f.guest, current: f.epoch,
    replay: { accept: async () => { admissions++; return { status: "accepted", gap: "0" }; } } });
  expect(received.status).toBe("accepted");
  expect(admissions).toBe(1);
  const resealed = await sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint],
    plaintext: await openOwnFrame({ wire: f.wire, identity: f.owner, epoch: f.epoch }), sequence: f.sequence });
  expect(BigInt(decodeFrame(resealed).seq)).toBeGreaterThan(BigInt(decodeFrame(f.wire).seq));
  expect(await openOwnFrame({ wire: resealed, identity: f.owner, epoch: f.epoch })).toEqual(f.plaintext);
});

test("outbound recovery refuses foreign senders, changed ciphertext and presence frames", async () => {
  const f = await fixture();
  await expect(openOwnFrame({ wire: f.wire, identity: f.guest, epoch: f.epoch })).rejects.toThrow();
  const frame = decodeFrame(f.wire);
  const changed = canonicalBytes({ ...frame, nonce: frame.nonce === "AAAAAAAAAAAAAAAA" ? "BBBBBBBBBBBBBBBB" : "AAAAAAAAAAAAAAAA" });
  await expect(openOwnFrame({ wire: changed, identity: f.owner, epoch: f.epoch })).rejects.toThrow();
  const presence = await sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint],
    plaintext: canonicalBytes({ v: 1, type: "presence", peers: [] }), sequence: f.sequence, ephemeral: true });
  await expect(openOwnFrame({ wire: presence, identity: f.owner, epoch: f.epoch })).rejects.toThrow();
  const other = await fixture();
  await expect(openOwnFrame({ wire: f.wire, identity: f.owner, epoch: other.epoch })).rejects.toThrow();
});
