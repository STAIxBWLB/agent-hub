import { expect, test } from "bun:test";
import { ActionBudgets, actionPolicyConfig } from "../src/hub/action-policy.ts";
import { actionGate, claudeActionClasses, classifyCall, commandText } from "../src/hub/action-enforce.ts";

const ROOT = "/work/project";
function rig(policy: unknown = undefined, opts: { privateTurn?: boolean; title?: string; screen?: (text: string) => boolean } = {}) {
  let config = actionPolicyConfig(policy), session: string | undefined = "s1";
  const budgets = new ActionBudgets(() => config, () => session);
  const gate = actionGate({ budgets, policy: () => config, root: () => ROOT, task: () => opts.title === undefined ? undefined : { title: opts.title }, publicView: task => ({ title: task.title }),
    isPrivate: () => !!opts.privateTurn, nameable: opts.screen ?? (() => true) }, "worker");
  return { budgets, gate, config: (next: unknown) => { config = actionPolicyConfig(next); }, session: (next: string | undefined) => { session = next; } };
}
const sh = (command: string, extra: object = {}) => ({ names: ["Bash"], input: { command }, ...extra });

test("classifyCall reads a shell call by name or by ACP kind, and unknown shapes are unclassed", () => {
  expect(classifyCall(sh("git push origin main"), ROOT)).toEqual(["publish"]);
  expect(classifyCall({ names: ["run it"], kind: "execute", input: { command: "npm publish" } }, ROOT)).toEqual(["publish"]);
  expect(classifyCall({ names: ["run it"], input: { command: "npm publish" } }, ROOT)).toEqual([]);
  expect(classifyCall(sh("ls -la"), ROOT)).toEqual([]);
  expect(classifyCall({ names: ["Bash"], input: 42 }, ROOT)).toEqual([]);
  expect(classifyCall({ names: [], input: { command: "git push" } }, ROOT)).toEqual([]);
});

test("claudeActionClasses names every classed class in every mode and never relaxes with a budget", () => {
  const budgets = new ActionBudgets(() => actionPolicyConfig(), () => "s1");
  expect(claudeActionClasses(budgets, "Bash", { command: "git push origin main && rm -rf /tmp/x" }, ROOT)).toEqual(["publish", "destroy"]);
  expect(claudeActionClasses(budgets, "Bash", { command: "git push" }, ROOT)).toEqual(["publish"]); // asked again: no ledger is spent
  expect(claudeActionClasses(budgets, "Bash", { command: "ls" }, ROOT)).toEqual([]);
  expect(claudeActionClasses(budgets, "Read", { file_path: "a.ts" }, ROOT)).toEqual([]);
  const narrow = new ActionBudgets(() => actionPolicyConfig({ always_ask: ["destroy"] }), () => "s1");
  expect(claudeActionClasses(narrow, "Bash", { command: "git push" }, ROOT)).toEqual([]);
  const off = new ActionBudgets(() => actionPolicyConfig({ enabled: false }), () => "s1");
  expect(claudeActionClasses(off, "Bash", { command: "git push" }, ROOT)).toEqual([]);
});

test("the ACP gate asks for a classed call with its class in the text, and leaves an unclassed call to the permission mode", () => {
  const r = rig();
  expect(r.gate(sh("make test"), "s1")).toBeUndefined();
  const verdict = r.gate(sh("git push origin main"), "s1");
  expect(verdict?.title).toBe("Action approval (publish): git push origin main");
  expect(verdict?.budget).toBeUndefined(); // publish budget is 1: the ordinary allow is that one call
});

test("a class budget above one offers its own explicit choice; approving it spends the budget, then the call after it asks again", () => {
  const r = rig({ budgets: { destroy: 3 } });
  const first = r.gate(sh("rm -rf /tmp/a"), "s1");
  expect(first?.budget?.label).toBe("destroy x3");
  expect(first!.budget!.approve()).toBe(true); // this call is slot one
  expect(r.gate(sh("rm -rf /tmp/b"), "s1")).toBeUndefined(); // slot two, no ask
  expect(r.gate(sh("rm -rf /tmp/c"), "s1")).toBeUndefined(); // slot three
  expect(r.gate(sh("rm -rf /tmp/d"), "s1")?.title).toContain("destroy"); // spent: asks again
  expect(r.budgets.status("worker", true).remaining.destroy).toBe(0);
});

