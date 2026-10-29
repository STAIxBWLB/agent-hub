import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
class Node {
  children: Node[] = []; textContent = ""; className = ""; dataset: Record<string, string> = {};
  constructor(readonly tag = "div") {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; this.textContent = ""; }
  set innerHTML(_value: string) { throw new Error("room metadata must use text nodes"); }
  text(): string { return [this.textContent, ...this.children.map(child => child.text())].join(" "); }
  all(): Node[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
function page() {
  const start = html.indexOf("function roomMetadataText("), end = html.indexOf("function renderUsage(", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const nodes = new Map<string, Node>(), get = (id: string): Node => {
    if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!;
  };
  const el = html.split("\n").find(line => line.startsWith("const el = "))!;
  const badge = html.split("\n").find(line => line.startsWith("const badge = "))!;
  const api = runInNewContext(`${el}\n${badge}\n${html.slice(start, end)};({renderRooms})`, {
    $: get, document: { createElement: (tag: string) => new Node(tag) },
    empty: (target: Node, text: string) => { const node = new Node("p"); node.textContent = text; target.append(node); },
  }) as { renderRooms(rooms: unknown): void };
  return { api, get, source: html.slice(start, end) };
}
const owner = "a".repeat(64), self = "b".repeat(64);
const room = (extra: Record<string, unknown> = {}) => ({ name: "lab", room: "c".repeat(43), owner, member: self, epoch: "3", link: "online", memberCount: 2,
  remotePeers: [{ id: "codex@remote", state: "busy" }], relays: { since: 1000, outbound: 4, inbound: 2, withheld: 1 }, ...extra });

test("Rooms stays hidden for older and no-room hubs without changing existing Agents content", () => {
  const f = page(), peer = new Node("p"); peer.textContent = "Existing peer summary";
  f.get("peers").append(peer); f.get("permissions").textContent = "Existing approval";
  for (const absent of [undefined, []]) {
    f.api.renderRooms(absent);
    expect(f.get("rooms-section").dataset.empty).toBe("true"); expect(f.get("rooms").children).toEqual([]);
    expect(f.get("room-count").textContent).toBe("");
    expect(f.get("peers").children).toEqual([peer]); expect(f.get("permissions").textContent).toBe("Existing approval");
  }
  expect(html).toContain('#rooms-section[data-empty="true"]{display:none}');
  expect(html).toContain('id="rooms-section" aria-labelledby="rooms-title" data-view="agents" data-empty="true" hidden');
  expect(html).toContain("renderRooms(snapshot.rooms);");
});

test("Rooms shows canonical membership and peer metadata with boot-scoped relay counters", () => {
  const f = page(); f.api.renderRooms([room()]);
  const text = f.get("rooms").text();
  expect(f.get("rooms-section").dataset.empty).toBe("false"); expect(f.get("room-count").textContent).toBe("1 room");
  for (const value of ["lab", "Room: " + "c".repeat(43), "epoch 3", "online", "Owner fingerprint: " + owner, "Self fingerprint: " + self, "members: 2", "codex@remote: busy"]) expect(text).toContain(value);
  expect(text).toContain("Relay counters since daemon boot (start: 1970-01-01T00:00:01.000Z)");
  expect(text).toContain("Outbound handoffs: 4"); expect(text).toContain("Inbound admitted: 2"); expect(text).toContain("Withheld outbound (subset): 1");
  expect(f.get("rooms").all().some(node => node.className === "row room-metadata")).toBe(true);
});

test("Rooms never converts unknown membership, link, peers or relay readings into zero", () => {
  const f = page();
  for (const relays of [null, { since: null, outbound: null, inbound: null, withheld: null }, { since: Infinity, outbound: NaN, inbound: -1, withheld: "0" }]) {
    f.api.renderRooms([room({ link: null, memberCount: null, remotePeers: null, relays })]);
    const text = f.get("rooms").text();
    for (const value of ["unknown", "members: unknown", "Remote peers: unknown", "start: unknown", "Outbound handoffs: unknown", "Inbound admitted: unknown", "Withheld outbound (subset): unknown"]) expect(text).toContain(value);
    expect(text).not.toContain("handoffs: 0"); expect(text).not.toContain("admitted: 0"); expect(text).not.toContain("subset): 0");
  }
  f.api.renderRooms([room({ memberCount: 0, remotePeers: [], relays: { since: 1000, outbound: 0, inbound: 0, withheld: 0 } })]);
  const zero = f.get("rooms").text();
  expect(zero).toContain("members: 0"); expect(zero).toContain("No exposed remote peers."); expect(zero).toContain("Outbound handoffs: 0");
});

test("unavailable room metadata clears old readings with a fixed message and missing rooms hides it again", () => {
  const f = page(); f.api.renderRooms([room()]); f.api.renderRooms(null);
  expect(f.get("rooms-section").dataset.empty).toBe("false"); expect(f.get("rooms").text().trim()).toBe("Room metadata unavailable.");
  expect(f.get("room-count").textContent).toBe(""); expect(f.get("rooms").text()).not.toContain(owner);
  f.api.renderRooms([]); expect(f.get("rooms-section").dataset.empty).toBe("true"); expect(f.get("rooms").text().trim()).toBe("");
});

test("Rooms renders no body, title, reason, URL, key or debug fields from injected rows", () => {
  const f = page(), canaries = { body: "BODY_CANARY", title: "TITLE_CANARY", reason: "REASON_CANARY", url: "https://URL_CANARY.invalid", privateKey: "KEY_CANARY", debug: "DEBUG_CANARY" };
  f.api.renderRooms([room({ ...canaries, deliveries: [{ ...canaries }], remotePeers: [{ id: "codex@remote", state: "idle", ...canaries }], relays: { since: 1000, outbound: 4, inbound: 2, withheld: 1, ...canaries } })]);
  const text = f.get("rooms").text();
  for (const value of Object.values(canaries)) expect(text).not.toContain(value);
  expect(text).toContain("codex@remote: idle");
  expect(f.source).not.toMatch(/Object\.entries|JSON\.stringify|innerHTML|fetch\(|action\(/);
});

test("malformed metadata cannot become markup, a link or arbitrary body text", () => {
  const f = page(), markup = '<img src="https://URL_CANARY.invalid" onerror="KEY_CANARY">';
  f.api.renderRooms([room({ name: markup, room: markup, owner: markup, member: markup, epoch: markup, link: markup, memberCount: markup,
    remotePeers: [{ id: markup, state: markup }], relays: { since: markup, outbound: markup, inbound: markup, withheld: markup } })]);
  const text = f.get("rooms").text();
  expect(text).not.toContain(markup); expect(text).not.toContain("URL_CANARY"); expect(text).not.toContain("KEY_CANARY");
  expect(text).toContain("unknown");
  expect(f.get("rooms").all().some(node => ["img", "a", "script", "button", "input"].includes(node.tag))).toBe(false);
  expect(html).toContain("if (text !== undefined) node.textContent = String(text)");
});
