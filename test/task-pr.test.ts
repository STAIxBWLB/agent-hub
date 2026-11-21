import { expect, test } from "bun:test";
import { managedTaskPullRequest } from "../src/hub/task-pr.ts";
import type { SdlcGh } from "../src/hub/sdlc.ts";

const input = () => ({ repo: "example/repo", branch: "task/12-pi", commit: "a".repeat(40), task: 12, issue: 7, current: () => {} });
function fake(initial: "missing" | "draft" | "ready" = "missing") {
  const calls: string[][] = []; let state = initial;
  const run: SdlcGh = async args => {
    calls.push(args);
    if (args[0] === "api") return { code: 0, stdout: "main\n" };
    if (args[1] === "create") { state = "draft"; return { code: 0, stdout: "" }; }
    if (args[1] === "ready") { state = "ready"; return { code: 0, stdout: "" }; }
    const row = { number: 32, state: "OPEN", headRefName: "task/12-pi", headRefOid: "a".repeat(40), isDraft: state === "draft", isCrossRepository: false, headRepository: { nameWithOwner: "example/repo" } };
    return { code: 0, stdout: JSON.stringify(state === "missing" ? [] : [row]) };
  };
  return { run, calls };
}

test("creates a draft and verifies the ready PR for the exact pushed head", async () => {
  const f = fake(); expect(await managedTaskPullRequest(input(), f.run)).toBe(32);
  const create = f.calls.find(args => args[1] === "create")!;
  expect(create).toContain("--draft"); expect(create).toContain("github.com/example/repo"); expect(create[create.indexOf("--body") + 1]).toBe("hub task 12\n\nRefs #7");
  expect(f.calls.filter(args => args[1] === "ready")).toHaveLength(1);
  expect(f.calls.filter(args => args[1] === "list")).toHaveLength(3);
});

test("reuses existing PRs and refuses stale or ambiguous evidence", async () => {
  const ready = fake("ready"); expect(await managedTaskPullRequest(input(), ready.run)).toBe(32); expect(ready.calls).toHaveLength(1);
  const draft = fake("draft"); expect(await managedTaskPullRequest(input(), draft.run)).toBe(32); expect(draft.calls.some(args => args[1] === "create")).toBe(false);
  const bad: SdlcGh = async () => ({ code: 0, stdout: JSON.stringify([{ number: 32, state: "OPEN", headRefName: "task/12-pi", headRefOid: "b".repeat(40), isDraft: false, isCrossRepository: false, headRepository: { nameWithOwner: "example/repo" } }]) });
  await expect(managedTaskPullRequest(input(), bad)).rejects.toThrow("identity or head");
  const failed: SdlcGh = async () => ({ code: 1, stdout: "" });
  await expect(managedTaskPullRequest(input(), failed)).rejects.toThrow("lookup unavailable");
});

test("rechecks authority after a GitHub read and does not create on revocation", async () => {
  let valid = true; const calls: string[][] = [];
  const run: SdlcGh = async args => { calls.push(args); valid = false; return { code: 0, stdout: "[]" }; };
  await expect(managedTaskPullRequest({ ...input(), current: () => { if (!valid) throw new Error("revoked"); } }, run)).rejects.toThrow("revoked");
  expect(calls).toHaveLength(1);
});

test("unknown lookup and an unconfirmed creation never become a guessed PR", async () => {
  const args: string[][] = [];
  const ambiguous: SdlcGh = async call => { args.push(call); return { code: 0, stdout: JSON.stringify(Array.from({ length: 100 }, () => ({}))) }; };
  await expect(managedTaskPullRequest(input(), ambiguous)).rejects.toThrow("lookup incomplete"); expect(args).toHaveLength(1);
  const calls: string[][] = [];
  const lost: SdlcGh = async call => { calls.push(call); return call[0] === "api" ? { code: 0, stdout: "main" } : call[1] === "create" ? { code: 1, stdout: "" } : { code: 0, stdout: "[]" }; };
  await expect(managedTaskPullRequest(input(), lost)).rejects.toThrow("creation was not confirmed");
  expect(calls.filter(call => call[1] === "create")).toHaveLength(1);
  await expect(managedTaskPullRequest({ ...input(), repo: "github.com/other/project" }, lost)).rejects.toThrow("identity is invalid");
});

test("a lost creation reply is recovered by lookup on the next attempt", async () => {
  let exists = false, draft = true, creates = 0;
  const run: SdlcGh = async args => {
    if (args[0] === "api") return { code: 0, stdout: "main" };
    if (args[1] === "create") { creates++; exists = true; return { code: 1, stdout: "" }; }
    if (args[1] === "ready") { draft = false; return { code: 0, stdout: "" }; }
    return { code: 0, stdout: JSON.stringify(exists ? [{ number: 32, state: "OPEN", headRefName: "task/12-pi", headRefOid: "a".repeat(40), isDraft: draft, isCrossRepository: false, headRepository: { nameWithOwner: "example/repo" } }] : []) };
  };
  await expect(managedTaskPullRequest(input(), run)).rejects.toThrow("creation was not confirmed");
  expect(await managedTaskPullRequest(input(), run)).toBe(32); expect(creates).toBe(1);
});
