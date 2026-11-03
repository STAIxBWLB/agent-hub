import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { conductorPeer } from "../src/hub/conductor.ts";
import { ownerToolEffect } from "../src/hub/no-writes.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

test("in-process session title JSON and errors are never decorated with a held-delivery hint", async () => {
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("  const conductedMutations ="), end = source.indexOf("  const deliveryRetryAllowed =", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const readOnly = source.split("\n").find(line => line.startsWith("  const readOnlyPeer ="))!;
  const readTools = source.split("\n").find(line => line.startsWith("const READ_ONLY_HUB_TOOLS ="))!;
  expect(readOnly).toBeDefined(); expect(readTools).toBeDefined();
  let result: unknown = { ok: true }, failure: Error | undefined, hintCalls = 0;
  const unexpected = () => { throw new Error("unrelated authority path reached"); };
  const context = {
    Error, PreEffectToolRefusal, conductorPeer, ownerToolEffect,
    declarations: {}, config: { roles: {} }, turns: new Map(), reviewerToolObservers: new Map(),
    sourceReadCurrent: unexpected, runningReviewAuthority: unexpected, auditConduct: unexpected,
    ownHeldHint: () => { hintCalls++; return "Held delivery fixture: inspect the queued request"; },
    taskOpBody: async () => { if (failure) throw failure; return JSON.stringify(result); },
    extracted: undefined as unknown,
  };
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`${readOnly}\n${readTools}\nlet taskOpsInFlight=0;\n${source.slice(start, end)}\nglobalThis.extracted={run:taskOp,pending:()=>taskOpsInFlight};`);
  runInNewContext(script, context);
  const wrapper = context.extracted as { run: (by: string, op: string, args: Record<string, unknown>, inProcess: boolean, piiTurn?: boolean) => Promise<string>; pending: () => number };
  for (const peer of ["local", "pi"]) for (const expected of [{ ok: true }, { ok: false, reason: "already_named" }, { ok: false, reason: "private" }]) {
    result = expected;
    const text = await wrapper.run(peer, "hub_set_title", { title: "Bounded title" }, true, expected.reason === "private");
    expect(text).toBe(JSON.stringify(expected));
    expect(JSON.parse(text)).toEqual(expected);
    expect(wrapper.pending()).toBe(0);
  }
  expect(hintCalls).toBe(0);
  failure = new Error("native title could not be confirmed");
  await expect(wrapper.run("local", "hub_set_title", { title: "Bounded title" }, true)).rejects.toThrow("native title could not be confirmed");
  expect(failure.message).toBe("native title could not be confirmed"); expect(hintCalls).toBe(0); expect(wrapper.pending()).toBe(0);
  failure = undefined;
  const ordinary = await wrapper.run("local", "hub_task_list", {}, true);
  expect(ordinary).toContain("Held delivery fixture"); expect(hintCalls).toBe(1);
});
