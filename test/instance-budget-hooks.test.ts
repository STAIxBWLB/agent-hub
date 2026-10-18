import { expect, test } from "bun:test";
import type { BudgetHooks, Moved, PauseRecord } from "../src/hub/budget.ts";
import { instanceBudgetHooks, projectBudgetHeadroom } from "../src/hub/instance-budget.ts";

const account = (peer: string) => peer === "codex-2" ? "codex" : peer;
const members = (key: string): readonly string[] => key === "codex" ? ["codex", "codex-2", "codex-2"] : [key];
const record = (): PauseRecord => ({ peer: "codex", since: 100, resetsAt: 200, reason: "quota", summary: "checkpoint", handedOff: false, moved: [] });
function base() {
  const events: string[] = [], resumed: PauseRecord[] = [];
  const hooks: BudgetHooks = {
    pause: peer => { events.push(`pause ${peer}`); }, resume: peer => { events.push(`resume ${peer}`); },
    requestCheckpoint: async peer => { events.push(`checkpoint ${peer}`); return `checkpoint ${peer}`; },
    platformContext: async peer => { events.push(`context ${peer}`); return `context ${peer}`; },
    attached: peer => peer === "codex-2", canHandOff: peer => peer === "codex-2",
    handoff: async (peer, context, urgent) => { events.push(`handoff ${peer} ${context} ${urgent}`); return [{ id: peer === "codex" ? 1 : 2, title: peer, role: "owner", to: "kimi" }]; },
    resumed: row => { resumed.push(row); events.push(`notice ${row.peer}`); },
    notify: text => { events.push(`notify ${text}`); }, reading: (peer, _windows, hard, at) => { events.push(`reading ${peer} ${hard} ${at}`); },
  };
  return { hooks, events, resumed };
}

test("instance budget hooks retain singleton call/return values without attribution or record changes", async () => {
  const b = base(), hooks = instanceBudgetHooks(b.hooks, key => [key], peer => peer);
  expect(await hooks.requestCheckpoint("codex")).toBe("checkpoint codex");
  expect(await hooks.platformContext("codex")).toBe("context codex");
  const row = record(); hooks.resumed(row);
  expect(b.resumed[0]).toBe(row);
  expect(hooks.attached("codex")).toBe(false); expect(hooks.canHandOff("codex")).toBe(false);
  expect(await hooks.handoff("codex", "plain context", true)).toEqual([{ id: 1, title: "codex", role: "owner", to: "kimi" }]);
  expect(b.events).toEqual(["checkpoint codex", "context codex", "notice codex", "handoff codex plain context true"]);
});

test("instance budget pause/resume fanout deduplicates members and retains reporter telemetry identity", () => {
  const b = base(), hooks = instanceBudgetHooks(b.hooks, members, account);
  hooks.pause("codex"); hooks.resume("codex");
  hooks.reading?.("codex-2", [], true, 123); hooks.notify("quota status");
  expect(b.events).toEqual(["pause codex", "pause codex-2", "resume codex", "resume codex-2", "reading codex-2 true 123", "notify quota status"]);
  expect(hooks.account?.("codex-2")).toBe("codex");
  expect(hooks.attached("codex")).toBe(true); expect(hooks.canHandOff("codex")).toBe(true);
});

test("instance budget checkpoint/context aggregate available summaries with member attribution", async () => {
  const b = base(), hooks = instanceBudgetHooks(b.hooks, members, account);
  expect(await hooks.requestCheckpoint("codex")).toBe("[codex]\ncheckpoint codex\n\n[codex-2]\ncheckpoint codex-2");
  b.hooks.platformContext = async peer => peer === "codex" ? undefined : "second owner context";
  expect(await hooks.platformContext("codex")).toBe("[codex-2]\nsecond owner context");
  b.hooks.requestCheckpoint = async peer => { if (peer === "codex") throw new Error("unavailable"); return "surviving checkpoint"; };
  expect(await hooks.requestCheckpoint("codex")).toBe("[codex-2]\nsurviving checkpoint");
  b.hooks.platformContext = async () => undefined;
  expect(await hooks.platformContext("codex")).toBeUndefined();
});

test("instance budget handoff merges all member moves and resumed rewrites only recipient identity", async () => {
  const b = base(), hooks = instanceBudgetHooks(b.hooks, members, account);
  const moved = await hooks.handoff("codex", "both checkpoints", false);
  expect(moved).toEqual([{ id: 1, title: "codex", role: "owner", to: "kimi" }, { id: 2, title: "codex-2", role: "owner", to: "kimi" }]);
  const original = { ...record(), moved };
  hooks.resumed(original);
  expect(b.resumed).toEqual([{ ...original, peer: "codex" }, { ...original, peer: "codex-2" }]);
  expect(original.peer).toBe("codex");
  expect(b.events).toEqual(["handoff codex both checkpoints false", "handoff codex-2 both checkpoints false", "notice codex", "notice codex-2"]);
});

test("instance budget failed handoff retains earlier successful moves for the core's retry", async () => {
  const b = base(); let retry = false;
  const first: Moved = { id: 1, title: "already moved", role: "owner", to: "kimi" }, second: Moved = { id: 2, title: "later moved", role: "reviewer", to: "claude" };
  b.hooks.handoff = async peer => {
    if (peer === "codex") return retry ? [] : [first];
    if (!retry) throw new Error("second member unavailable");
    return [second];
  };
  const hooks = instanceBudgetHooks(b.hooks, members, account);
  await expect(hooks.handoff("codex", undefined, false)).rejects.toThrow("second member unavailable");
  retry = true;
  expect(await hooks.handoff("codex", undefined, false)).toEqual([first, second]);
});

test("instance budget override after a partial handoff still carries its successful moves in resume notices", async () => {
  const b = base(), moved: Moved = { id: 1, title: "moved before override", role: "owner", to: "kimi" };
  b.hooks.handoff = async peer => { if (peer === "codex") return [moved]; throw new Error("interrupted"); };
  const hooks = instanceBudgetHooks(b.hooks, members, account);
  await expect(hooks.handoff("codex", undefined, false)).rejects.toThrow("interrupted");
  hooks.resumed(record());
  expect(b.resumed.map(row => row.moved)).toEqual([[moved], [moved]]);
  hooks.resumed(record());
  expect(b.resumed.slice(2).map(row => row.moved)).toEqual([[], []]);
});

test("instance budget headroom projects one canonical window to explicit members, leaving unknown ids usable", () => {
  const shared = { headroom: 0.3, resetsAt: 200 }, external = { headroom: 0.6 };
  const source = { codex: shared, external };
  expect(projectBudgetHeadroom(source, members)).toEqual({ codex: shared, "codex-2": shared, external });
  expect(source).toEqual({ codex: shared, external });
  expect(projectBudgetHeadroom({ external }, () => [])).toEqual({ external });
  expect(projectBudgetHeadroom(source, key => [key])).toEqual(source);
});
