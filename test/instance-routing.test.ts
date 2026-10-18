import { expect, test } from "bun:test";
import { assign, parseRouting, relayCandidates } from "../src/hub/routing.ts";
import type { PeerState } from "../src/hub/envelope.ts";

type Options = NonNullable<Parameters<typeof assign>[3]> & {
  instances?: Readonly<Record<string, { kind: string }>>;
  wip?: Record<string, number>;
  load?: Record<string, number>;
};
const instances = { "codex-a": { kind: "codex" }, "codex-b": { kind: "codex" }, "kimi-a": { kind: "kimi" }, "local-a": { kind: "local" }, "pi-a": { kind: "pi" } };
const work = { class: "implement" as const, signals: [] };
function routing(peers = ["codex"], reviewers = ["claude", "codex"]) {
  return parseRouting(`[local]\nfixed_model="fixture"\n[classes.implement]\npeers=${JSON.stringify(peers)}\n[classes.review]\npeers=${JSON.stringify(reviewers)}\n`);
}
const choose = (states: Record<string, PeerState>, opts: Options = {}, peers?: string[], reviewers?: string[]) => assign(work, states, routing(peers, reviewers), opts);

test("I2 kind policy expands declared siblings and orders idle, WIP, queued load with stable ties", () => {
  const states = { codex: "busy", "codex-a": "idle", "codex-b": "idle", claude: "idle" } as const;
  expect(choose(states, { instances, wip: { "codex-a": 2, "codex-b": 1 }, load: { "codex-b": 99 } }).owner).toBe("codex-b");
  expect(choose(states, { instances, wip: { "codex-a": 1, "codex-b": 1 }, load: { "codex-a": 2, "codex-b": 1 } }).owner).toBe("codex-b");
  expect(choose(states, { instances, wip: {}, load: {} }).owner).toBe("codex-a");
  expect(choose({ codex: "idle", "codex-a": "busy", claude: "idle" }, { instances, wip: { codex: 4, "codex-a": 0 } }).owner).toBe("codex");
  expect(choose({ "codex-a": "idle", claude: "idle" }, { instances }).owner).toBe("codex-a");
});

test("I2 exact candidates, nominations and reservations never expand a manual base id", () => {
  const states = { codex: "busy", "codex-a": "idle", claude: "idle" } as const;
  expect(choose(states, { instances, candidates: ["codex"], namedOwner: "codex" }).owner).toBe("codex");
  expect(choose(states, { instances, candidates: ["codex-a"], namedOwner: "codex-a" }).owner).toBe("codex-a");
  expect(choose({ codex: "idle", "codex-a": "busy", claude: "idle" }, { instances, namedOwner: "codex-a" }).owner).toBe("codex-a");
  expect(assign({ ...work, reserved: "codex" }, states, routing(), { instances } as Options).owner).toBe("codex");
  expect(choose({ "codex-a": "idle", claude: "idle" }, { instances, candidates: ["codex"], namedOwner: "codex" }).owner).toBeUndefined();
});

test("I2 undeclared suffixes never inherit kind policy or admission", () => {
  const result = choose({ "codex-ghost": "idle" }, { instances, candidates: ["codex-ghost"], namedOwner: "codex-ghost" });
  expect(result.owner).toBeUndefined();
  expect(result.refusals).toContainEqual(expect.objectContaining({ peer: "codex-ghost", code: "instance" }));
  expect(choose({ "codex-ghost": "idle" }, { instances }).owner).toBeUndefined();
});

test("I2 mapped metadata keeps roster, pull-only, capability, PII and native policy guards on each instance", () => {
  const states = { "codex-a": "idle", "local-a": "idle", "pi-a": "idle" } as const;
  expect(choose(states, { instances, offRoster: ["codex-a"] }).owner).toBeUndefined();
  expect(choose(states, { instances, pullOnly: ["codex-a"] }).owner).toBeUndefined();
  expect(choose(states, { instances, candidates: ["codex-a"], namedOwner: "codex-a", capabilities: { "codex-a": { tests: false, spec: true } } }).refusals)
    .toContainEqual(expect.objectContaining({ peer: "codex-a", code: "tests" }));
  const privateTask = assign({ ...work, signals: ["pii"] }, states, routing(["codex", "local"]), { instances } as Options);
  expect(privateTask).toMatchObject({ owner: "local-a", reviewer: "user" });
  const constrained = routing(["local"]); constrained.classes.implement!.local_allowed = false;
  expect(assign(work, states, constrained, { instances } as Options).owner).toBeUndefined();
  const spec = assign({ ...work, title: "Implement #418", refs: {} }, states, routing(), { instances, repository: "STAIxBWLB/agent-hub", capabilities: { "codex-a": { tests: true, spec: false } } } as Options);
  expect(spec.refusals).toContainEqual(expect.objectContaining({ peer: "codex-a", code: "spec" }));
});

test("I2 an eligible busy other-family reviewer wins over an idle same-family sibling", () => {
  const result = choose({ "codex-a": "idle", "codex-b": "idle", "kimi-a": "busy" }, { instances, candidates: ["codex-a"] }, ["codex"], ["codex", "kimi"]);
  expect(result).toMatchObject({ owner: "codex-a", reviewer: "kimi-a" });
  expect(result).not.toHaveProperty("sameFamilyFallback");
});

test("I2 a named same-family reviewer cannot bypass an eligible other family", () => {
  const result = choose({ "codex-a": "idle", "codex-b": "idle", "kimi-a": "busy" }, { instances, candidates: ["codex-a"], namedReviewer: "codex-b" }, ["codex"], ["codex", "kimi"]);
  expect(result.owner).toBe("codex-a"); expect(result.reviewer).toBeUndefined();
  expect(result.refusals).toContainEqual(expect.objectContaining({ peer: "codex-b", role: "reviewer", code: "family" }));
});

test("I2 same-family review is recorded only after all other families are ineligible", () => {
  const result = choose({ "codex-a": "idle", "codex-b": "busy", "kimi-a": "idle" }, { instances, candidates: ["codex-a"], offRoster: ["kimi-a"] }, ["codex"], ["codex", "kimi"]);
  expect(result).toMatchObject({ owner: "codex-a", reviewer: "codex-b", sameFamilyFallback: true });
  expect(result.trace.join("\n")).toContain("same-family fallback");
  const roleOnly = choose({ "codex-a": "idle", "codex-b": "idle", "kimi-a": "busy" }, { instances, candidates: ["codex-a"], roles: { "kimi-a": ["reviewer"] } }, ["codex"], ["codex"]);
  expect(roleOnly.reviewer).toBe("kimi-a");
});

test("I2 no-instance assignment retains the complete legacy result and trace bytes", () => {
  const expected = { owner: "codex", reviewer: "claude", fixedModel: "fixture", trace: ["class implement", "signals: none", "  owner candidate codex: idle", "owner: codex", "  reviewer candidates: [classes.review] peers claude, codex", "  reviewer candidate claude: idle", "  reviewer candidate codex: skipped, is the owner", "reviewer: claude"] };
  expect(choose({ codex: "idle", claude: "idle" })).toEqual(expected);
  expect(choose({ codex: "idle", claude: "idle" }, { instances: {}, load: { codex: 9 }, wip: { codex: 9 } })).toEqual(expected);
  expect(relayCandidates(["codex", "kimi"], false)).toEqual(["pi", "local", "codex", "kimi"]);
});
