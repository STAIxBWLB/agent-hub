import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { collectRefusals, inspectContinuations } from "../scripts/lib/refusal-check.ts";

test("records refusal carriers, preserving separate static template fragments", () => {
  const source = [
    "// new PreEffectToolRefusal('not a site')",
    'throw new PreEffectToolRefusal(`task ${id} is held. Run ahub task show ${id}`);',
    "throw new HandoffRefusal('invalid', cause);",
    "fail(message, false, undefined, 'ahub status');",
    "obj.fail('not a site');",
  ].join("\n");
  const sites = collectRefusals("src/cli/main.ts", source);
  expect(sites.map(({ line, carrier }) => [line, carrier])).toEqual([
    [2, "PreEffectToolRefusal"], [3, "HandoffRefusal"], [4, "fail"],
  ]);
  expect(sites[0]?.message).toEqual({ fragments: ["task ", " is held. Run ahub task show ", ""], dynamic: true });
  expect(sites[1]?.message).toEqual({ fragments: [], dynamic: true });
  expect(sites[2]?.next).toEqual({ fragments: ["ahub status"], dynamic: false });
  expect(collectRefusals("src/cli/room.ts", source)).toHaveLength(2);
});

test("the report-only command counts every carrier without applying the ratchet", () => {
  const script = fileURLToPath(new URL("../scripts/refusal-inventory.ts", import.meta.url));
  const result = Bun.spawnSync([process.execPath, script]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  for (const carrier of ["fail", "HandoffRefusal", "PreEffectToolRefusal"]) {
    expect(result.stdout.toString()).toMatch(new RegExp(carrier + ": [1-9][0-9]* sites, [0-9]+ fully dynamic"));
  }
});

test("the continuation check catches unknown commands, tools and flags", () => {
  const commandFlags = new Map([["status", new Set(["--json"])]]);
  const tools = new Set(["hub_task_show"]);
  expect(inspectContinuations(["run ahub status --json or use hub_task_show"], { commandFlags, tools })).toEqual({ found: true, errors: [] });
  expect(inspectContinuations(["run ahub status --made-up"], { commandFlags, tools }).errors).toEqual(["unknown flag --made-up for ahub status"]);
  expect(inspectContinuations(["run ahub ghost or use hub_ghost"], { commandFlags, tools }).errors).toEqual(["unknown tool hub_ghost", "unknown command ahub ghost"]);
});

test("the committed refusal baseline passes on the checked-out source", () => {
  const script = fileURLToPath(new URL("../scripts/refusal-inventory.ts", import.meta.url));
  const result = Bun.spawnSync([process.execPath, script, "--check"]);
  if (result.exitCode !== 0) console.error(result.stderr.toString().trimEnd());
  expect(result.exitCode).toBe(0);
});
