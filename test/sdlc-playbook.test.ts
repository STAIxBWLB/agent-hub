import { expect, test } from "bun:test";
import { PLAYBOOK_STAGES, SDLC_STAGES, RETIRED_WORKFLOW_FROM, canonicalStage, playbookStage, sdlcConfig, sdlcReceipt, sdlcStatus, stageDefinition } from "../src/hub/sdlc.ts";
import { profileTaskTools, TASK_TOOLS } from "../src/hub/hub-tools.ts";

// #481 S0/S8. AC0: playbook stages when enabled, legacy receipts through aliases, custom definitions load, off byte-identical.
const A = "a".repeat(40);
const OFF_BEFORE = '{"mode":"off","requiredChecks":[],"stages":["spec","plan","implement","review","verify","merge","release"]}';

test("off keeps the #257 config, schema and status bytes; an enabled lifecycle defaults to the playbook stages", () => {
  expect(JSON.stringify(sdlcConfig(undefined))).toBe(OFF_BEFORE);
  expect(JSON.stringify(sdlcConfig({ mode: "off" }))).toBe(OFF_BEFORE);
  expect(profileTaskTools("dev", sdlcConfig(undefined).stages)).toBe(TASK_TOOLS);
  const status = sdlcStatus(sdlcConfig(undefined), sdlcReceipt({ stage: "implement" }));
  expect(Object.keys(status)).toEqual(["mode", "stage", "blockers", "ready", "actor", "next"]);
  for (const mode of ["advise", "enforce"] as const) expect(sdlcConfig({ mode, required_checks: ["gate"] }).stages).toEqual([...PLAYBOOK_STAGES]);
  expect(sdlcConfig({ mode: "advise", stages: [...SDLC_STAGES] }).stages).toEqual(["spec", "plan", "build", "review", "test", "merge", "release"]); // an explicit #257 list loads under canonical ids
  expect(() => sdlcConfig({ mode: "advise", stages: ["intent", "spec"] })).toThrow("other lists need definitions");
});

test("implement and verify receipts read as build and test; new writes store the canonical id", () => {
  const config = sdlcConfig({ mode: "advise", required_checks: ["gate"] });
  expect(canonicalStage("implement")).toBe("build"); expect(canonicalStage("verify")).toBe("test"); expect(canonicalStage("review")).toBe("review");
  expect(stageDefinition(config, "implement")?.base).toBe("build");
  expect(stageDefinition(config, "verify")).toMatchObject({ base: "test", actor: "reviewer" });
  expect(sdlcReceipt({ stage: "implement" }, undefined, config).stage).toBe("build");
  expect(sdlcReceipt({ stage: "verify" }, undefined, config).stage).toBe("test");
  expect(sdlcReceipt({ repo: "owner/repo" }, undefined, config).stage).toBe("intent");
  const stored = sdlcStatus(config, { stage: "implement" }); // a receipt written before #481
  expect(stored.blockers).not.toContain("lifecycle stage definition unknown");
  expect(stored).toMatchObject({ stage: "implement", playbook: "Build", actor: "owner/planner" });
  expect(sdlcStatus(config, { stage: "test" })).toMatchObject({ playbook: "Test", actor: "reviewer" });
  expect(PLAYBOOK_STAGES.map(playbookStage)).toEqual(["Plan", "Design", "Build", "Build", "Test", "Deploy", "Deploy", "Deploy", "Maintain"]);
});

test("custom definitions map onto the nine bases and keep loading with the #257 base names", () => {
  const raw = (base: string, id = "draft") => ({ mode: "advise", required_checks: ["gate"], stages: ["intent", id, "review", "merge"], definitions: { intent: { base: "intent" }, [id]: { base }, review: { base: "review" }, merge: { base: "merge" } } });
  for (const base of ["build", "implement", "maintain", "test", "verify"]) expect(stageDefinition(sdlcConfig(raw(base)), "draft")?.base as string).toBe(base);
  expect(() => sdlcConfig(raw("build", "test"))).toThrow("built-in playbook stage base cannot change");
  expect(sdlcConfig(raw("verify", "test")).definitions?.test?.base).toBe("verify"); // the alias is the same stage
  expect(() => sdlcConfig(raw("shipping"))).toThrow("unknown field or base");
});

