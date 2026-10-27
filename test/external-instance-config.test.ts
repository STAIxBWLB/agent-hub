import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExternalDefinition } from "../src/adapters/external-modules.ts";
import { createProjectAdapterCatalog, type AdapterDefinition } from "../src/adapters/registry.ts";
import { effectiveInstanceRoles, instanceCatalog, validateInstances } from "../src/hub/instances.ts";
import { resolveInstanceExecutionCwd } from "../src/hub/instance-execution.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: string[] = [];
afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });
function moduleCatalog(optIn = true, allowed: ("implementer" | "verifier" | "reviewer")[] = ["implementer", "verifier", "reviewer"]) {
  const definition: AdapterDefinition = {
    api: 1, kind: "fixture", family: "fixture", displayName: "Fixture", transport: "acp",
    roles: ["implementer", "verifier", "reviewer"], optional: true, defaultOnRoster: false,
    trust: { onPrem: false, hubSandboxed: false }, identity: { mcp: "acp-session" },
    ...(optIn ? { headlessInstances: { form: "headless" as const, roles: allowed } } : {}),
    permission: { genericAcp: { modes: { ask: "ask", "ask-when-needed": "default" }, readOnly: "read-only" } },
    start: { forms: ["headless"], defaultForm: "headless", daemonPort: "acp", conductorStartable: true, hubSwitches: [], ownedFlags: [],
      create: () => { throw new Error("fixture factory must not run"); },
      launch: ctx => ({ cmd: "fixture-not-executed", args: [], metadata: { packageEntrypoint: ctx.entrypoint, command: "fixture", argv: [], env: {} } }) },
    session: { idField: "sessionId", currentId: () => undefined }, turnEnd: "adapter",
    cli: { command: "fixture", startWords: () => ["fixture"] }, display: { palette: { fg: "white", bg: "black" } },
  };
  return createProjectAdapterCatalog(undefined, [validateExternalDefinition(definition)]);
}
const declaration = (id: string, role: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: "fixture", roles: [role], start_mode: "headless", worktree: `.worktrees/${id}`, ...extra });

function projectFixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-module-instance-"))); cleanup.push(root);
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
    return result.stdout;
  };
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  const worktree = (id: string, detached = false) => {
    const cwd = join(root, ".worktrees", id);
    git("worktree", "add", ...(detached ? ["--detach"] : ["-b", id]), cwd, "HEAD");
    return realPath(cwd);
  };
  return { root, git, worktree };
}

test("#754 mixed builtin and opted-in module writer, verifier and continuing reviewer declarations coexist", () => {
  const catalog = moduleCatalog();
  const declarations = validateInstances({
    "codex-worker": { kind: "codex" },
    "fixture-worker": declaration("fixture-worker", "implementer"),
    "fixture-verifier": declaration("fixture-verifier", "verifier"),
    "fixture-reviewer": declaration("fixture-reviewer", "reviewer"),
  }, catalog);
  const entries = instanceCatalog(declarations, catalog);
  expect(entries.filter(entry => entry.config).map(entry => entry.id)).toEqual(["codex-worker", "fixture-worker", "fixture-verifier", "fixture-reviewer"]);
  expect(entries.find(entry => entry.id === "fixture-reviewer")?.definition.reviewer).toBeUndefined();
  expect(effectiveInstanceRoles("fixture-reviewer", declarations, {}, catalog)).toEqual(["reviewer"]);
});

test("#754 module opt-in and every role's managed workspace are mandatory", () => {
  expect(() => validateInstances({ "fixture-worker": declaration("fixture-worker", "implementer") }, moduleCatalog(false))).toThrow(/opted/);
  for (const role of ["implementer", "verifier", "reviewer"]) {
    const entry = declaration("fixture-worker", role); delete entry.worktree;
    expect(() => validateInstances({ "fixture-worker": entry }, moduleCatalog())).toThrow(/worktree/);
  }
  expect(() => validateInstances({ "fixture-worker": declaration("fixture-worker", "implementer") }, moduleCatalog(true, ["reviewer"]))).toThrow(/subset/);
});