test("an ordinary allow never grants the budget, and a new session resets it", () => {
  const r = rig({ budgets: { install: 2 } });
  expect(r.gate(sh("npm install -g typescript"), "s1")?.title).toContain("install"); // answered with a plain allow: no approve() call
  expect(r.gate(sh("npm install -g typescript"), "s1")?.title).toContain("install"); // still asks
  const grant = r.gate(sh("npm install -g typescript"), "s1")!.budget!; expect(grant.approve()).toBe(true);
  expect(r.gate(sh("npm install -g typescript"), "s1")).toBeUndefined();
  r.session("s2");
  expect(r.gate(sh("npm install -g typescript"), "s2")?.budget).toBeDefined(); // a new session asks again from zero
});

test("a stale approval (policy changed, session replaced) is refused, so nothing is granted", () => {
  const r = rig({ budgets: { install: 5 } });
  const grant = r.gate(sh("npm install -g typescript"), "s1")!.budget!;
  r.config({ budgets: { install: 6 } });
  expect(grant.approve()).toBe(false);
  const second = r.gate(sh("npm install -g typescript"), "s1")!.budget!;
  r.session("s9");
  expect(second.approve()).toBe(false);
});

test("an unknown session never gets a budget: it asks and offers no budget choice", () => {
  const r = rig({ budgets: { install: 5 } }); r.session(undefined);
  const verdict = r.gate(sh("npm install -g typescript"), "s1");
  expect(verdict?.title).toContain("install"); expect(verdict?.budget).toBeUndefined();
});

test("approval text uses the task's publicView and withholds a private or PII-screened command", () => {
  expect(rig(undefined, { title: "ship the release" }).gate(sh("git push"), "s1")?.title).toBe("Action approval (publish); task ship the release: git push");
  expect(rig(undefined, { privateTurn: true }).gate(sh("git push origin patient-900101-1234567"), "s1")?.title).toBe("Action approval (publish): [private command withheld]");
  const screened = rig(undefined, { screen: text => !text.includes("900101-1234567") });
  const title = screened.gate(sh("git push origin patient-900101-1234567"), "s1")!.title;
  expect(title).toBe("Action approval (publish): [private command withheld]"); expect(title).not.toContain("900101");
  expect(rig(undefined, { title: "\u001b[31mred\u0007 title" }).gate(sh("git push"), "s1")!.title).not.toMatch(/[\u0000-\u001f]/);
});

test("commandText shows the shell command, argv and git argument forms, bounded to what the caller screens", () => {
  expect(commandText({ command: "git push" })).toBe("git push");
  expect(commandText({ cmd: ["git", "push", "--force"] })).toBe("git push --force");
  expect(commandText({ args: ["push", "origin"] })).toBe("git push origin");
  expect(commandText('{"command":"npm publish"}')).toBe("npm publish");
  expect(commandText("npm publish")).toBe("npm publish");
  expect(commandText({ url: "https://x.invalid" })).toBe('{"url":"https://x.invalid"}');
});

test("a recursive delete is classed against the root it is given: the verified write root, not the project checkout (#636 rebase onto #742)", () => {
  const budgets = new ActionBudgets(() => actionPolicyConfig(), () => "s1");
  const call = { command: "rm -rf /work/worktree/build" };
  expect(claudeActionClasses(budgets, "Bash", call, "/work/project")).toEqual(["destroy"]);  // outside the checkout
  expect(claudeActionClasses(budgets, "Bash", call, "/work/worktree")).toEqual([]);          // inside a declared instance's verified worktree
  expect(claudeActionClasses(budgets, "Bash", { command: "rm -rf /work/project/build" }, "/work/worktree")).toEqual(["destroy"]); // and the checkout is outside it
});