test("the retired workflow setting and phase receipt load with a warning in the window and refuse after it (AC8b)", () => {
  const before = "0.12.35", after = RETIRED_WORKFLOW_FROM;
  const legacy = sdlcConfig({ mode: "advise", workflow: "gsd-lite", required_checks: ["gate"] }, before);
  expect(legacy.workflow).toBe("gsd-lite"); expect(legacy.deprecations?.[0]).toContain("deprecated and stops loading in " + after);
  expect(sdlcConfig({ mode: "advise", workflow: "none" }, before).deprecations).toBeUndefined(); // none stays silent
  for (const workflow of ["gsd-lite", "none"]) expect(() => sdlcConfig({ mode: "advise", workflow }, after)).toThrow("sdlc.workflow: retired in " + after);
  const phase = { id: "delivery", head: A, criteria: [{ id: "AC0", required: true, result: "unverified", refs: [] }] };
  const enabled = sdlcConfig({ mode: "advise", required_checks: ["gate"] }, before);
  expect(sdlcReceipt({ phase }, undefined, enabled, before)).toMatchObject({ criteria: phase });
  expect(sdlcReceipt({ phase }, undefined, enabled, before).phase).toBeUndefined();
  expect(() => sdlcReceipt({ phase }, undefined, enabled, after)).toThrow("sdlc receipt.phase: retired");
  expect(() => sdlcReceipt({ phase, criteria: phase }, undefined, enabled, before)).toThrow("give criteria only");
});

test("an enabled lifecycle advertises the criteria checklist in hub_sdlc_record; the off schema keeps phase", () => {
  const schema = (stages: readonly string[], criteria = false) => JSON.stringify(profileTaskTools("dev", stages, criteria).find(t => t.name === "hub_sdlc_record")!.inputSchema);
  const enabled = schema(PLAYBOOK_STAGES, true);
  expect(enabled).toContain('"criteria":{"type":"object"'); expect(enabled).not.toContain('"phase"'); expect(enabled).not.toContain('"tasks"');
  expect(enabled).toContain('"enum":["intent","spec","plan","build","test","review","merge","release","maintain"]');
  expect(schema(SDLC_STAGES)).toContain('"phase"');
});

test("an enabled explicit #257 list stores canonical ids, so implement and verify stay read-only aliases there too", () => {
  const config = sdlcConfig({ mode: "advise", stages: [...SDLC_STAGES], required_checks: ["gate"] });
  expect(["implement", "verify"].map(stage => sdlcReceipt({ stage }, undefined, config).stage)).toEqual(["build", "test"]);
  expect(sdlcStatus(config, { stage: "implement" }).blockers).not.toContain("lifecycle stage definition unknown"); // stored receipts still read
  expect(sdlcConfig({ mode: "off", stages: [...SDLC_STAGES] }).stages).toEqual([...SDLC_STAGES]); // off keeps its bytes
});

test("off keeps the #257 phase receipt bytes; the retired task import is still refused", () => {
  const criterion = { id: "criterion-one", required: true, result: "unverified", refs: [] };
  expect(JSON.stringify(sdlcReceipt({ phase: { id: "phase-one", head: A, tasks: [], criteria: [criterion] } })))
    .toBe(`{"stage":"spec","phase":{"id":"phase-one","head":"${A}","tasks":[],"criteria":[{"id":"criterion-one","required":true,"result":"unverified","refs":[]}]}}`);
  expect(() => sdlcReceipt({ phase: { id: "phase-one", tasks: [{ id: 2, after: [] }], criteria: [criterion] } })).toThrow("task import was retired");
  expect(sdlcReceipt({ criteria: { id: "phase-one", criteria: [criterion] } }).criteria?.id).toBe("phase-one");
});

test("custom stage ids and the checklist rename are independent: phase stays unless the daemon says the lifecycle is enabled", () => {
  const receipt = (stages: readonly string[], criteria: boolean) => profileTaskTools("dev", stages, criteria).find(t => t.name === "hub_sdlc_record")!.inputSchema.properties!.receipt as { properties: Record<string, { enum?: string[] }> };
  const old = receipt(["draft", "review", "merge"], false); // an older daemon or off mode with custom stages
  expect(Object.keys(old.properties)).toContain("phase"); expect(Object.keys(old.properties)).not.toContain("criteria");
  expect(old.properties.stage?.enum).toEqual(["draft", "review", "merge"]);
  const enabled = receipt(["draft", "review", "merge"], true);
  expect(Object.keys(enabled.properties)).toContain("criteria"); expect(Object.keys(enabled.properties)).not.toContain("phase");
  expect(profileTaskTools("dev", SDLC_STAGES, false)).toBe(TASK_TOOLS);
});