test("#754 module role ceilings also constrain id-keyed effective role overrides", () => {
  const catalog = moduleCatalog(true, ["reviewer"]);
  const declarations = validateInstances({ "fixture-reviewer": declaration("fixture-reviewer", "reviewer") }, catalog);
  const implicit = { "fixture-reviewer": { kind: "fixture", worktree: ".worktrees/fixture-reviewer" } };
  expect(effectiveInstanceRoles("fixture-reviewer", implicit, { "fixture-reviewer": ["planner", "conductor", "implementer", "reviewer"] }, catalog)).toEqual(["reviewer"]);
  expect(effectiveInstanceRoles("fixture-reviewer", declarations, { "fixture-reviewer": ["planner", "conductor"] }, catalog)).toEqual(["reviewer"]);
  for (const role of ["planner", "conductor", "implementer"]) expect(() => validateInstances({ "fixture-reviewer": declaration("fixture-reviewer", role) }, catalog)).toThrow(/subset/);
});

test("#754 builtin-only fields and fresh reviewer mode refuse by presence", () => {
  const catalog = moduleCatalog();
  for (const extra of [{ review_mode: "fresh" }, { review_mode: undefined }, { review_scope: undefined }, { start_mode: "tui" },
    { model: undefined }, { provider: undefined }, { provider_profile: undefined }, { jcode_home: undefined }, { command: undefined }, { argv: undefined }, { env: undefined }]) {
    expect(() => validateInstances({ "fixture-reviewer": declaration("fixture-reviewer", "reviewer", extra) }, catalog)).toThrow();
  }
  expect(() => validateInstances({ "fixture-worker": declaration("fixture-worker", "implementer", { permission_mode: "never-ask" }) }, catalog)).toThrow(/mapping/);
  expect(() => validateInstances({ "fixture-worker": declaration("fixture-worker", "implementer", { readOnly: true, permission_mode: "ask" }) }, catalog)).toThrow(/read-only/);
});

test("#754 external execution keeps distinct exact roots for every role", () => {
  const f = projectFixture(), catalog = moduleCatalog();
  for (const role of ["implementer", "verifier", "reviewer"]) {
    const id = `fixture-${role}`, cwd = f.worktree(id), declarations = validateInstances({ [id]: declaration(id, role) }, catalog);
    expect(resolveInstanceExecutionCwd(f.root, id, declarations, [role], catalog)).toBe(cwd);
  }
});

test("#754 verifier and reviewer detached roots require explicit read-only policy", () => {
  const f = projectFixture(), catalog = moduleCatalog();
  for (const role of ["implementer", "verifier", "reviewer"]) {
    const id = `fixture-${role}`, cwd = f.worktree(id, true);
    const writable = validateInstances({ [id]: declaration(id, role) }, catalog);
    expect(() => resolveInstanceExecutionCwd(f.root, id, writable, [role], catalog)).toThrow(/attached branch/);
    const readOnly = validateInstances({ [id]: declaration(id, role, { readOnly: true }) }, catalog);
    expect(resolveInstanceExecutionCwd(f.root, id, readOnly, [role], catalog)).toBe(cwd);
  }
});

test("#754 external workspace evidence cannot use canonical fallback, unregistered directory, or a symlink alias", () => {
  const f = projectFixture(), catalog = moduleCatalog(), id = "fixture-reviewer";
  const declarations = validateInstances({ [id]: declaration(id, "reviewer") }, catalog);
  mkdirSync(join(f.root, ".worktrees", id), { recursive: true });
  expect(() => resolveInstanceExecutionCwd(f.root, id, declarations, ["reviewer"], catalog)).toThrow(/registered/);
  rmSync(join(f.root, ".worktrees", id), { recursive: true });
  const other = f.worktree("fixture-other");
  symlinkSync(other, join(f.root, ".worktrees", id), "dir");
  expect(() => resolveInstanceExecutionCwd(f.root, id, declarations, ["reviewer"], catalog)).toThrow(/exact managed/);
  expect(() => resolveInstanceExecutionCwd(f.root, id, validateInstances({ [id]: declaration(id, "reviewer", { worktree: f.root }) }, catalog), ["reviewer"], catalog)).toThrow(/exact managed/);
});
