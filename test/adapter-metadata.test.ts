import { expect, test } from "bun:test";
import { permissionGrant } from "../src/hub/permission-mode.ts";
import { peerStyle } from "../src/ui/peer-palette.ts";
import type { PeerAdapter } from "../src/hub/peers.ts";
import { ADAPTERS } from "../src/adapters/registry.ts";

// Independent baseline: permissionGrant in 4bcf62fa:src/hub/permission-mode.ts, before registry delegation.
const LEGACY_GRANTS = {
  claude: {
    ask: "Claude's own permission rules decide",
    "ask-when-needed": "file tools on project files run without asking, outside .agenthub, .git and agent configuration; other tools keep Claude's own rules",
    "never-ask": "every tool runs without asking",
  },
  codex: {
    ask: "the session's own approval policy applies again",
    "ask-when-needed": "approval policy on-request on every turn",
    "never-ask": "approval policy never on every turn: nothing asks",
  },
  kimi: {
    ask: "Kimi asks as it does on its own",
    "ask-when-needed": "Kimi's yolo mode: it asks only where it judges it must",
    "never-ask": "Kimi's auto mode: nothing asks",
  },
  pi: {
    ask: "every write, edit and shell command asks",
    "ask-when-needed": "write, edit and proven bounded read-only shell commands inside the project run without asking; other shell commands and git writes still ask",
    "never-ask": "every tool runs without asking, inside the hub sandbox and path guard",
  },
  local: {
    ask: "every write, edit and shell command asks",
    "ask-when-needed": "write, edit and proven bounded read-only shell commands inside the project run without asking; other shell commands and git writes still ask",
    "never-ask": "every tool runs without asking, inside the hub sandbox and path guard",
  },
  jcode: {
    ask: "no verified hub mode mapping; native policy only",
    "ask-when-needed": "no verified hub mode mapping; native policy only",
    "never-ask": "no verified hub mode mapping; native policy only",
  },
} as const;

test("#625 registry metadata preserves native order, roles, defaults, forms and trust boundaries", () => {
  expect(ADAPTERS.map(def => [def.kind, [...def.roles], def.optional === true, def.defaultOnRoster, [...def.start.forms], def.start.defaultForm, def.trust])).toEqual([
    ["claude", ["planner", "reviewer"], false, true, ["tui"], "tui", { onPrem: false, hubSandboxed: false }],
    ["codex", ["implementer"], false, true, ["tui", "headless"], "tui", { onPrem: false, hubSandboxed: false }],
    ["kimi", ["implementer", "verifier"], false, true, ["tui", "headless"], "tui", { onPrem: false, hubSandboxed: false }],
    ["pi", ["implementer", "verifier"], false, false, ["tui", "headless"], "tui", { onPrem: false, hubSandboxed: true }],
    ["local", ["implementer", "verifier"], false, true, ["headless"], "headless", { onPrem: true, hubSandboxed: true }],
    ["qwen", ["implementer", "verifier"], true, false, ["headless"], "headless", { onPrem: false, hubSandboxed: false }],
    ["jcode", ["implementer", "verifier"], true, false, ["tui", "headless"], "tui", { onPrem: false, hubSandboxed: false }],
    ["agy", ["implementer", "verifier"], true, false, ["tui"], "tui", { onPrem: false, hubSandboxed: false }],
  ]);
  expect(Object.isFrozen(ADAPTERS)).toBe(true);
});

test("#625 registry metadata preserves the independent permission-grant baseline", () => {
  for (const def of ADAPTERS) for (const mode of ["ask", "ask-when-needed", "never-ask"] as const) {
    if (def.permission.grants?.[mode] !== undefined) expect(def.permission.grants[mode]).toBe(permissionGrant(def.kind, mode));
  }
  const byKind = new Map(ADAPTERS.map(def => [def.kind, def]));
  for (const [kind, expected] of Object.entries(LEGACY_GRANTS)) for (const mode of ["ask", "ask-when-needed", "never-ask"] as const) {
    expect(byKind.get(kind)!.permission.grants?.[mode]).toBe(expected[mode]);
    expect(permissionGrant(kind, mode)).toBe(expected[mode]);
  }
  expect(byKind.get("kimi")!.permission.unmanagedForms).toEqual(["tui"]);
  expect(byKind.get("jcode")!.permission.unmanaged).toContain("unmanaged");
});

test("#625 registry metadata retains quota exemptions, watch and existing palette colors", () => {
  for (const def of ADAPTERS) {
    expect(def.budget?.account).toBe(def.kind === "agy" ? undefined : def.kind);
    expect(def.budget?.quotaExempt === true).toBe(def.kind === "local");
    expect(def.capabilities?.watch === true).toBe(["kimi", "qwen"].includes(def.kind));
    expect(def.display.palette.fg).toBe(def.kind === "agy" ? "#6558a6" : peerStyle(def.kind).css);
    expect(def.display.palette.bg).toBe(def.kind === "agy" ? "#f1effa" : "transparent");
    expect(def.capabilities?.manifest).toBeUndefined();
  }
});

test("#625 registry native session readers use adapter metadata without a peer-kind cast", () => {
  const peer: PeerAdapter = { id: "fixture", state: "idle", start: async () => {}, stop: async () => {}, deliver: async () => {}, recoveryMetadata: () => ({ sessionId: "session-A", threadId: "thread-A" }) };
  for (const def of ADAPTERS) expect(def.session.currentId(peer)).toBe(def.kind === "agy" ? undefined : def.kind === "codex" ? "thread-A" : "session-A");
});
