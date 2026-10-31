import { expect, test } from "bun:test";
import { classifyAction, type ActionClass, type FloorFacts } from "../src/hub/action-class.ts";
import { actionGate, claudeActionClasses } from "../src/hub/action-enforce.ts";
import { ActionBudgets, actionPolicyConfig, FLOOR_GUARDS } from "../src/hub/action-policy.ts";
import { validateRawConfig } from "../src/hub/config-apply.ts";

// #999 T3: with the floor on, an ordinary branch push and an own-repository pull request run without a prompt, and everything release-grade still asks.
// Facts are injected here; the daemon reads them from git and the authoritative remote (see test/daemon-action-floor.test.ts).
const root = "/work/project";
const facts = (over: Partial<FloorFacts> = {}): FloorFacts => ({
  defaultBranch: "main", repository: "acme/app",
  refIsTag: name => /^v\d/.test(name) || name === "release",   // a local tag named v1, v1.2.3 or release
  currentBranch: () => "feat/x",
  inOwnRepository: () => true,
  ...over,
});
const NO_FLOOR = Symbol("no floor");
const classes = (command: string, floor: FloorFacts | typeof NO_FLOOR = facts()): ActionClass[] => classifyAction("bash", { command }, root, floor === NO_FLOOR ? undefined : floor);

