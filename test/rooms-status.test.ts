import { expect, test } from "bun:test";
import { encodeBase64url } from "../src/rooms/crypto.ts";
import { projectRoomStatus } from "../src/rooms/status.ts";

const room = encodeBase64url(new Uint8Array(32).fill(7));
const owner = "a".repeat(64), member = "b".repeat(64);
const base = { name: "work", room, owner, member, epoch: "12", state: "online" };

test("room status projects only allowlisted metadata and leaves absent counts unknown", () => {
  const projected = projectRoomStatus([{ ...base, title: "REMOTE_TITLE_CANARY", body: "REMOTE_BODY_CANARY", debug: { secret: "PRIVATE_CANARY" }, relayCount: 0, withheldCount: 0 }]);
  expect(projected).toEqual([{ name: "work", room, owner, member, epoch: "12", link: "online", memberCount: null, remotePeers: null, relays: null }]);
  expect(Object.keys(projected[0]!).sort()).toEqual(["epoch", "link", "member", "memberCount", "name", "owner", "relays", "remotePeers", "room"]);
  expect(JSON.stringify(projected)).not.toContain("CANARY");
  expect(projected[0]).not.toHaveProperty("relayCount");
  expect(projected[0]).not.toHaveProperty("withheldCount");
});

test("room member and remote peer metadata stay within closed states and explicit bounds", () => {
  const peers = [{ id: "codex@hub-b", state: "idle", body: "REMOTE_BODY_CANARY" }, { id: "user@hub-c", state: "offline", title: "REMOTE_TITLE_CANARY" }];
  expect(projectRoomStatus([{ ...base, members: 2, remotePeers: peers }])).toEqual([{
    name: "work", room, owner, member, epoch: "12", link: "online", memberCount: 2,
    remotePeers: [{ id: "codex@hub-b", state: "idle" }, { id: "user@hub-c", state: "offline" }], relays: null,
  }]);
  const unknown = projectRoomStatus([{ ...base, state: "connecting-ish", members: 65, remotePeers: [{ id: "codex@hub-b", state: "running" }] }]);
  expect(unknown).toEqual([{ name: "work", room, owner, member, epoch: "12", link: null, memberCount: null, remotePeers: null, relays: null }]);
  expect(projectRoomStatus([{ ...base, state: "left", members: 0, remotePeers: [] }])[0]).toMatchObject({ link: "left", memberCount: 0, remotePeers: [], relays: null });
  expect(projectRoomStatus(Array.from({ length: 65 }, () => base))).toEqual([]);
  expect(projectRoomStatus([{ ...base, remotePeers: Array.from({ length: 4097 }, (_, i) => ({ id: `codex-${i}@hub-b`, state: "idle" })) }])[0]?.remotePeers).toBeNull();
});

test("room status ignores accessor and arbitrary nested body, title and debug fields without invoking getters", () => {
  let reads = 0;
  const remote = { id: "codex@hub-b", state: "idle" };
  Object.defineProperties(remote, {
    body: { enumerable: true, get() { reads++; throw new Error("body getter ran"); } },
    title: { enumerable: true, get() { reads++; throw new Error("title getter ran"); } },
    debug: { enumerable: true, get() { reads++; throw new Error("debug getter ran"); } },
  });
  const relays = { since: 10, outbound: 1, inbound: 1, withheld: 0 } as Record<string, unknown>;
  Object.defineProperty(relays, "title", { enumerable: true, get() { reads++; throw new Error("relay title getter ran"); } });
  const row = { ...base, remotePeers: [remote], relays, delivery: { body: "REMOTE_BODY_CANARY", title: "REMOTE_TITLE_CANARY" } } as Record<string, unknown>;
  Object.defineProperty(row, "diagnostic", { enumerable: true, get() { reads++; throw new Error("diagnostic getter ran"); } });
  const projected = projectRoomStatus([row]);
  expect(reads).toBe(0);
  expect(projected).toEqual([{ name: "work", room, owner, member, epoch: "12", link: "online", memberCount: null, remotePeers: [{ id: "codex@hub-b", state: "idle" }], relays: { since: 10, outbound: 1, inbound: 1, withheld: 0 } }]);
  expect(JSON.stringify(projected)).not.toContain("REMOTE_");

  const requiredAccessor = { ...base } as Record<string, unknown>;
  Object.defineProperty(requiredAccessor, "name", { enumerable: true, get() { reads++; throw new Error("name getter ran"); } });
  expect(projectRoomStatus([requiredAccessor])).toEqual([]);
  expect(reads).toBe(0);
});

