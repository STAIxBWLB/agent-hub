import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { ActionBudgets, actionApprovalText, actionPolicyConfig, type ActionChallenge } from "../src/hub/action-policy.ts";

function rig() {
  let session: string | undefined = "session-a", config = actionPolicyConfig();
  const ledger = new ActionBudgets(() => config, () => session);
  const bound = ledger.bindSession("worker", session)!;
  const ask = (actions: Parameters<typeof ledger.request>[1]): ActionChallenge => {
    const result = ledger.request(bound, actions); expect(result.kind).toBe("ask");
    if (result.kind !== "ask" || !result.challenge) throw new Error("expected a current approval challenge");
    return result.challenge;
  };
  return { ledger, bound, ask, session: (next: string | undefined) => { session = next; }, config: (next: unknown) => { config = actionPolicyConfig(next); } };
}

test("action budgets start with a person approval, consume approved slots, then ask again", () => {
  const r = rig();
  expect(r.ledger.approve(r.ask(["destroy"]))).toBe(true); // First approved invocation consumes slot one.
  expect(r.ledger.request(r.bound, ["destroy"]).kind).toBe("budget");
  expect(r.ledger.request(r.bound, ["destroy"]).kind).toBe("budget");
  expect(r.ledger.request(r.bound, ["destroy"]).kind).toBe("ask");
  const one = r.ask(["publish"]); expect(r.ledger.approve(one)).toBe(true);
  expect(r.ledger.approve(one)).toBe(false);
  expect(r.ledger.request(r.bound, ["publish"]).kind).toBe("ask");
});

test("new native sessions and revoked owners cannot reuse prior or delayed approvals", () => {
  const r = rig(), old = r.ask(["install"]);
  r.session("session-b"); const next = r.ledger.bindSession("worker", "session-b")!;
  expect(r.ledger.approve(old)).toBe(false);
  expect(r.ledger.request(next, ["install"]).kind).toBe("ask");
  expect(r.ledger.bindSession("worker", "session-a")).toBeUndefined();
  r.session("session-a"); r.ledger.bindSession("worker", "session-a");
  expect(r.ledger.request(r.bound, ["install"]).kind).toBe("ask");
  const current = r.ledger.bindSession("worker", "session-a")!;
  const pending = r.ledger.request(current, ["install"]);
  r.ledger.revoke("worker"); expect(r.ledger.approve(pending.kind === "ask" ? pending.challenge : undefined)).toBe(false);
});

test("unknown session never gets a budget grant and status never binds a session", () => {
  const r = rig(); r.session(undefined);
  expect(r.ledger.request(r.bound, ["publish"])).toEqual({ kind: "ask", classes: ["publish"] });
  expect(r.ledger.status("worker", false).sessionBound).toBe(false);
  expect(r.ledger.status("other", false).sessionBound).toBe(false);
  expect(r.ledger.status("other", false).note).toContain("always-ask not enforceable");
});

test("mixed classes spend atomically; unknown and unselected actions retain native policy", () => {
  const r = rig(); expect(r.ledger.approve(r.ask(["install"]))).toBe(true);
  const before = r.ledger.status("worker", false).remaining;
  expect(r.ledger.request(r.bound, ["install", "publish"]).kind).toBe("ask");
  expect(r.ledger.status("worker", false).remaining).toEqual(before);
  expect(r.ledger.request(r.bound, [])).toEqual({ kind: "native" });
  r.config({ always_ask: ["destroy"] });
  expect(r.ledger.request(r.bound, ["publish"])).toEqual({ kind: "native" });
  r.config({ enabled: false });
  expect(r.ledger.request(r.bound, ["destroy"])).toEqual({ kind: "native" });
  expect(r.ledger.status("worker", false).note).toContain("always-ask not enforceable");
  expect(r.ledger.status("worker", false).note).toContain("policy disabled");
});

test("policy changes invalidate cached budget and outstanding approval challenges", () => {
  const r = rig(), pending = r.ask(["install"]);
  r.config({ budgets: { install: 10 } });
  expect(r.ledger.approve(pending)).toBe(false);
  expect(r.ledger.approve(r.ask(["install"]))).toBe(true);
  r.config({ budgets: { install: 0 } });
  expect(r.ledger.request(r.bound, ["install"]).kind).toBe("ask");
  expect(r.ledger.approve(r.ask(["install"]))).toBe(true);
  expect(r.ledger.request(r.bound, ["install"]).kind).toBe("ask");
});

test("published policy changes cannot revive grants after a change away and back", () => {
  const r = rig(), pending = r.ask(["install"]);
  expect(r.ledger.approve(r.ask(["destroy"]))).toBe(true);
  r.config({ enabled: false }); r.ledger.policyChanged();
  r.config({}); r.ledger.policyChanged();
  expect(r.ledger.approve(pending)).toBe(false);
  expect(r.ledger.request(r.bound, ["destroy"]).kind).toBe("ask");
  expect(r.ledger.approve(r.ask(["install"]))).toBe(true);
});

test("action policy defaults and bounded schema refuse ambiguous or unknown settings", () => {
  expect(actionPolicyConfig()).toEqual({ enabled: true, always_ask: ["publish", "external-write", "destroy", "install"], budgets: { publish: 1, destroy: 3, "external-write": 5, install: 2 } });
  for (const bad of [null, false, [], { enabled: "yes" }, { other: true }, { always_ask: ["publish", "publish"] }, { always_ask: ["read"] }, { always_ask: null }, { budgets: { publish: -1 } }, { budgets: { install: 1.5 } }, { budgets: { destroy: 1001 } }, { budgets: { read: 1 } }]) expect(() => actionPolicyConfig(bad)).toThrow("action_policy");
});

test("action approval copy uses the public task view and whole-command privacy projection", () => {
  const task = { title: "patient 900101-1234567" }; let calls = 0;
  const ports = { publicView: (value: typeof task) => { expect(value).toBe(task); calls++; return { title: "[pii]" }; }, private: true, commandView: () => "secret patient command" };
  const privateText = actionApprovalText(["publish"], "secret raw command", task, ports);
  expect(calls).toBe(1); expect(privateText).toContain("[pii]"); expect(privateText).not.toContain("patient"); expect(privateText).not.toContain("secret");
  expect(actionApprovalText(["install"], "raw", undefined, { ...ports, private: false, commandView: () => undefined })).toContain("[private command withheld]");
});


test("approval copy composes the actual Tasks public view and metadata privacy boundary", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-action-copy-")), board = new Board(join(cwd, "hub.db"));
  try {
    const tasks = new Tasks({ cwd, project: "fixture", board, bus: new Bus({ batchMs: 0 }), routing: () => loadRouting(cwd), notify: () => {} });
    const task = board.propose("user", { title: "private patient details", class: "implement", signals: ["pii"] });
    const command = `gh api -f token=ghp_${"a".repeat(36)}`;
    const text = actionApprovalText(["external-write"], command, task, { publicView: value => tasks.publicView(value), private: tasks.isPii(task), commandView: value => tasks.publicMetadataText(value) ? value : undefined });
    expect(text).toContain("[pii]"); expect(text).not.toContain("patient"); expect(text).not.toContain("ghp_");
  } finally { board.close(); rmSync(cwd, { recursive: true, force: true }); }
});
