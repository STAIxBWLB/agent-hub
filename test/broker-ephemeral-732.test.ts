import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerStore } from "../src/broker/store.ts";
import { generateHubIdentity, type HubIdentity } from "../src/rooms/crypto.ts";
import { createRoomEpoch, sealFrame, verifyPublicFrame, verifyPublicRoster } from "../src/rooms/wire.ts";

const member = (identity: HubIdentity, label: string) => ({ ...identity.public, label, exposedPeers: ["codex"] });
async function fixture() {
  const owner = await generateHubIdentity(), online = await generateHubIdentity(), offline = await generateHubIdentity();
  const created = await createRoomEpoch({ owner, members: [member(owner, "owner"), member(online, "online"), member(offline, "offline")] });
  const roster = await verifyPublicRoster({ wire: created.wire, pin: { room: created.epoch.room, owner: owner.public.fingerprint, minEpoch: "0" } });
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-broker-ephemeral-"));
  const store = await BrokerStore.open({ stateDir, limits: { queuedPerRoom: 2, queuedGlobal: 2 } });
  store.install(roster, owner.public.fingerprint);
  let sequence = 0;
  const frame = async (ephemeral = true) => {
    const wire = await sealFrame({ epoch: created.epoch, identity: owner, recipients: [online.public.fingerprint, offline.public.fingerprint].sort(), plaintext: new TextEncoder().encode("presence-or-chat"), ...(ephemeral ? { ephemeral: true as const } : {}), sequence: { reserve: async () => String(++sequence), isCurrent: () => true } });
    return verifyPublicFrame({ wire, roster });
  };
  return { owner, online, offline, roster, stateDir, store, frame, cleanup: () => { store.close(); rmSync(stateDir, { recursive: true, force: true }); } };
}

test("ephemeral broker frames replace one sender, exclude offline recipients, and share existing caps", async () => {
  const f = await fixture();
  try {
    const chat = await f.frame(false);
    f.store.enqueue(chat, f.owner.public.fingerprint);
    const first = await f.frame();
    f.store.enqueue(first, f.owner.public.fingerprint, [f.online.public.fingerprint]);
    let latest = first;
    for (let n = 0; n < 1000; n++) {
      latest = await f.frame();
      f.store.enqueue(latest, f.owner.public.fingerprint, [f.online.public.fingerprint]);
    }
    expect(f.store.stats().queuedFrames).toBe(2);
    expect(f.store.next(f.roster.room, f.offline.public.fingerprint)?.digest).toBe(chat.digest);
    f.store.ack(f.roster.room, f.online.public.fingerprint, chat.digest);
    f.store.ack(f.roster.room, f.offline.public.fingerprint, chat.digest);
    expect(f.store.next(f.roster.room, f.offline.public.fingerprint)).toBeUndefined();
    expect(f.store.next(f.roster.room, f.online.public.fingerprint)?.digest).toBe(latest.digest);
    expect(f.store.enqueue(latest, f.owner.public.fingerprint, [f.online.public.fingerprint]).duplicate).toBe(true);
    f.store.disconnect(f.roster.room, f.online.public.fingerprint);
    expect(f.store.stats().queuedFrames).toBe(0);
    const noRecipient = await f.frame();
    f.store.enqueue(noRecipient, f.owner.public.fingerprint);
    expect(f.store.stats().queuedFrames).toBe(0);
    expect(f.store.enqueue(noRecipient, f.owner.public.fingerprint).duplicate).toBe(true);
  } finally { f.cleanup(); }
});

test("broker reopen discards ephemeral recipients but preserves durable traffic and replay floors", async () => {
  const f = await fixture();
  try {
    const chat = await f.frame(false), ephemeral = await f.frame();
    f.store.enqueue(chat, f.owner.public.fingerprint);
    f.store.enqueue(ephemeral, f.owner.public.fingerprint, [f.online.public.fingerprint]);
    f.store.close();
    const restored = await BrokerStore.open({ stateDir: f.stateDir });
    try {
      expect(restored.stats().queuedFrames).toBe(1);
      expect(restored.next(f.roster.room, f.online.public.fingerprint)?.digest).toBe(chat.digest);
      expect(restored.enqueue(ephemeral, f.owner.public.fingerprint, [f.online.public.fingerprint]).duplicate).toBe(true);
      expect(restored.stats().queuedFrames).toBe(1);
    } finally { restored.close(); }
  } finally { f.cleanup(); }
});
