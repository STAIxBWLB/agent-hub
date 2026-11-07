import { expect, test } from "bun:test";
import { CompatPublishInputError, planCompatPublish, type CompatPublishInput, type CompatPullRequest, type PublishManifestEntry } from "../scripts/compat-publish.ts";

const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
function fixture(id = "pi", version = "1.10.0") {
  const entry: PublishManifestEntry = { receipt: "docs/verification/fixture.md", autoAdmit: true, nativePlatform: "macos-arm64", runnerOS: ["macos"],
    install: { method: "npm-exact" }, legs: [
      { id: "native-identity", category: "macos-runner", requiredForAdmission: true, runnerOS: ["macos"] },
      { id: "isolated-home-cleanup", category: "macos-runner", requiredForAdmission: true, runnerOS: ["macos"] },
    ] };
  const summary = { schemaVersion: 1, id, version, runnerOS: "macos", architecture: "arm64", procedureReceipt: entry.receipt,
    generatedAt: "2026-11-07T00:00:00.000Z", bounds: { totalMs: 100, legMs: 50, cleanupMs: 10, outputMs: 10 }, elapsedMs: 1,
    ownedStopConfirmed: true, processCleanup: "unproven", processCleanupReason: "UNTRUSTED_REASON_DO_NOT_PUBLISH",
    containment: "disposable-runner-lifetime", autoAdmit: true, eligible: false, outcome: "pass",
    artifact: { method: "npm-exact", integrity }, integrity,
    installation: { status: "pass", cause: "ok", reason: "untrusted installation text", nextStep: "untrusted next step" },
    legs: entry.legs.map(leg => ({ id: leg.id, requiredForAdmission: leg.requiredForAdmission, status: "pass", cause: "ok",
      reason: "UNTRUSTED_LEG_TEXT", nextStep: "UNTRUSTED_CODE_PAYLOAD $(never execute)" })),
  };
  const input: CompatPublishInput = { manifest: { [id]: entry }, candidates: [{ id, version }], artifacts: [summary], existingPullRequests: [], dryRun: false };
  const pr = (number: number, previous: string, state: CompatPullRequest["state"] = "open"): CompatPullRequest => ({ number, id, version: previous, state, branch: `compat/${id}-${previous}` });
  return { entry, summary, input, pr };
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
}

test("complete trusted-policy pass creates a projected receipt; eligible and lifetime cleanup claims do not authorize it", () => {
  const f = fixture(); freeze(f.input);
  const plan = planCompatPublish(f.input);
  expect(plan.actions).toHaveLength(1);
  const action = plan.actions[0]!; expect(action.kind).toBe("create-pr");
  if (action.kind !== "create-pr") throw Error("missing create plan");
  expect(action.branch).toBe("compat/pi-1.10.0");
  expect(action.receipt.processCleanup).toBe("unproven");
  expect(action.receipt.autoAdmit).toBe(true);
  expect(action.receipt.legs[0]!.category).toBe("macos-runner");
  expect(JSON.stringify(plan)).not.toContain("UNTRUSTED");
  expect(action.receipt).not.toHaveProperty("eligible");
  expect(f.summary.eligible).toBe(false);
});

test("policy false never creates a PR even with forged eligible/autoAdmit flags", () => {
  const f = fixture(); f.entry.autoAdmit = false; f.summary.eligible = true;
  expect(planCompatPublish(f.input).actions).toMatchObject([{ kind: "update-drift", cause: "policy" }]);
  for (const id of ["codex-review", "agy"]) {
    const g = fixture(id); g.summary.eligible = true;
    expect(planCompatPublish(g.input).actions).toMatchObject([{ kind: "update-drift", cause: "policy" }]);
  }
});

test("failed and not-run required legs produce safe drift rows with no PR", () => {
  const failed = fixture(); failed.summary.legs[0]!.status = "fail"; failed.summary.legs[0]!.cause = "proof-failed"; failed.summary.outcome = "fail"; failed.summary.eligible = true;
  const failure = planCompatPublish(failed.input).actions[0]!;
  expect(failure).toMatchObject({ kind: "update-drift", cause: "proof-failed" });
  expect(JSON.stringify(failure)).not.toContain("UNTRUSTED");
  const pending = fixture(); pending.summary.legs[0]!.status = "not-run"; pending.summary.legs[0]!.cause = "producer-not-committed"; pending.summary.outcome = "not-run";
  expect(planCompatPublish(pending.input).actions).toMatchObject([{ kind: "update-drift", cause: "not-run" }]);
});

