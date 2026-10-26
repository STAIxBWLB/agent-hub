import { expect, test } from "bun:test";
import { CONFIG_EDIT_FILES, configTier, structuralLeaf, TIER3_PREFIXES } from "../src/hub/config-tier.ts";
import { NEVER_EDITABLE } from "../src/hub/settings.ts";

const tier = (file: "config.local.json" | "sdlc.toml", ...path: string[]) => configTier(file, path);

test("#689 tier 2 covers instance fields that choose no executable or home", () => {
  for (const field of ["kind", "roles", "start_mode", "review_mode", "readOnly", "worktree", "permission_mode"]) {
    expect(tier("config.local.json", "instances", "codex-review", field), field).toEqual({ tier: 2 });
  }
  expect(tier("config.local.json", "instances", "codex-review")).toEqual({ tier: 2 });
  // #844: a Claude implementer's model is the same tier 3 field, whole-object and single-field.
  expect(tier("config.local.json", "instances", "claude-impl", "model")).toEqual({ tier: 3, key: "instances.claude-impl.model" });
  expect(configTier("config.local.json", ["instances", "claude-impl"], { kind: "claude", roles: ["implementer"], model: "claude-sonnet-5-5" })).toEqual({ tier: 3, key: "instances.claude-impl" });
  expect(configTier("config.local.json", ["instances", "claude-impl"], { kind: "claude", roles: ["implementer"] }, { kind: "claude", model: "x" })).toEqual({ tier: 3, key: "instances.claude-impl" });
  for (const path of [["review", "adaptive"], ["review", "min_reviews"], ["review", "pool"], ["review", "rerotate"], ["snapshots", "keep"], ["approvals", "timeout_s"], ["context", "gate"]]) {
    expect(tier("config.local.json", ...path), path.join(".")).toEqual({ tier: 2 });
  }
  expect(tier("sdlc.toml", "mode")).toEqual({ tier: 2 });
  expect(tier("sdlc.toml", "required_checks")).toEqual({ tier: 2 });
});

test("#689 tier 3 is the executable and secret-locating keys, never tier 2", () => {
  for (const field of ["jcode_home", "provider", "model", "provider_profile"]) {
    expect(tier("config.local.json", "instances", "jcode-two", field), field).toEqual({ tier: 3, key: `instances.jcode-two.${field}` });
  }
  for (const never of NEVER_EDITABLE.filter(key => key !== "instances")) {
    expect(tier("config.local.json", ...never.split(".")), never).toMatchObject({ tier: 3 });
  }
  expect(tier("config.local.json", "omniroute", "api_key_file")).toMatchObject({ tier: 3 });
  expect(tier("config.local.json", "adapters", "grok")).toMatchObject({ tier: 3 });
  expect(tier("config.local.json", "terminal", "open")).toMatchObject({ tier: 3 });
  expect(TIER3_PREFIXES).toContain("kimi_cmd");
});

test("#689 a whole instance takes the highest tier among its fields, and an unknown field is refused", () => {
  expect(configTier("config.local.json", ["instances", "codex-review"], { kind: "codex", roles: ["reviewer"], start_mode: "headless" })).toEqual({ tier: 2 });
  expect(configTier("config.local.json", ["instances", "jcode-two"], { kind: "jcode", jcode_home: "/tmp/x" })).toEqual({ tier: 3, key: "instances.jcode-two" });
  expect(configTier("config.local.json", ["instances", "codex-review"], { kind: "codex", nonsense: 1 })).toEqual({ refused: "instances.codex-review.nonsense: unknown instance field; nothing was written" });
  expect(configTier("config.local.json", ["instances", "codex-review"], "codex")).toEqual({ refused: "instances.codex-review: must be an object of instance fields; nothing was written" });
});

test("#689 anything else is refused by name, never dropped", () => {
  for (const path of [["instances"], ["nonsense"], ["roster", "codex"], ["tasks", "wip_limits", "codex"], ["__proto__", "x"], ["instances", "BAD ID", "kind"], ["instances", "a", "kind", "deep"]]) {
    const result = tier("config.local.json", ...path);
    expect("refused" in result, path.join(".")).toBe(true);
  }
  expect("refused" in tier("sdlc.toml", "bands")).toBe(true);
  expect("refused" in tier("sdlc.toml", "stages")).toBe(true);
  expect(tier("config.local.json", "roster", "codex")).toEqual({ refused: "roster.codex is already editable with ahub settings set roster.codex; nothing was written" });
  expect(tier("config.local.json", "tasks", "wip_limits", "codex")).toEqual({ refused: "tasks.wip_limits.codex is already editable with ahub settings set tasks.wip_limits.codex; nothing was written" });
});

test("#689 structuralLeaf is the one rule reload authority reads, and it never admits tier 3", () => {
  for (const key of ["instances.codex-review.kind", "instances.codex-review.roles", "review.pool", "snapshots.keep", "approvals.timeout_s", "context.gate"]) expect(structuralLeaf(key), key).toBe(true);
  for (const key of ["instances.jcode-two.jcode_home", "kimi_cmd", "omniroute.api_key_file", "terminal.open", "instances", "roster.codex", "checks.timeout_s", "adapters.grok.command"]) expect(structuralLeaf(key), key).toBe(false);
  expect(CONFIG_EDIT_FILES).toEqual(["config.local.json", "sdlc.toml"]);
});

import { maskTier3 } from "../src/hub/config-tier.ts";
test("#689 maskTier3 shows a tier 3 key, a tier 3 instance field and anything under a tier 3 prefix only as (set)", () => {
  expect(maskTier3(["instances", "jcode-two", "model"], "m")).toBe("(set)");
  expect(maskTier3(["kimi_cmd"], ["/bin/sh"])).toBe("(set)");
  expect(maskTier3(["omniroute", "api_key_file"], "/etc/key")).toBe("(set)");
  expect(maskTier3(["terminal", "open"], "x")).toBe("(set)");
  expect(maskTier3(["instances", "jcode-two"], { kind: "jcode", jcode_home: "/h", roles: ["implementer"] })).toEqual({ kind: "jcode", jcode_home: "(set)", roles: ["implementer"] });
  expect(maskTier3(["review", "pool"], ["claude"])).toEqual(["claude"]);
  expect(maskTier3(["instances", "x", "roles"], ["reviewer"])).toEqual(["reviewer"]);
  expect(maskTier3(["kimi_cmd"], undefined)).toBeUndefined();
});
