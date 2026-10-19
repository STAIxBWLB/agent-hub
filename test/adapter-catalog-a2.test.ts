import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ADAPTERS, KNOWN_PEERS as REGISTRY_KNOWN, OPTIONAL_PEERS as REGISTRY_OPTIONAL, SUPPORTED_PEERS as REGISTRY_SUPPORTED, START_MODE_PEERS as REGISTRY_DUAL, OFFICE_PEER_ORDER, defaultPeerRoles, definitionOf, PLANNER_PEERS } from "../src/adapters/registry.ts";
import { KNOWN_PEERS, OPTIONAL_PEERS, SUPPORTED_PEERS, isKnownPeer, isSupportedPeer } from "../src/hub/peer-catalog.ts";
import { START_MODE_PEERS, STARTABLE_PEERS, peerStartConfig, startModeOf } from "../src/hub/start-mode.ts";
import { peerRosterConfig, rosterAllows } from "../src/hub/roster.ts";

test("A2 catalog projections retain exact legacy orders and source-probe compatibility", () => {
  expect(REGISTRY_KNOWN).toEqual(["claude", "codex", "kimi", "pi", "local"]);
  expect(REGISTRY_OPTIONAL).toEqual(["qwen", "jcode", "agy"]);
  expect(REGISTRY_SUPPORTED).toEqual(["claude", "codex", "kimi", "pi", "local", "qwen", "jcode", "agy"]);
  expect(KNOWN_PEERS).toEqual(REGISTRY_KNOWN); expect(OPTIONAL_PEERS).toEqual(REGISTRY_OPTIONAL);
  expect(SUPPORTED_PEERS).toEqual(REGISTRY_SUPPORTED); expect(STARTABLE_PEERS).toEqual(REGISTRY_SUPPORTED);
  expect(ADAPTERS.map(definition => definition.kind)).toEqual([...REGISTRY_SUPPORTED]);
  expect(REGISTRY_DUAL).toEqual(["pi", "codex", "kimi"]); expect(START_MODE_PEERS).toEqual(REGISTRY_DUAL);
  expect(PLANNER_PEERS).toEqual(["claude", "codex", "kimi", "qwen", "jcode"]);
  expect(OFFICE_PEER_ORDER).toEqual(REGISTRY_KNOWN);
  const catalog = readFileSync(new URL("../src/hub/peer-catalog.ts", import.meta.url), "utf8");
  const optional = /export const OPTIONAL_PEERS\s*=\s*\[([^\]]*)\]/.exec(catalog)?.[1];
  expect(optional).toBeDefined(); expect(optional).toMatch(/["']qwen["']/); expect(optional).toMatch(/["']jcode["']/);
  const starts = readFileSync(new URL("../src/hub/start-mode.ts", import.meta.url), "utf8");
  const modes = /export const START_MODE_PEERS\s*=\s*\[([^\]]*)\]/.exec(starts)?.[1];
  expect(modes).toBeDefined(); expect(modes).toMatch(/["']kimi["']/);
});

test("A2 default-role projection preserves key order and caller-owned copies", () => {
  const basic = defaultPeerRoles(), all = defaultPeerRoles(true);
  expect(Object.keys(basic)).toEqual(["claude", "codex", "kimi", "local", "pi"]);
  expect(Object.keys(all)).toEqual(["claude", "codex", "kimi", "local", "pi", "qwen", "jcode", "agy"]);
  for (const [peer, roles] of Object.entries(all)) expect(roles).toEqual([...definitionOf(peer)!.roles]);
  all.claude!.push("local-only"); basic.pi!.push("local-only");
  expect(defaultPeerRoles(true).claude).toEqual(["planner", "reviewer"]);
  expect(defaultPeerRoles().pi).toEqual(["implementer", "verifier"]);
  expect(definitionOf("claude")!.roles).toEqual(["planner", "reviewer"]);
});

test("A2 start and roster projections preserve unknown ids and legacy defaults", () => {
  for (const id of ["external", "codex-1", "__proto__", "constructor", ""]) {
    expect(isKnownPeer(id)).toBe(false); expect(isSupportedPeer(id)).toBe(false);
    expect(startModeOf({ [id]: { start_mode: "tui" } }, id)).toBe("headless");
    expect(rosterAllows({ [id]: false }, id, false)).toBe(true);
    expect(() => peerRosterConfig({ [id]: false })).toThrow("unsupported peer");
  }
  for (const value of [undefined, null, 1, {}, []]) { expect(isKnownPeer(value)).toBe(false); expect(isSupportedPeer(value)).toBe(false); }
  for (const enabled of [false, true]) {
    for (const peer of ["claude", "codex", "kimi", "local"]) expect(rosterAllows({}, peer, enabled)).toBe(true);
    for (const peer of ["qwen", "jcode"]) expect(rosterAllows({}, peer, enabled)).toBe(false);
    expect(rosterAllows({}, "pi", enabled)).toBe(enabled);
    expect(rosterAllows({ pi: false }, "pi", enabled)).toBe(false);
    expect(rosterAllows({ pi: true }, "pi", enabled)).toBe(true);
  }
  for (const peer of SUPPORTED_PEERS) {
    expect(isSupportedPeer(peer)).toBe(true); expect(isKnownPeer(peer)).toBe(!(OPTIONAL_PEERS as readonly string[]).includes(peer));
    expect(startModeOf(undefined, peer)).toBe(["qwen", "jcode", "local"].includes(peer) ? "headless" : "tui");
  }
  expect(isSupportedPeer("agy-build", { "agy-build": { kind: "agy", roles: ["implementer"] } })).toBe(true);
  expect(isSupportedPeer("agy-guess")).toBe(false);
  expect(isSupportedPeer("external-build", { "external-build": { kind: "external" } })).toBe(false);
  for (const peer of START_MODE_PEERS) expect(startModeOf({ [peer]: { start_mode: "headless" } }, peer)).toBe("headless");
  expect(startModeOf({ claude: { start_mode: "headless" } }, "claude")).toBe("tui");
  expect(() => peerStartConfig({ qwen: { start_mode: "headless" } })).toThrow("peers.qwen: only pi and codex and kimi have a start mode");
});
