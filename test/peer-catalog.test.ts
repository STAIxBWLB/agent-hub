import { expect, test } from "bun:test";
import { defaultPeerRoles, isKnownPeer, KNOWN_PEERS } from "../src/hub/peer-catalog.ts";

const policy = {
  claude: ["planner", "reviewer"],
  codex: ["implementer"],
  kimi: ["implementer", "verifier"],
  local: ["implementer", "verifier"],
  pi: ["implementer", "verifier"],
};

test("the known-peer catalog preserves the existing startable order (#315)", () => {
  expect(KNOWN_PEERS).toEqual(["claude", "codex", "kimi", "pi", "local"]);
});

test("known-peer validation accepts only exact native names, without coercion or inherited keys (#315)", () => {
  for (const value of ["claude", "codex", "kimi", "pi", "local"]) expect(isKnownPeer(value)).toBe(true);
  for (const value of [undefined, null, false, true, 0, 1, {}, [], ["codex"], new String("codex"), { toString: () => "local" },
    "", "qwen", "user", "hub", "digest", "claude-2", "Claude", " codex", "kimi ", "__proto__", "constructor", "toString"]) {
    expect(isKnownPeer(value)).toBe(false);
  }
});

test("default peer roles retain the existing policy and key order (#315)", () => {
  const roles = defaultPeerRoles();
  expect(roles).toEqual(policy);
  expect(Object.keys(roles)).toEqual(["claude", "codex", "kimi", "local", "pi"]);
});

test("default peer roles return independently mutable objects and arrays (#315)", () => {
  const first = defaultPeerRoles(), second = defaultPeerRoles();
  expect(first).not.toBe(second);
  for (const name of ["claude", "codex", "kimi", "local", "pi"]) expect(first[name]).not.toBe(second[name]);
  expect(first.kimi).not.toBe(first.local); expect(first.local).not.toBe(first.pi);
  first.claude!.push("conductor"); first.kimi![0] = "reviewer"; first.pi!.splice(0, 1);
  delete first.codex; first.external = ["planner"];
  expect(second).toEqual(policy);
  expect(defaultPeerRoles()).toEqual(policy);
});
