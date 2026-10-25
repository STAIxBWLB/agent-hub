import { expect, test } from "bun:test";
import { permissionGrant } from "../src/hub/permission-mode.ts";
import { peerStyle } from "../src/ui/peer-palette.ts";
import type { LaunchContext } from "../src/adapters/registry-types.ts";
import type { PeerAdapter } from "../src/hub/peers.ts";
import { BUILTIN_DEFINITIONS_WITHOUT_QWEN, type LegacyAdapterDefinition } from "../src/adapters/definitions/builtin-metadata.ts";

test("#451 the public frozen A1 export preserves its caller-visible legacy type", () => {
  const legacy: readonly LegacyAdapterDefinition[] = BUILTIN_DEFINITIONS_WITHOUT_QWEN;
  expect(legacy[0]!.start.ownsTerminal("tui")).toBe(true);
  expect(legacy[0]!.permission.modes).toEqual({});
  const mode = legacy.find(definition => definition.kind === "kimi")!.permission.modes["never-ask"];
  expect(mode?.kind).toBe("acp-mode");
  if (mode?.kind === "acp-mode") expect(mode.modeId).toBe("auto");
});

async function definitions(): Promise<readonly import("../src/adapters/definitions/builtin-metadata.ts").LegacyAdapterDefinition[]> {
  const path = "../src/adapters/definitions/builtin-metadata.ts";
  const module = await import(path).catch(() => undefined);
  expect(Array.isArray(module?.BUILTIN_DEFINITIONS_WITHOUT_QWEN)).toBe(true);
  return module.BUILTIN_DEFINITIONS_WITHOUT_QWEN;
}
const context = (form: LaunchContext["form"]): LaunchContext => ({ instance: "fixture", form, projectRoot: "/fixture/project", stateDir: "/fixture/state", entrypoint: "/fixture/package/main.ts", userArgs: [], unattended: false, env: {} });
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

test("#451 A1 compatibility metadata preserves native order, roles, defaults, forms and trust boundaries", async () => {
  const all = await definitions();
  expect(all.map(def => def.kind)).toEqual(["claude", "codex", "kimi", "pi", "local", "jcode"]);
  expect(all.map(def => [def.kind, [...def.roles], def.optional === true, def.defaultOnRoster, [...def.start.forms], def.start.defaultForm, def.trust])).toEqual([
    ["claude", ["planner", "reviewer"], false, true, ["tui"], "tui", { onPrem: false, hubSandboxed: false }],
    ["codex", ["implementer"], false, true, ["tui", "headless"], "tui", { onPrem: false, hubSandboxed: false }],
    ["kimi", ["implementer", "verifier"], false, true, ["tui", "headless"], "tui", { onPrem: false, hubSandboxed: false }],
    ["pi", ["implementer", "verifier"], false, false, ["tui", "headless"], "tui", { onPrem: false, hubSandboxed: true }],
    ["local", ["implementer", "verifier"], false, true, ["headless"], "headless", { onPrem: true, hubSandboxed: true }],
    ["jcode", ["implementer", "verifier"], true, false, ["headless"], "headless", { onPrem: false, hubSandboxed: false }],
  ]);
  expect(Object.isFrozen(all)).toBe(true);
});

test("#451 unmigrated launch plans delegate to the real legacy CLI without starting native services", async () => {
  for (const def of await definitions()) {
    const ctx = context(def.start.defaultForm);
    const result = def.start.launch(ctx);
    const words = [def.kind, ...(["kimi", "pi"].includes(def.kind) ? ["--mode", ctx.form] : [])];
    expect(result.cmd).toBe(process.execPath);
    expect(result.args).toEqual([ctx.entrypoint, "--project", ctx.projectRoot, ...words]);
    expect(result.metadata.argv).toEqual([result.cmd, ...result.args]);
    expect(result.metadata.packageEntrypoint).toBe(ctx.entrypoint);
    expect(def.start.create).toBeUndefined();
    expect(def.start.conductorStartable).toBe(true);
  }
});