const RUNS_WITHOUT_ASKING: string[] = [
  // push of a non-default branch
  "git push origin feat/x", "git push -u origin feat/x", "git push --set-upstream origin feat/x", "git push origin HEAD", "git push origin feat/x:feat/x",
  "git push origin refs/heads/feat/x", "git push origin feat/x refs/heads/feat/y", "git -C sub push origin feat/x", "git --no-pager push origin feat/x", "git push -q origin feat/x",
  "git push --dry-run origin feat/x",
  // gh pr in the project's own repository
  "gh pr create --title 'a' --body 'b'", "gh pr create --base main --head feat/x --title a --body b", "gh pr comment 3 --body hi", "gh pr review 3 --approve",
  "gh pr merge 3 --squash --match-head-commit abc", "gh pr merge 3 --squash --delete-branch", "gh pr create --repo acme/app --title a", "gh pr comment 3 -R acme/app --body x",
  "gh pr review --repo=acme/app 3 --comment --body x", "gh pr comment https://github.com/acme/app/pull/3 --body x",
  // chained ordinary work stays ordinary
  "git add -A && git commit -m work && git push origin feat/x",
];
const STILL_ASKS: Array<[string, ActionClass]> = [
  // any force push
  ["git push --force origin feat/x", "publish"], ["git push -f origin feat/x", "publish"], ["git push origin +feat/x", "publish"], ["git push origin +feat/x:feat/x", "publish"],
  ["git push --force-with-lease origin feat/x", "publish"], ["git push --force-with-lease=feat/x origin feat/x", "publish"], ["git push -fu origin feat/x", "publish"],
  ["git push --force-if-includes origin feat/x", "publish"],
  // the default branch, however it is named
  ["git push origin main", "publish"], ["git push origin master", "publish"], ["git push origin MAIN", "publish"], ["git push origin refs/heads/main", "publish"],
  ["git push origin feat/x:main", "publish"], ["git push origin HEAD:main", "publish"], ["git push origin HEAD:refs/heads/main", "publish"], ["git push origin heads/main", "publish"],
  // tags and other ref types
  ["git push origin v1", "publish"], ["git push origin v1.2.3", "publish"], ["git push origin refs/tags/v1", "publish"], ["git push --tags origin feat/x", "publish"],
  ["git push --follow-tags origin feat/x", "publish"], ["git push origin tags/v1", "publish"], ["git push origin feat/x:refs/tags/v2", "publish"], ["git push origin release", "publish"],
  ["git push origin refs/notes/commits", "publish"], ["git push origin refs/pull/1/head", "publish"],
  // deletion, mirror, prune, bypass and hooks
  ["git push origin :feat/x", "publish"], ["git push --delete origin feat/x", "publish"], ["git push -d origin feat/x", "publish"], ["git push --mirror origin", "publish"], ["git push --all origin", "publish"],
  ["git push --prune origin feat/x", "publish"], ["git push --no-verify origin feat/x", "publish"], ["git push -o ci.skip origin feat/x", "publish"], ["git push --receive-pack=x origin feat/x", "publish"],
  // what git would pick by itself, or a remote the project does not own
  ["git push", "publish"], ["git push origin", "publish"], ["git push upstream feat/x", "publish"], ["git push https://example.com/x.git feat/x", "publish"], ["git push --repo=elsewhere feat/x", "publish"],
  ["git -c remote.origin.url=https://example.com/x.git push origin feat/x", "publish"], ["git --git-dir=/elsewhere/.git push origin feat/x", "publish"], ["git -C /elsewhere push origin feat/x", "publish"],
  ["git --work-tree=/elsewhere push origin feat/x", "publish"], ["git --git-dir /elsewhere/.git push origin feat/x", "publish"], ["git push -o ci.skip origin feat/x", "publish"], ["git --namespace=x push origin feat/x", "publish"],
  // a wrapper the floor cannot read, and a directory it cannot place
  ["env GIT_SSH_COMMAND=x git push origin feat/x", "publish"], ["GIT_SSH_COMMAND=x git push origin feat/x", "publish"], ["sudo git push origin feat/x", "publish"], ["timeout 5 git push origin feat/x", "publish"],
  ["xargs git push origin feat/x", "publish"], ["cd /tmp && git push origin feat/x", "publish"], ["cd .. && git push origin feat/x", "publish"], ["cd ~ && git push origin feat/x", "publish"],
  // package and release publishing
  ["npm publish", "publish"], ["bun publish", "publish"], ["cargo publish", "publish"], ["pnpm publish", "publish"], ["yarn npm publish", "publish"],
  ["gh release create v1", "publish"], ["gh release upload v1 file", "publish"], ["gh release edit v1", "publish"], ["gh release delete v1", "publish"],
  // pull requests outside the floor
  ["gh pr merge 3 --admin", "external-write"], ["gh pr merge 3 --squash --admin", "external-write"], ["gh pr create --repo other/app --title a", "external-write"], ["gh pr create -R other/app", "external-write"],
  ["gh pr create --repo=other/app", "external-write"], ["gh pr comment https://github.com/other/app/pull/3 --body x", "external-write"], ["gh pr comment https://example.com/acme/app/pull/3 --body x", "external-write"],
  ["gh pr close 3", "external-write"], ["gh pr edit 3 --title x", "external-write"], ["gh pr reopen 3", "external-write"], ["gh pr delete 3", "external-write"],
  ["gh issue create --title a", "external-write"], ["gh issue comment 3 --body x", "external-write"], ["gh gist create f", "external-write"],
  ["gh api -X POST repos/acme/app/issues", "external-write"], ["gh repo delete acme/app", "external-write"], ["gh workflow run x", "external-write"],
  // deletion outside the root, other writes, mail and posting
  ["rm -rf ../archive", "destroy"], ["rm -rf /tmp/x", "destroy"], ["git reset --hard HEAD~1", "destroy"], ["git clean -fdx", "destroy"], ["git branch -D feat/x", "destroy"],
  ["printf x > ../out", "destroy"], ["cp -f a ../b", "destroy"],
  ["mail -s hi someone@example.com", "external-write"], ["sendmail someone@example.com", "external-write"], ["slack send hi", "external-write"], ["telegram post hi", "external-write"],
  ["curl -X POST https://example.com/hook", "external-write"], ["gh api graphql -f query='mutation { x }'", "external-write"],
];
// The classifier cannot decide these, so they keep the strictest class they might reach (#762, #756).
const OPAQUE: Array<[string, ActionClass[]]> = [
  ["git push origin $BRANCH", ["publish"]], ["git push origin feat/$N", ["publish"]], ["git push $REMOTE feat/x", ["publish"]], ["git push $FLAGS origin feat/x", ["publish"]],
  ["git push origin $(git branch --show-current)", ["publish"]], ["git push origin `git branch --show-current`", ["publish"]], ["git $CMD origin feat/x", ["publish", "destroy"]],
  ["git -C $DIR push origin feat/x", ["publish"]], ["cd $DIR && git push origin feat/x", ["publish"]], ["sh -c 'git push origin $B'", ["publish"]], ["bash -c \"git push origin $B\"", ["publish"]],
  ["gh pr create --repo $R --title a", ["external-write"]], ["gh pr comment $URL --body x", ["external-write"]], ["gh $GROUP create", ["publish", "external-write"]], ["gh pr $ACTION 3", ["external-write"]],
  ["gh pr merge 3 $FLAGS", ["external-write"]],
];

