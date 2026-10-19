import { expect, test } from "bun:test";
import * as registry from "../src/adapters/registry.ts";
import { validateInstances } from "../src/hub/instances.ts";
import { assign, parseRouting } from "../src/hub/routing.ts";

const declarations = {
  "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" as const },
  "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless" as const, review_mode: "fresh" as const },
  "kimi-review": { kind: "kimi", roles: ["reviewer"], start_mode: "headless" as const, review_mode: "fresh" as const },
  "agy-review": { kind: "agy", roles: ["reviewer"], start_mode: "headless" as const },
};
test("reviewer-only headless declarations resolve fixed fresh variants without changing implementer instances", () => {
  const validated = validateInstances(declarations);
  for (const [id, declaration] of Object.entries(declarations)) {
    const variant = registry.definitionOf(id, validated)!;
    expect(variant.routing?.reviewOnly).toBe(true);
    if (variant.reviewer?.backend) expect(variant.reviewer.backend.id).toBe(declaration.kind);
    else expect(variant.reviewer?.unavailable).toBeString();
    expect(variant.session.freshOnRestore).toBe(true);
    expect(variant.session.currentId({} as never)).toBeUndefined();
  }
  for (const kind of ["codex", "kimi"]) {
    const instances = validateInstances({ [`${kind}-build`]: { kind, roles: ["implementer"], start_mode: "headless" } });
    expect(registry.definitionOf(`${kind}-build`, instances)).toBe(registry.definitionOf(kind));
    expect(registry.definitionOf(`${kind}-malformed`, { [`${kind}-malformed`]: { kind, start_mode: "headless" } })).toBe(registry.definitionOf(kind));
  }
});

test("fresh reviewer declarations refuse worktrees and permission overrides; ordinary implementer roots remain allowed", () => {
  for (const [id, entry] of Object.entries(declarations)) {
    expect(() => validateInstances({ [id]: { ...entry, worktree: ".worktrees/private" } })).toThrow("worktree");
    expect(() => validateInstances({ [id]: { ...entry, permission_mode: "never-ask" } })).toThrow("read-only");
  }
  expect(validateInstances({ "codex-build": { kind: "codex", roles: ["implementer"], start_mode: "headless", worktree: ".worktrees/build" } })["codex-build"]?.worktree).toBe(".worktrees/build");
});

test("default pool includes Kimi native-policy backend and excludes agy implementer metadata", () => {
  expect((registry as unknown as { DEFAULT_REVIEW_POOL: readonly string[] }).DEFAULT_REVIEW_POOL).toEqual(["claude", "codex", "kimi"]);
  expect(registry.definitionOf("agy")).toMatchObject({ optional: true, defaultOnRoster: false, transport: "ws-pull", roles: ["implementer", "verifier"] });
  expect(registry.definitionOf("agy")?.reviewerVariant?.reviewer?.defaultPool).toBe(false);
  expect(registry.OPTIONAL_PEERS).toContain("agy");
  expect(registry.isSupportedPeer("agy")).toBe(true);
  expect(registry.isStartablePeer("agy")).toBe(false); // person-only launcher; no conductor start
  expect(registry.ADAPTERS.some(definition => definition.kind === "agy")).toBe(true);
});

test("agy reviewer declarations stay unavailable without a reviewer factory or launch argv", () => {
  for (const id of ["agy-review"]) {
    const definition = registry.definitionOf(id, declarations)!;
    expect(definition.reviewer?.unavailable).toBe("agy is an implementer peer (#485)");
    expect(definition.reviewer?.backend).toBeUndefined();
    expect(definition.start.create).toBeUndefined();
    expect(definition.start.daemonPort).toBeUndefined();
    expect(definition.cli.startWords("headless")).toEqual([]);
    expect(definition.cli.previewArgs).toBeUndefined();
  }
});

test("agy and all declared reviewer variants cannot own any task class", () => {
  const instances = validateInstances(declarations), roles = Object.fromEntries(Object.keys(declarations).map(id => [id, ["reviewer"]]));
  const routing = parseRouting('[local]\nfixed_model="fixture"\n');
  for (const id of ["agy-review", ...Object.keys(declarations)]) for (const taskClass of ["implement", "summarize", "review"] as const) {
    const result = assign({ class: taskClass, signals: [] }, { [id]: "idle" }, routing, { instances, roles, candidates: [id], namedOwner: id });
    expect(result.owner).toBeUndefined();
  }
  expect(() => validateInstances({ "agy-build": { kind: "agy", roles: ["implementer"], start_mode: "headless" } })).toThrow("reviewer");
});

test("variant selection requires explicit own reviewer-only roles without executing role getters", () => {
  let reads = 0;
  const roles = Object.defineProperty([], "0", { enumerable: true, get() { reads++; return "reviewer"; } });
  expect(registry.definitionOf("codex-review", { "codex-review": { kind: "codex", start_mode: "headless", roles } })).toBe(registry.definitionOf("codex"));
  expect(registry.definitionOf("codex-review", { "codex-review": { kind: "codex", start_mode: "headless", roles: ["reviewer", "implementer"] } })).toBe(registry.definitionOf("codex"));
  expect(reads).toBe(0);

});

test("legacy Codex and Kimi reviewer declarations retain native permission and worktree contracts", () => {
  for (const kind of ["codex", "kimi"]) {
    const id = `${kind}-legacy`;
    const declared = validateInstances({ [id]: { kind, roles: ["reviewer"], start_mode: "headless", permission_mode: "never-ask", worktree: ".worktrees/legacy" } });
    expect(registry.definitionOf(id, declared)).toBe(registry.definitionOf(kind));
    expect(declared[id]).toMatchObject({ permission_mode: "never-ask", worktree: ".worktrees/legacy" });
    expect(registry.definitionOf(id, { [id]: { kind, roles: ["reviewer"], start_mode: "headless" } })).toBe(registry.definitionOf(kind));
  }
});

test("fresh review mode is literal, explicit and restricted to reviewer-only headless declarations", () => {
  for (const review_mode of [null, false, "resume", undefined]) {
    expect(() => validateInstances({ "codex-review": { ...declarations["codex-review"], review_mode } })).toThrow("review_mode");
  }
  for (const patch of [{ roles: ["implementer"] }, { roles: ["reviewer", "planner"] }, { start_mode: "tui" }, { start_mode: undefined }]) {
    expect(() => validateInstances({ "codex-review": { ...declarations["codex-review"], ...patch } })).toThrow("review_mode");
  }
  expect(() => validateInstances({ "pi-review": { kind: "pi", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } })).toThrow("review_mode");
  expect(registry.definitionOf("claude-review", validateInstances({ "claude-review": declarations["claude-review"] }))?.reviewer?.declaration).toBe("automatic");
});


test("Kimi fresh reviewer resolves only the task-MCP native-policy backend", () => {
  const variant = registry.definitionOf("kimi-review", declarations)!;
  expect(variant.reviewer?.unavailable).toBeUndefined();
  expect(variant.reviewer?.backend).toMatchObject({ id: "kimi", taskMcp: true, nativePolicy: true });
  expect(variant.start.create).toBeFunction();
  expect(variant.start.daemonPort).toBe("reviewer-print");
  expect(variant.budget?.account).toBe("kimi");
});
