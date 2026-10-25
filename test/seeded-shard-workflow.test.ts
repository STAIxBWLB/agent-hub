import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("seeded CI checks the exact head with fetched history and an explicit event base (#684)", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/check.yml", import.meta.url), "utf8")) as {
    jobs: Record<string, { steps: { uses?: string; name?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string }[] }>;
  };
  const steps = workflow.jobs["seeded-shard"]!.steps;
  const checkout = steps.find(step => step.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with?.["fetch-depth"]).toBe(0);
  expect(checkout?.with?.ref).toContain("github.event.pull_request.head.sha");
  const run = steps.find(step => step.name === "Sequential green and seeded guard pairs");
  expect(run?.env?.SEED_BASE_REF).toContain("github.event.pull_request.base.sha");
  expect(run?.env?.SEED_BASE_REF).toContain("github.event.before");
  expect(run?.run).toContain('--base "$SEED_BASE_REF"');
  expect(run?.run).toContain("--shard");
});