test("the floor lets an ordinary branch push and an own-repository pull request run without asking", () => {
  for (const command of RUNS_WITHOUT_ASKING) expect(classes(command), command).toEqual([]);
});

test("every release-grade, destructive, foreign and unreadable case still asks, with its class", () => {
  for (const [command, expected] of STILL_ASKS) expect(classes(command), command).toContain(expected);
});

test("a command the classifier cannot decide keeps the strictest class it might reach", () => {
  for (const [command, expected] of OPAQUE) expect(classes(command), command).toEqual(expect.arrayContaining(expected));
});

test("without the floor every case is exactly what it was: the shipped classifier is unchanged", () => {
  for (const command of RUNS_WITHOUT_ASKING) {
    const before = classes(command, NO_FLOOR);
    expect(before.length, command).toBeGreaterThan(0);
    expect(before, command).toEqual(classifyAction("bash", { command }, root));
  }
  for (const [command, expected] of STILL_ASKS) expect(classes(command, NO_FLOOR), command).toContain(expected);
  // the table of the existing classifier test stays valid with a floor that knows nothing
  expect(classes("git push origin feat/x", {})).toEqual(["publish"]);
  expect(classes("gh pr create --title a", {})).toEqual(["external-write"]);
});

test("a floor fact that is missing or unproven keeps the call asking", () => {
  const push = "git push origin feat/x", pr = "gh pr comment 3 --body x";
  expect(classes(push, facts({ defaultBranch: undefined }))).toEqual(["publish"]);                  // the default branch is unknown: even a feature branch may be it
  expect(classes(push, facts({ inOwnRepository: () => undefined }))).toEqual(["publish"]);          // not proven to be the project's checkout
  expect(classes(push, facts({ inOwnRepository: () => false }))).toEqual(["publish"]);              // a nested clone has another origin
  expect(classes(push, facts({ inOwnRepository: undefined }))).toEqual(["publish"]);
  expect(classes(push, facts({ refIsTag: () => undefined }))).toEqual(["publish"]);                 // git could not say whether feat/x is also a tag
  expect(classes(push, facts({ refIsTag: () => true }))).toEqual(["publish"]);
  expect(classes(push, facts({ refIsTag: undefined }))).toEqual(["publish"]);
  expect(classes("git push origin HEAD", facts({ currentBranch: () => undefined }))).toEqual(["publish"]);   // detached or unreadable HEAD
  expect(classes("git push origin HEAD", facts({ currentBranch: () => "main" }))).toEqual(["publish"]);      // HEAD is the default branch
  // Verified with real git: from a branch named v1.0.0, `git push origin HEAD` pushes refs/heads/v1.0.0, a branch. A version-shaped branch name is a branch.
  expect(classes("git push origin HEAD", facts({ currentBranch: () => "v1.0.0" }))).toEqual([]);
  expect(classes(pr, facts({ repository: undefined }))).toEqual(["external-write"]);                // the project's own repository is unknown
  expect(classes(pr, facts({ inOwnRepository: () => undefined }))).toEqual(["external-write"]);
  expect(classes("gh pr comment 3 --repo acme/app --body x", facts({ repository: undefined }))).toEqual(["external-write"]);
});

test("the default branch is also whatever the remote names it, not only main and master", () => {
  const floor = facts({ defaultBranch: "trunk" });
  expect(classes("git push origin trunk", floor)).toEqual(["publish"]);
  expect(classes("git push origin TRUNK", floor)).toEqual(["publish"]);
  expect(classes("git push origin feat/x", floor)).toEqual([]);
  expect(classes("git push origin main", floor)).toEqual(["publish"]);        // main and master stay protected even when the remote uses another name
});

