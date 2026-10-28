import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { decodeBase64url } from "../src/rooms/crypto.ts";
import { decodeInvite, decodeJoin, decodeRoster } from "../src/rooms/wire.ts";
import { RoomPolicy } from "../src/rooms/policy.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-daemon-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  mkdirSync(join(root, ".agenthub"));
  const stateDir = join(root, "state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  return { root, stateDir, daemon, person };
}
async function mutation(client: ControlClient, action: string, input: Record<string, unknown>) {
  const preview = await client.request({ t: "room", op: "preview", action, input });
  expect(preview.ok).toBe(true);
  expect(preview.owner).toMatch(/^[0-9a-f]{64}$/); expect(preview.member).toMatch(/^[0-9a-f]{64}$/);
  return client.request({ t: "room", op: "execute", ticket: preview.ticket });
}

test("every room rid is answered; tools can read ids but cannot mutate, even as conductor", async () => {
  const f = await fixture();
  const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" }); cleanup.push(() => tools.close());
  for (const op of ["preview", "execute", "create", "invite", "join", "leave", "revoke", "expose", "unknown"]) {
    expect((await tools.request({ t: "room", op, action: "create", input: {name:"test",broker:"ws://127.0.0.1:1/"} })).ok).toBe(false);
  }
  for (const op of ["list", "status"]) expect(await tools.request({ t: "room", op })).toMatchObject({ ok: true, rooms: [] });
  expect((await f.person.request({ t: "room", op: "unknown" })).ok).toBe(false);
  expect((await f.person.request({ t: "room", op: "status", input: { body: "PRIVATE_CANARY" } })).ok).toBe(false);
  expect(existsSync(join(f.stateDir, "rooms"))).toBe(false);
});

test("room preview tickets are connection-bound, one-use and contain no artifact", async () => {
  const f = await fixture(), other = await ControlClient.connect(f.stateDir, { role: "console" }); cleanup.push(() => other.close());
  const preview = await f.person.request({ t: "room", op: "preview", action: "create", input: { name: "test", broker: "ws://127.0.0.1:1/" } });
  expect(preview).toMatchObject({ ok: true }); expect(preview.artifact).toBeUndefined();
  expect((await f.person.request({ t: "room", op: "list" })).rooms).toEqual([]);
  expect((await other.request({ t: "room", op: "execute", ticket: preview.ticket })).ok).toBe(false);
  expect((await f.person.request({ t: "room", op: "execute", ticket: preview.ticket, action: "leave" })).ok).toBe(false);
  expect((await f.person.request({ t: "room", op: "execute", ticket: preview.ticket })).ok).toBe(false);
  expect((await mutation(f.person, "create", { name: "test", broker: "ws://127.0.0.1:1/" })).ok).toBe(true);
});

test("two person consoles enroll out of band, rotate exposure and revoke without leaking invitation secrets", async () => {
  const owner = await fixture(), guest = await fixture();
  expect((await mutation(owner.person, "create", { name: "test", broker: "ws://127.0.0.1:1/", label: "owner" })).ok).toBe(true);
  const token = await mutation(owner.person, "invite", { name: "test" }); expect(token.ok).toBe(true);
  const invite = decodeInvite(decodeBase64url(token.artifact));
  const request = await mutation(guest.person, "join", { name: "test", token: token.artifact, label: "guest" }); expect(request.ok).toBe(true);
  const joined = decodeJoin(decodeBase64url(request.artifact));
  const retry = await mutation(guest.person, "join", { name: "test", token: token.artifact, label: "guest" });
  expect(retry.artifact).toBe(request.artifact); // Crash after durable save but before printing is recoverable.

  expect(JSON.stringify(joined)).not.toContain(invite.secret);
  const accepted = await mutation(owner.person, "invite", { name: "test", request: request.artifact }); expect(accepted.ok).toBe(true);
  const roster = decodeRoster(decodeBase64url(accepted.artifact)); expect(roster.members).toHaveLength(2);
  expect((await mutation(guest.person, "join", { name: "test", roster: accepted.artifact })).ok).toBe(true);
  const exposed = await mutation(guest.person, "expose", { name: "test", peers: ["codex"] }); expect(exposed.ok).toBe(true);
  expect(exposed.kind).toBe("exposure-request"); expect(exposed.artifact).not.toContain(invite.secret);
  expect(new RoomPolicy(guest.root).get("test")).toEqual(["codex"]);
  const updated = await mutation(owner.person, "invite", { name: "test", request: exposed.artifact }); expect(updated.ok).toBe(true);
  expect((await mutation(guest.person, "join", { name: "test", roster: updated.artifact })).ok).toBe(true);
  const rows = await guest.person.request({ t: "room", op: "list" });
  expect(Object.keys(rows.rooms[0]).sort()).toEqual(["epoch","member","name","owner","room","state"]);
  expect(JSON.stringify(rows)).not.toContain("broker"); expect(JSON.stringify(rows)).not.toContain(invite.secret);
  expect((await mutation(owner.person, "revoke", { name: "test", member: joined.member.fingerprint })).ok).toBe(true);
  expect((await mutation(guest.person, "leave", { name: "test" })).ok).toBe(true);
  expect((await guest.person.request({ t: "room", op: "status" })).rooms[0].state).toBe("left");
  for (const fixture of [owner, guest]) {
    expect(readFileSync(join(fixture.stateDir, "hub.log"), "utf8")).not.toContain(invite.secret);
    expect(readFileSync(join(fixture.stateDir, "events.jsonl"), "utf8")).not.toContain(invite.secret);
  }
});

test("room exposure is machine-local and a committed local config cannot authorize it", async () => {
  const f = await fixture(), policy = new RoomPolicy(f.root);
  policy.set("test", ["codex"], () => true); expect(policy.get("test")).toEqual(["codex"]);
  expect(Bun.spawnSync(["git", "-C", f.root, "add", "-f", ".agenthub/config.local.json"]).exitCode).toBe(0);
  expect(policy.get("test")).toEqual([]);
  expect(() => policy.set("test", ["claude"], () => true)).toThrow("untrusted_config");
});