test("relay metrics preserve safe daemon-session counts and leave invalid values unknown", () => {
  expect(projectRoomStatus([{ ...base, relays: { since: 1_798_000_000_000, outbound: 7, inbound: 4, withheld: 2, body: "REMOTE_BODY_CANARY", debug: "PRIVATE_CANARY" } }])[0]?.relays)
    .toEqual({ since: 1_798_000_000_000, outbound: 7, inbound: 4, withheld: 2 });
  expect(projectRoomStatus([{ ...base, relays: { since: 50, outbound: -1, inbound: Number.MAX_SAFE_INTEGER + 1, withheld: 1 } }])[0]?.relays)
    .toEqual({ since: 50, outbound: null, inbound: null, withheld: null });
  expect(projectRoomStatus([{ ...base, relays: { since: 50, outbound: 1, inbound: 0, withheld: 2 } }])[0]?.relays)
    .toEqual({ since: 50, outbound: 1, inbound: 0, withheld: null });
  expect(projectRoomStatus([{ ...base, relays: { since: 0, outbound: 1, inbound: 0, withheld: 0 } }])[0]?.relays).toBeNull();
  expect(projectRoomStatus([{ ...base, relays: { since: "50", outbound: 1, inbound: 0, withheld: 0 } }])[0]?.relays).toBeNull();
  expect(projectRoomStatus([{ ...base, relays: { outbound: 1, inbound: 0, withheld: 0 } }])[0]?.relays).toBeNull();
});

test("canonical projection is idempotent and explicit null does not fall back to legacy aliases", () => {
  let aliasReads = 0;
  const sourceRow = { ...base, link: null, memberCount: null, relays: { since: 100, outbound: null, inbound: 3, withheld: null } } as Record<string, unknown>;
  Object.defineProperties(sourceRow, {
    state: { enumerable: true, get() { aliasReads++; throw new Error("legacy state getter ran"); } },
    members: { enumerable: true, get() { aliasReads++; throw new Error("legacy members getter ran"); } },
  });
  const source = [sourceRow];
  const projected = projectRoomStatus(source);
  expect(projected[0]).toMatchObject({ link: null, memberCount: null, relays: { since: 100, outbound: null, inbound: 3, withheld: null } });
  expect(projectRoomStatus(projected)).toEqual(projected);
  expect(aliasReads).toBe(0);
  expect(projectRoomStatus([{ ...base, link: "offline", state: "online", memberCount: 1, members: 9 }])[0]).toMatchObject({ link: "offline", memberCount: 1 });
});

test("remote peer rows have one bounded global projection budget", () => {
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `peer-${i}@${prefix}`, state: "idle" }));
  const projected = projectRoomStatus([
    { ...base, remotePeers: many("hub-a", 3000) },
    { ...base, name: "other", remotePeers: many("hub-b", 2000) },
  ]);
  expect(projected[0]?.remotePeers).toHaveLength(3000);
  expect(projected[1]?.remotePeers).toBeNull();
  expect(projected.reduce((count, row) => count + (row.remotePeers?.length ?? 0), 0)).toBeLessThanOrEqual(4096);
});

test("room status refuses proxies at root, row, remote list and peer boundaries without running traps", () => {
  let traps = 0;
  const wrap = <T extends object>(value: T): T => new Proxy(value, {
    get() { traps++; throw new Error("get trap ran"); },
    getPrototypeOf() { traps++; throw new Error("prototype trap ran"); },
    ownKeys() { traps++; throw new Error("keys trap ran"); },
    getOwnPropertyDescriptor() { traps++; throw new Error("descriptor trap ran"); },
  });
  const root = wrap([base]);
  expect(projectRoomStatus(root)).toEqual([]);
  expect(projectRoomStatus([wrap({ ...base })])).toEqual([]);
  expect(projectRoomStatus([{ ...base, remotePeers: wrap([{ id: "codex@hub-b", state: "idle" }]) }])[0]?.remotePeers).toBeNull();
  expect(projectRoomStatus([{ ...base, remotePeers: [wrap({ id: "codex@hub-b", state: "idle" })] }])[0]?.remotePeers).toBeNull();
  expect(traps).toBe(0);

  const revoked = Proxy.revocable([base], {}); revoked.revoke();
  expect(projectRoomStatus(revoked.proxy)).toEqual([]);
});