test("-C moves the directory the facts are read from", () => {
  const seen: string[] = [];
  const floor = facts({ inOwnRepository: cwd => { seen.push(cwd); return cwd === root || cwd === `${root}/sub`; } });
  expect(classes("git -C sub push origin feat/x", floor)).toEqual([]);
  expect(seen).toContain(`${root}/sub`);
  expect(classes("git -C other push origin feat/x", floor)).toEqual(["publish"]);   // a directory the facts do not prove is a different repository
});

test("a git tool call and an argv command are judged like the shell form", () => {
  expect(classifyAction("git", { args: ["push", "origin", "feat/x"] }, root, facts())).toEqual([]);
  expect(classifyAction("git", { args: ["push", "--force", "origin", "feat/x"] }, root, facts())).toEqual(["publish"]);
  expect(classifyAction("bash", { command: ["gh", "pr", "create", "--title", "a"] }, root, facts())).toEqual([]);
  expect(classifyAction("bash", { command: ["gh", "pr", "merge", "3", "--admin"] }, root, facts())).toEqual(["external-write"]);
  expect(classifyAction("bash", { command: "git push origin feat/x", cwd: "/elsewhere" }, root, facts())).toEqual(["publish"]);   // a model-supplied cwd outside the root
});

test("action_policy accepts floor as a boolean, rejects anything else, and omits it by default", () => {
  expect(actionPolicyConfig()).toEqual({ enabled: true, always_ask: ["publish", "external-write", "destroy", "install"], budgets: { publish: 1, destroy: 3, "external-write": 5, install: 2 } });
  expect("floor" in actionPolicyConfig()).toBe(false);
  expect("floor" in actionPolicyConfig({ floor: false })).toBe(false);
  expect(actionPolicyConfig({ floor: true }).floor).toBe(true);
  expect(actionPolicyConfig({ floor: true, enabled: false })).toMatchObject({ enabled: false, floor: true });
  for (const bad of [{ floor: "yes" }, { floor: 1 }, { floor: null }, { floor: [] }, { floors: true }]) expect(() => actionPolicyConfig(bad), JSON.stringify(bad)).toThrow();
  expect(() => validateRawConfig({ action_policy: { floor: true } }, {})).not.toThrow();
  expect(() => validateRawConfig({ action_policy: { floor: "yes" } }, {})).toThrow();
});

function gateRig(policy: unknown, floor: FloorFacts | undefined) {
  const config = actionPolicyConfig(policy);
  const budgets = new ActionBudgets(() => config, () => "s1");
  const gate = actionGate({ budgets, policy: () => config, root: () => root, floor: () => floor, task: () => undefined, publicView: () => ({}), isPrivate: () => false, nameable: () => true }, "worker");
  return { budgets, gate };
}
const call = (command: string) => ({ names: ["bash"], input: { command } });

test("the hub gate lets a floor-allowed call through without spending a class budget, and asks for the rest", () => {
  const on = gateRig({ floor: true }, facts());
  expect(on.gate(call("git push origin feat/x"), "s1")).toBeUndefined();
  expect(on.gate(call("gh pr create --title a --body b"), "s1")).toBeUndefined();
  expect(on.budgets.status("worker", true).remaining).toEqual({ publish: 0, destroy: 0, "external-write": 0, install: 0 });
  expect(on.gate(call("git push --force origin feat/x"), "s1")?.title).toContain("Action approval (publish)");
  expect(on.gate(call("git push origin main"), "s1")?.title).toContain("Action approval (publish)");
  expect(on.gate(call("gh release create v1"), "s1")?.title).toContain("Action approval (publish)");
  expect(on.gate(call("gh pr merge 3 --admin"), "s1")?.title).toContain("Action approval (external-write)");
  expect(on.gate(call("npm publish"), "s1")?.title).toContain("Action approval (publish)");
  // the floor off, or its facts unavailable: every one asks, as before
  for (const rig of [gateRig({ floor: true }, undefined), gateRig(undefined, facts()), gateRig({ floor: false }, facts())]) {
    expect(rig.gate(call("git push origin feat/x"), "s1")?.title).toContain("Action approval (publish)");
    expect(rig.gate(call("gh pr comment 3 --body x"), "s1")?.title).toContain("Action approval (external-write)");
  }
});

