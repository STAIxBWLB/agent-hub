import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/agent-compat.yml", import.meta.url), "utf8")) as {
  on: { workflow_dispatch: { inputs: Record<string, { description: string; type: string; default: unknown }> } };
  permissions: Record<string, string>;
  jobs: Record<string, { permissions: Record<string, string>; "timeout-minutes": number; "runs-on": string;
    strategy?: { "max-parallel": number }; outputs?: Record<string, string>;
    steps: { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> }[] }>;
};

test("candidate receipt jobs are read-only, credential-free, bounded hosted disposable runners", () => {
  expect(workflow.permissions).toEqual({ contents: "read" });
  const job = workflow.jobs.harness!;
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job["timeout-minutes"]).toBe(20); expect(job.strategy?.["max-parallel"]).toBe(2);
  expect(job["runs-on"]).toBe("${{ matrix.runner }}");
  expect(job.steps.filter(step => step.uses?.startsWith("actions/checkout@")).every(step => step.with?.["persist-credentials"] === false)).toBe(true);
  const contents = JSON.stringify(job);
  expect(contents).not.toContain("secrets."); expect(contents).not.toContain("github.token");
  const proof = job.steps.find(step => step.name === "Run the isolated candidate receipt")!;
  expect(proof.run).toContain('--disposable-runner');
  expect(proof.run).toContain('"$COMPAT_ID" "$COMPAT_VERSION"');
  expect(proof.run).not.toContain("${{ matrix.");
  expect(job.steps.some(step => step.uses?.startsWith("actions/upload-artifact@") && step.if === "always()")).toBe(true);
});

test("trusted bundle preparation has no GitHub write credential and publish reads only its immutable artifact", () => {
  const prepare = workflow.jobs.prepare!, publish = workflow.jobs.publish!;
  expect(prepare.permissions).toEqual({ contents: "read" });
  expect(JSON.stringify(prepare)).not.toContain("github.token"); expect(JSON.stringify(prepare)).not.toContain("secrets.");
  expect(prepare.steps.some(step => step.run?.includes("scripts/compat-prepare.ts"))).toBe(true);
  expect(prepare.outputs?.prepared_artifact).toBe("${{ steps.prepared_files.outputs.artifact-id }}");
  expect(publish.steps.find(step => step.uses?.startsWith("actions/download-artifact@"))?.with?.["artifact-ids"]).toBe("${{ needs.prepare.outputs.prepared_artifact }}");
  expect(publish.permissions).toEqual({ contents: "write", "pull-requests": "write", issues: "write", actions: "write" });
  for (const step of publish.steps) {
    expect(step.run ?? "").not.toMatch(/\b(?:bun|npm)\s+(?:install|run|x)\b/);
    expect(JSON.stringify(step)).not.toContain("compat-receipt.ts");
    expect(JSON.stringify(step)).not.toContain("secrets.");
  }
});

test("manual dry run is the default and every publisher mutation is guarded", () => {
  expect(workflow.on.workflow_dispatch.inputs.dry).toEqual({ description: "Run isolated proofs and prepare artifacts, print GitHub changes without applying them", type: "boolean", default: true });
  const publisher = workflow.jobs.publish!, legacy = publisher.steps.find(step => step.name === "Keep the agent-compat issue current")!;
  expect(legacy.if).toBe("github.event_name != 'workflow_dispatch' || !inputs.dry");
  for (const step of publisher.steps.filter(step => step.run?.includes("scripts/compat-publish-run.ts") && step.name !== legacy.name)) {
    expect(step.env?.COMPAT_DRY).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.dry }}");
    expect(step.run).toContain('args+=(--dry-run)');
  }
  expect(publisher.steps.find(step => step.name === "Validate the prepared publication before any mutation")?.run).toContain("--validate-only");
});
