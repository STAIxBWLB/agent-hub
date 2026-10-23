import { expect, test } from "bun:test";
import { CLASSES } from "../src/hub/board.ts";
import { assign, ownerRoleOfClass, parseRouting } from "../src/hub/routing.ts";
import { createProjectAdapterCatalog as builtinProjectCatalog } from "../src/adapters/registry.ts";
import type { PeerState } from "../src/hub/envelope.ts";

type Options = NonNullable<Parameters<typeof assign>[3]>;
// A person-started Claude channel instance with the implementer role, in its own worktree (#525-1), and a headless Codex instance for contrast.
const instances = { "claude-impl": { kind: "claude", roles: ["implementer"], worktree: ".worktrees/claude-impl" }, "claude-plan": { kind: "claude", roles: ["planner"] },
  "claude-rev": { kind: "claude", roles: ["reviewer"] }, "codex-a": { kind: "codex", roles: ["implementer"], start_mode: "headless" } } as const;
const catalog = builtinProjectCatalog();
const states: Record<string, PeerState> = { "claude-impl": "idle", "claude-plan": "idle", "claude-rev": "idle", "codex-a": "idle", claude: "idle", codex: "idle" };
const policy = (peers: string[]) => parseRouting(`[local]\nfixed_model="fixture"\n${CLASSES.map(name => `[classes.${name}]\npeers=${JSON.stringify(peers)}\n`).join("")}`);
// #525-5: only the host's verified current execution root admits a declared write owner.
const base = (extra: Partial<Options> = {}): Options => ({ instances: instances as never, adapterCatalog: catalog, roles: { "claude-impl": ["implementer"], "claude-plan": ["planner"], "claude-rev": ["reviewer"], "codex-a": ["implementer"] }, ownerIsolation: { "claude-impl": true, "codex-a": true }, ...extra });
const REASON = "owner admission: declared write owner requires a verified isolated execution root";

test("#735 ownerRoleOfClass is derived: plan is the planner's, review the reviewer's, every other class the implementer's", () => {
  expect(ownerRoleOfClass("plan")).toBe("planner"); expect(ownerRoleOfClass("review")).toBe("reviewer");
  for (const cls of CLASSES.filter(name => name !== "plan" && name !== "review")) expect(ownerRoleOfClass(cls), cls).toBe("implementer");
});
for (const cls of CLASSES) test(`#525-5 ${cls}: Claude write ownership requires the host's verified isolation`, () => {
  const task = { class: cls, signals: [] as string[] }, writes = ownerRoleOfClass(cls) === "implementer";
  if (writes) {
    for (const ownerIsolation of [{ "claude-impl": false }, {} as Record<string, boolean>]) {
      const refused = assign(task, states, policy(["claude-impl"]), base({ candidates: ["claude-impl"], namedOwner: "claude-impl", ownerIsolation }));
      expect(refused.owner).toBeUndefined();
      expect(refused.refusals).toContainEqual(expect.objectContaining({ peer: "claude-impl", code: "owner-admission", reason: REASON }));
      expect(refused.trace.join("\n")).toContain(REASON);
    }
    expect(assign(task, states, policy(["claude-impl"]), base({ candidates: ["claude-impl"], namedOwner: "claude-impl" })).owner).toBe("claude-impl");
    expect(assign(task, states, policy(["claude"]), base()).owner).toBe("claude");
    expect(assign(task, states, policy(["codex-a"]), base({ candidates: ["codex-a"], namedOwner: "codex-a" })).owner).toBe("codex-a");
  } else {
    const holder = cls === "plan" ? "claude-plan" : "claude-rev";
    expect(assign(task, states, policy([holder]), base({ namedOwner: holder, candidates: [holder] })).owner).toBe(holder);
  }
});
test("#525-5 a verifier without the implementer role cannot own write work, even with isolation", () => {
  for (const cls of ["implement", "test", "bulk_edit", "summarize", "triage"] as const) {
    expect(assign({ class: cls, signals: [] }, states, policy(["claude-impl"]), base({ roles: { "claude-impl": ["verifier"] }, candidates: ["claude-impl"], namedOwner: "claude-impl" })).owner).toBeUndefined();
  }
});

// ---- the configured ACP planner rule (#735 item 2) ----
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/hub/daemon.ts";
import { PLANNER_PEERS, deriveAdapterLists } from "../src/adapters/registry.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { resolveSettledRoles } from "../src/hub/settled-roles.ts";

function project(local: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-acp-planner-")); mkdirSync(join(dir, ".agenthub"));
  hubGitSync(["-C", dir, "init", "-q"], { encoding: "utf8" });
  writeFileSync(join(dir, ".agenthub/config.json"), "{}"); writeFileSync(join(dir, ".agenthub/config.local.json"), JSON.stringify(local));
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}
const acp = (roles: string[]) => ({ transport: "acp", command: "fixture-not-run", args: [], displayName: "Fixture", roles });

test("#735 a configured ACP agent keeps the planner role it is given (adapter roles or a roles entry), because the kind filter reads the builtin registry and a configured kind is not in it", () => {
  for (const local of [{ adapters: { fixture: acp(["planner", "implementer"]) } }, { adapters: { fixture: acp(["implementer"]) }, roles: { fixture: ["planner"] } }]) {
    const p = project(local);
    try {
      const config = loadConfig(p.dir);
      expect(config.roles.fixture).toContain("planner");
      expect(resolveSettledRoles(config.roles, config.planner, () => true).planners).toContain("fixture");
    } finally { p.close(); }
  }
});

test("#735 a configured ACP agent can be neither pinned as planner nor chosen as the automatic planner: it has no projection, so it is not in PLANNER_PEERS", () => {
  const p = project({ adapters: { fixture: acp(["planner"]) }, planner: "fixture" });
  try { expect(() => loadConfig(p.dir)).toThrow("planner must be one of"); } finally { p.close(); }
  const catalog = builtinProjectCatalog({ fixture: acp(["planner"]) });
  expect(deriveAdapterLists(catalog.definitions).PLANNER_PEERS).not.toContain("fixture");
  expect((PLANNER_PEERS as readonly string[]).includes("fixture")).toBe(false);
  // The projection that would make it eligible is not available to a configured definition at all (the capability scope refuses it).
  expect(catalog.definitionOf("fixture")?.projection).toBeUndefined();
});

test("#735 a declared instance of a kind that cannot plan still loses the planner role, with no throw", () => {
  const p = project({ instances: { "local-x": { kind: "local", roles: ["implementer"], start_mode: "headless" } }, roles: { "local-x": ["planner", "implementer"] } });
  try { expect(loadConfig(p.dir).roles["local-x"]).toEqual(["implementer"]); } finally { p.close(); }
});