test("a floor policy that is disabled, or that omits a class from always_ask, never widens beyond what the policy already allowed", () => {
  const disabled = gateRig({ floor: true, enabled: false }, facts());
  expect(disabled.gate(call("git push --force origin main"), "s1")).toBeUndefined();     // a disabled policy asks nothing, as before
  const narrow = gateRig({ floor: true, always_ask: ["destroy"] }, facts());
  expect(narrow.gate(call("git push --force origin main"), "s1")).toBeUndefined();       // publish is not in always_ask: unchanged by the floor
  expect(narrow.gate(call("rm -rf ../x"), "s1")?.title).toContain("Action approval (destroy)");
});

test("the Claude hook names no class for a floor-allowed call and still names the rest", () => {
  const budgets = new ActionBudgets(() => actionPolicyConfig({ floor: true }), () => "s1");
  expect(claudeActionClasses(budgets, "Bash", { command: "git push origin feat/x" }, root, facts())).toEqual([]);
  expect(claudeActionClasses(budgets, "Bash", { command: "gh pr merge 3 --squash" }, root, facts())).toEqual([]);
  expect(claudeActionClasses(budgets, "Bash", { command: "git push --force origin feat/x" }, root, facts())).toEqual(["publish"]);
  expect(claudeActionClasses(budgets, "Bash", { command: "git push origin main" }, root, facts())).toEqual(["publish"]);
  expect(claudeActionClasses(budgets, "Bash", { command: "gh release create v1" }, root, facts())).toEqual(["publish"]);
  expect(claudeActionClasses(budgets, "Bash", { command: "git push origin feat/x" }, root)).toEqual(["publish"]);   // no facts: unchanged
});

test("status says where the floor rests on a structural guard when the hub cannot see the call first", () => {
  const withFloor = new ActionBudgets(() => actionPolicyConfig({ floor: true }), () => "s1");
  // Codex in never-ask, Kimi in auto and Jcode: not enforceable, so the floor rests on guards outside the hub.
  for (const reason of ["Codex approval RPCs are gated, but native policy can execute without sending one (never-ask sends approvalPolicy never)",
    "its native mode never-ask sends no request for a call it allows", "this adapter has no hub pre-tool approval path"]) {
    const row = withFloor.status("peer", false, reason);
    expect(row.enforceable).toBe(false);
    expect(row.floor).toBe(true);
    expect(row.floorGuards).toEqual(FLOOR_GUARDS.map(entry => ({ ...entry })));
    expect(row.note).toContain(`always-ask not enforceable: ${reason}`);
    expect(row.note).toContain("GitHub branch protection on the default branch");
    expect(row.note).toContain("ahub sdlc authorize-release and the OIDC tag workflow");
    expect(row.note).toContain("native sandbox");
    expect(row.note).toContain("the hub has not verified");
  }
  const seen = withFloor.status("claude", true);
  expect(seen.note).toContain("always-ask active");
  expect(seen.note).toContain("floor on: ordinary branch pushes and own-repository pull requests do not ask");
  expect("floorGuards" in seen).toBe(false);                                               // the hub enforces it itself: no guard to name
  expect(seen.note).toContain("attention: machine-local policy weakens defaults");          // the floor is a weakening and says so
});

test("without the floor status rows are exactly what they were", () => {
  const plain = new ActionBudgets(() => actionPolicyConfig(), () => "s1");
  const row = plain.status("peer", false, "this adapter has no hub pre-tool approval path");
  expect(row.note).toBe("always-ask not enforceable: this adapter has no hub pre-tool approval path");
  expect("floor" in row).toBe(false);
  expect("floorGuards" in row).toBe(false);
  expect(plain.status("peer", true).note).toBe("always-ask active");
  const off = new ActionBudgets(() => actionPolicyConfig({ floor: true, enabled: false }), () => "s1").status("peer", false, "x");
  expect(off.note).not.toContain("floor on");                                              // a disabled policy has no floor to rest on
});