test("model, TUI and source review cannot be promoted by artifact pass claims", () => {
  for (const [category, cause, id] of [["account-or-model", "model-required", "model-backed-hub-call"], ["tui-desktop", "tui-required", "interactive-control"], ["linux-ci", "source-review-required", "source-review"]]) {
    const f = fixture();
    f.entry.legs = [...f.entry.legs, { id: id!, category: category!, runnerOS: ["macos"], requiredForAdmission: true }];
    f.summary.legs.push({ id: id!, requiredForAdmission: true, status: "not-run", cause: cause!, reason: "do not publish", nextStep: "do not publish" });
    f.summary.outcome = "not-run";
    expect(planCompatPublish(f.input).actions[0]).toMatchObject({ kind: "update-drift", cause: "not-run" });
    f.summary.legs.at(-1)!.status = "pass"; f.summary.legs.at(-1)!.cause = "ok"; f.summary.outcome = "pass";
    expect(planCompatPublish(f.input).actions[0]).toMatchObject({ kind: "update-drift", cause: "malformed-artifact" });
  }
});

test("existing same-version PR updates and older semver PRs supersede only after a passing replacement", () => {
  const f = fixture(); f.input.existingPullRequests = [f.pr(12, "1.9.0"), f.pr(14, "1.10.0"), f.pr(10, "1.8.0", "closed")];
  expect(planCompatPublish(f.input).actions).toMatchObject([
    { kind: "update-pr", number: 14, branch: "compat/pi-1.10.0" },
    { kind: "supersede-pr", number: 12, version: "1.9.0", replacementVersion: "1.10.0", replacementBranch: "compat/pi-1.10.0" },
  ]);
  f.summary.legs[0]!.status = "fail"; f.summary.legs[0]!.cause = "proof-failed"; f.summary.outcome = "fail";
  expect(planCompatPublish(f.input).actions).toMatchObject([{ kind: "update-drift", cause: "proof-failed" }]);
});

test("prerelease numeric identifiers and stable releases use semver ordering", () => {
  const f = fixture("pi", "2.0.0-alpha.10"); f.input.existingPullRequests = [f.pr(1, "2.0.0-alpha.2")];
  expect(planCompatPublish(f.input).actions.map(action => action.kind)).toEqual(["create-pr", "supersede-pr"]);
  const g = fixture("pi", "2.0.0"); g.input.existingPullRequests = [g.pr(1, "2.0.0-rc.1")];
  expect(planCompatPublish(g.input).actions.map(action => action.kind)).toEqual(["create-pr", "supersede-pr"]);
});

test("a newer open or merged PR prevents an older candidate from creating or superseding anything", () => {
  for (const state of ["open", "merged"] as const) {
    const f = fixture(); f.input.existingPullRequests = [f.pr(1, "2.0.0", state)];
    expect(planCompatPublish(f.input).actions).toMatchObject([{ kind: "update-drift", cause: state === "open" ? "newer-pr" : "already-published" }]);
  }
});

test("dry run returns the same reviewable actions without mutating inputs or executing a write port", () => {
  const f = fixture(); const actual = planCompatPublish(f.input);
  f.input.dryRun = true; freeze(f.input);
  const dry = planCompatPublish(f.input), writes: unknown[] = [];
  // The executor must honor this flag before invoking any effect; the planner has no effect ports.
  if (!dry.dryRun) for (const action of dry.actions) writes.push(action);
  expect(writes).toEqual([]); expect(dry.actions).toEqual(actual.actions); expect(dry.dryRun).toBe(true);
});

test("missing artifacts and duplicate or unknown artifact identities cannot produce PR actions", () => {
  const f = fixture(); f.input.artifacts = [];
  expect(planCompatPublish(f.input).actions).toMatchObject([{ kind: "update-drift", cause: "missing-artifact" }]);
  for (const artifacts of [[f.summary, f.summary], [{ ...f.summary, id: "../../payload" }], [null]]) {
    f.input.artifacts = artifacts;
    expect(planCompatPublish(f.input).actions).toMatchObject([{ kind: "update-drift", cause: "malformed-artifact" }]);
  }
});

test("an entry with unspecified runner OS reports trusted manual leg causes without an invented Linux receipt", () => {
  const f = fixture("qwen-dual"); f.entry.runnerOS = ["unspecified"]; f.entry.nativePlatform = "unspecified";
  f.entry.legs = [
    { id: "real-model", category: "account-or-model", runnerOS: ["unspecified"], requiredForAdmission: true },
    { id: "Q2-tui", category: "tui-desktop", runnerOS: ["unspecified"], requiredForAdmission: true },
    { id: "unknown-host", category: "linux-ci", runnerOS: ["unspecified"], requiredForAdmission: true },
  ];
  f.input.artifacts = [];
  expect(planCompatPublish(f.input).actions).toMatchObject([{ kind: "update-drift", cause: "not-run", legs: [
    { id: "real-model", status: "not-run", cause: "model-required" }, { id: "Q2-tui", status: "not-run", cause: "tui-required" },
    { id: "unknown-host", status: "not-run", cause: "platform" },
  ] }]);
});

