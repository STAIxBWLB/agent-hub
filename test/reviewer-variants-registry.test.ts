import { expect, test } from "bun:test";
import * as registry from "../src/adapters/registry.ts";
import { validateInstances } from "../src/hub/instances.ts";
import { assign, parseRouting } from "../src/hub/routing.ts";

const declarations = {
  "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" as const },
  "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless" as const },
  "kimi-review": { kind: "kimi", roles: ["reviewer"], start_mode: "headless" as const },
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

test("default pool includes verified-capable fixed backends and excludes unavailable Kimi and agy", () => {
  expect((registry as unknown as { DEFAULT_REVIEW_POOL: readonly string[] }).DEFAULT_REVIEW_POOL).toEqual(["claude", "codex"]);
  expect(registry.definitionOf("agy")).toMatchObject({ optional: true, defaultOnRoster: false, routing: { reviewOnly: true } });
  expect(registry.definitionOf("agy")?.reviewer?.defaultPool).toBe(false);
  expect(registry.OPTIONAL_PEERS).not.toContain("agy");
  expect(registry.isSupportedPeer("agy")).toBe(false);
  expect(registry.isStartablePeer("agy")).toBe(false);
  expect(registry.ADAPTERS.some(definition => definition.kind === "agy")).toBe(false);
});

test("Kimi and agy are unavailable declaration metadata with no model factory or launch argv", () => {
  for (const id of ["kimi-review", "agy-review"]) {
    const definition = registry.definitionOf(id, declarations)!;
    expect(definition.reviewer?.unavailable).toContain("#533");
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
  for (const id of ["agy", ...Object.keys(declarations)]) for (const taskClass of ["implement", "summarize", "review"] as const) {
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
