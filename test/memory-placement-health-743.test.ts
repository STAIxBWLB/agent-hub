import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { initialMemorySyncState, memorySyncPlacementCounts, memorySyncView, reduceMemorySync } from "../src/hub/memory-sync-state.ts";
import { memorySyncLine } from "../src/cli/status-lines.ts";
import { renderStatus } from "../src/cli/output.ts";

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
const start = html.indexOf("function memorySyncLine(sync) {"), end = html.indexOf("function renderMemory(", start);
const time = html.split("\n").find(line => line.startsWith("const time ="));
if (start < 0 || end <= start || !time) throw new Error("bind the production memory sync UI closure");
const uiMemorySyncLine = runInNewContext(`${time}\n${html.slice(start, end)}\nmemorySyncLine`) as (value: unknown) => string;
const text = (rows: ReturnType<typeof renderStatus>) => rows.map(row => row.map(span => span.text).join("")).join("\n");

test("placement metadata projects only a successful publication's public count pair (#1173)", () => {
  for (const outcome of ["committed", "not-needed"]) {
    const counts = memorySyncPlacementCounts({ outcome, withheld: 2, exported: 7, attemptHash: "PRIVATE-PLACEMENT-HASH-743", lastPolicyHash: "PRIVATE-POLICY-HASH-743", text: "PRIVATE-ROW-TEXT-743" });
    expect(counts).toEqual({ withheldCount: 2, exportedCount: 7 });
    expect(JSON.stringify(counts)).not.toContain("PRIVATE");
  }
  expect(memorySyncPlacementCounts({ outcome: "committed", withheld: 0, exported: 0 })).toEqual({ withheldCount: 0, exportedCount: 0 });
  expect(memorySyncPlacementCounts({ outcome: "unknown", withheld: 2, exported: 7 })).toBeUndefined();
});

test("unavailable, partial and malformed placement counts never become a zero claim (#1173)", () => {
  for (const value of [undefined, null, [], {}, { outcome: "committed", withheld: 2 }, { outcome: "committed", withheld: 2, exported: "7" }, { outcome: "committed", withheld: -1, exported: 7 }, { outcome: "committed", withheld: NaN, exported: 7 }, { outcome: "committed", withheld: 1.5, exported: 7 }, { outcome: "committed", withheld: 2, exported: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(memorySyncPlacementCounts(value)).toBeUndefined();
  }
  let reads = 0;
  const getter = { outcome: "committed", exported: 7, get withheld() { reads++; throw new Error("PRIVATE-GETTER-743"); } };
  expect(memorySyncPlacementCounts(getter)).toBeUndefined();
  expect(reads).toBe(0);
});

test("successful placement counts reach status while existing success and failure episodes stay compatible (#1173)", () => {
  const failure = { type: "failure" as const, at: 1, cause: "declined" as const, declinedCount: 2, declinedIdsFingerprint: "full-declined-set" };
  const first = reduceMemorySync(initialMemorySyncState(), failure);
  expect(first.logFailure).toBe(true);
  const legacy = reduceMemorySync(first.state, { ...failure, at: 2, placementActive: false });
  expect(legacy.logFailure).toBe(false);
  expect(legacy.state.failureSignature).toBe(first.state.failureSignature);
  expect(memorySyncView(legacy.state, "enabled")).toMatchObject({ state: "failed", cause: "declined", declinedCount: 2, placementActive: false });
  const success = reduceMemorySync(legacy.state, { type: "success", at: 3, withheldCount: 2, exportedCount: 7 });
  expect(success.logFailure).toBe(false);
  expect(success.state).not.toHaveProperty("failureSignature");
  expect(memorySyncView(success.state, "enabled")).toEqual({ state: "ok", at: 3, withheldCount: 2, exportedCount: 7 });
  expect(memorySyncView(success.state, "disabled")).toEqual({ state: "disabled" });
  const transport = reduceMemorySync(success.state, { type: "failure", at: 4, cause: "transport", placementActive: false });
  expect(memorySyncView(transport.state, "enabled")).not.toHaveProperty("placementActive");
  expect(reduceMemorySync(success.state, { ...failure, at: 4 }).logFailure).toBe(true);
  expect(memorySyncView(reduceMemorySync(success.state, { type: "success", at: 5 }).state, "enabled")).toEqual({ state: "ok", at: 5 });
  expect(memorySyncView(reduceMemorySync(success.state, { type: "success", at: 6, withheldCount: 2 }).state, "enabled")).toEqual({ state: "ok", at: 6 });
});

test("CLI and dashboard show ok with verified local and exported counts without private metadata (#1173)", () => {
  for (const [withheldCount, exportedCount] of [[0, 0], [1, 3], [5, 9]]) {
    const sync = { state: "ok" as const, withheldCount, exportedCount, nextStep: "PRIVATE-NEXT-STEP-743", error: "PRIVATE-ERROR-743", ids: ["PRIVATE-ID-743"], attemptHash: "PRIVATE-HASH-743" };
    for (const rendered of [memorySyncLine(sync), uiMemorySyncLine(sync)]) {
      expect(rendered).toContain("ok");
      expect(rendered).toContain(`${withheldCount} row${withheldCount === 1 ? "" : "s"} withheld locally`);
      expect(rendered).toContain(`${exportedCount} exported`);
      expect(rendered).not.toContain("failed");
      expect(rendered).not.toContain("PRIVATE");
    }
    expect(text(renderStatus({ peers: {}, memoryProfile: { state: "ready", sync } }, 80))).toContain("withheld locally");
  }
  for (const sync of [{ state: "ok", withheldCount: 2 }, { state: "ok", withheldCount: -1, exportedCount: 0 }, { state: "ok", withheldCount: NaN, exportedCount: 0 }]) {
    expect(memorySyncLine(sync)).not.toContain("withheld");
    expect(uiMemorySyncLine(sync)).not.toContain("withheld");
  }
  expect(memorySyncLine({ state: "ok" })).toBe("ok");
  expect(uiMemorySyncLine({ state: "ok" })).toBe("Machine sync: ok");
});

test("legacy declined status uses the exact package-activation limitation and only the inspection step (#1173)", () => {
  const copy = (count: string) => "machine sync blocked: " + count + " declined rows; per-row placement is not active on this store (agent-mem has no activation command yet, agent-mem#281). Inspect with `ahub memory declined`.";
  for (const declinedCount of [2, 0]) {
    const sync = { state: "failed", cause: "declined", declinedCount, placementActive: false as const, at: 1000, nextStep: "PRIVATE-STEP-743", error: "PRIVATE-ERROR-743", ids: ["PRIVATE-ID-743"] };
    expect(memorySyncLine(sync)).toBe(copy(String(declinedCount)));
    expect(uiMemorySyncLine(sync)).toBe(copy(String(declinedCount)));
    expect(memorySyncLine(sync)).not.toContain("PRIVATE");
  }
  for (const declinedCount of [undefined, NaN, -1, 1.5]) {
    const sync = { state: "failed", cause: "declined", declinedCount, placementActive: false as const };
    expect(memorySyncLine(sync)).toBe(copy("unknown"));
    expect(uiMemorySyncLine(sync)).toBe(copy("unknown"));
    expect(memorySyncLine(sync)).not.toContain("0 declined rows");
  }
  for (const sync of [{ state: "failed", cause: "declined", declinedCount: 2 }, { state: "failed", cause: "transport", placementActive: false as const }]) {
    expect(memorySyncLine(sync)).not.toContain("placement is not active");
    expect(uiMemorySyncLine(sync)).not.toContain("placement is not active");
  }
});