test("malformed summaries reject inconsistent legs, outcomes, integrity, runner identity and survivor claims", () => {
  const changes: ((summary: ReturnType<typeof fixture>["summary"]) => void)[] = [
    s => { s.legs.pop(); }, s => { s.legs[1] = { ...s.legs[0]! }; },
    s => { s.legs[0]!.requiredForAdmission = false; }, s => { Object.assign(s.legs[0]!, { category: "account-or-model" }); },
    s => { s.legs[0]!.cause = "timeout"; }, s => { s.legs[0]!.status = "fail"; s.legs[0]!.cause = "proof-failed"; },
    s => { s.artifact.integrity = "sha1-weak"; s.integrity = "sha1-weak"; }, s => { s.integrity = "mismatch"; },
    s => { s.artifact.method = "github-release-asset-checksum"; }, s => { s.architecture = "x64"; }, s => { s.runnerOS = "payload/../macos"; },
    s => { s.procedureReceipt = "../../payload.ts"; }, s => { Object.assign(s, { survivorDetected: true }); },
    s => { Object.assign(s, { payload: "arbitrary code" }); }, s => { Object.assign(s, { toJSON: () => { throw Error("must not invoke"); } }); },
  ];
  for (const change of changes) {
    const f = fixture(); change(f.summary);
    expect(planCompatPublish(f.input).actions).toMatchObject([{ kind: "update-drift", cause: "malformed-artifact" }]);
  }
});

test("owned stop failure and a detected survivor remain failures despite forged eligibility", () => {
  for (const survivor of [false, true]) {
    const f = fixture(); f.summary.eligible = true; f.summary.outcome = "fail";
    if (survivor) Object.assign(f.summary, { survivorDetected: true }); else f.summary.ownedStopConfirmed = false;
    expect(planCompatPublish(f.input).actions).toMatchObject([{ kind: "update-drift", cause: "proof-failed" }]);
  }
});

test("artifact accessors are refused without invoking them, and one malformed artifact stops all PR plans", () => {
  const f = fixture(); let reads = 0;
  Object.defineProperty(f.summary, "eligible", { enumerable: true, get() { reads++; return true; } });
  expect(planCompatPublish(f.input).actions[0]).toMatchObject({ kind: "update-drift", cause: "malformed-artifact" }); expect(reads).toBe(0);
  const array = fixture(); Object.defineProperty(array.summary.legs, "0", { get() { reads++; throw Error("must not invoke"); }, enumerable: true });
  expect(planCompatPublish(array.input).actions[0]).toMatchObject({ kind: "update-drift", cause: "malformed-artifact" }); expect(reads).toBe(0);
  const a = fixture(), b = fixture("kimi-review"); b.summary.legs.pop();
  a.input.manifest = { pi: a.entry, "kimi-review": b.entry }; a.input.candidates = [...a.input.candidates, ...b.input.candidates]; a.input.artifacts = [a.summary, b.summary];
  expect(planCompatPublish(a.input).actions.map(action => action.kind)).toEqual(["update-drift", "update-drift"]);
});

test("unsafe candidate/PR identities, ambiguous PRs and more than eight IDs refuse the whole plan", () => {
  for (const version of ["latest", "1.0.0;code", "1.0.0/../code", "01.0.0", "1.0.0-alpha.01"]) {
    const f = fixture(); f.input.candidates = [{ id: "pi", version }]; expect(() => planCompatPublish(f.input)).toThrow(CompatPublishInputError);
  }
  const f = fixture(); f.input.existingPullRequests = [{ ...f.pr(1, "1.9.0"), branch: "main" }];
  expect(() => planCompatPublish(f.input)).toThrow(CompatPublishInputError);
  f.input.existingPullRequests = [f.pr(1, "1.9.0"), f.pr(2, "1.9.0")]; expect(() => planCompatPublish(f.input)).toThrow(CompatPublishInputError);
  f.input.existingPullRequests = []; f.input.candidates = Array.from({ length: 9 }, (_, i) => ({ id: `agent-${i}`, version: "1.0.0" }));
  expect(() => planCompatPublish(f.input)).toThrow(CompatPublishInputError);
});