test("#451 compatibility metadata preserves permission grants and only claims verified native mode maps", async () => {
  const all = await definitions();
  for (const def of all) for (const mode of ["ask", "ask-when-needed", "never-ask"] as const) expect(def.permission.grants?.[mode]).toBe(permissionGrant(def.kind, mode));
  const byKind = new Map(all.map(def => [def.kind, def]));
  for (const [kind, expected] of Object.entries(LEGACY_GRANTS)) for (const mode of ["ask", "ask-when-needed", "never-ask"] as const) {
    expect(byKind.get(kind)!.permission.grants?.[mode]).toBe(expected[mode]);
    expect(permissionGrant(kind, mode)).toBe(expected[mode]);
  }
  expect(byKind.get("codex")!.permission.modes["ask-when-needed"]).toEqual({ kind: "codex-approval", policy: "on-request" });
  expect(byKind.get("codex")!.permission.modes["never-ask"]).toEqual({ kind: "codex-approval", policy: "never" });
  expect(byKind.get("kimi")!.permission.modes).toEqual({ ask: { kind: "acp-mode", modeId: "default" }, "ask-when-needed": { kind: "acp-mode", modeId: "yolo" }, "never-ask": { kind: "acp-mode", modeId: "auto" } });
  expect(byKind.get("kimi")!.permission.unmanagedForms).toEqual(["tui"]);
  for (const kind of ["claude", "pi", "local"]) { expect(byKind.get(kind)!.permission.modes).toEqual({}); expect(byKind.get(kind)!.permission.unmanaged).toBeUndefined(); }
  expect(byKind.get("jcode")!.permission.modes).toEqual({});
  expect(byKind.get("jcode")!.permission.unmanaged).toContain("unmanaged");
  for (const def of all) expect(def.permission.readOnly).toBeUndefined();
});

test("#451 metadata retains terminal ownership, quota exemptions, watch and existing palette colors", async () => {
  for (const def of await definitions()) {
    expect(def.start.ownsTerminal("headless")).toBe(false);
    expect(def.start.ownsTerminal("tui")).toBe(["claude", "codex", "kimi", "pi"].includes(def.kind));
    expect(def.budget?.account).toBe(def.kind === "local" ? undefined : def.kind);
    expect(def.capabilities?.watch === true).toBe(def.kind === "kimi");
    expect(def.display.palette).toEqual({ fg: peerStyle(def.kind).css, bg: "transparent" });
    expect(def.capabilities?.manifest).toBeUndefined();
    expect(def.budget?.reader).toBeUndefined(); expect(def.budget?.context).toBeUndefined();
  }
});

test("#451 current native session ids are read from the existing adapter metadata without a peer-kind cast", async () => {
  const peer: PeerAdapter = { id: "fixture", state: "idle", start: async () => {}, stop: async () => {}, deliver: async () => {}, recoveryMetadata: () => ({ sessionId: "session-A", threadId: "thread-A" }) };
  for (const def of await definitions()) expect(def.session.currentId(peer)).toBe(def.kind === "codex" ? "thread-A" : "session-A");
});

test("#451 compatibility launch metadata keeps only recovery-allowed environment names and quotes words", async () => {
  for (const def of await definitions()) {
    const ctx = { ...context(def.start.defaultForm), projectRoot: "/fixture/project's work", env: { CODEX_HOME: "/fixture/codex home", CLAUDE_CONFIG_DIR: "/fixture/claude", PRIVATE_FIXTURE: "excluded" } };
    const plan = def.start.launch(ctx);
    expect(plan.metadata.env).toEqual({ CODEX_HOME: ctx.env.CODEX_HOME, CLAUDE_CONFIG_DIR: ctx.env.CLAUDE_CONFIG_DIR });
    expect(plan.metadata.command).not.toContain("PRIVATE_FIXTURE");
    expect(plan.metadata.command).toContain("project'\\''s work");
  }
});
