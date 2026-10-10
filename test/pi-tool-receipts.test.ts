import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { packPiShellResult, PiToolReceipts, PI_TOOL_RESULT_CAP } from "../src/pi/tool-receipts.ts";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a person's oversized shell result stays within the cap and keeps its trusted exit code (#253)", () => {
  const small = packPiShellResult("human", 7);
  expect(JSON.parse(small)).toEqual({ kind: "user-bash-result", text: "human", exitCode: 7 });
  const packed = packPiShellResult("\0".repeat(300_000), 3);
  expect(packed.length).toBeLessThanOrEqual(PI_TOOL_RESULT_CAP);
  const parsed = JSON.parse(packed);
  expect(parsed.kind).toBe("user-bash-result");
  expect(parsed.exitCode).toBe(3); // the review's `head -c 30000 /dev/zero; exit 3` lost this
  expect(parsed.text.endsWith("\n[output truncated]")).toBe(true);
  const cancelled = packPiShellResult("x".repeat(200_000), null);
  expect(cancelled.length).toBeLessThanOrEqual(PI_TOOL_RESULT_CAP);
  expect(JSON.parse(cancelled).exitCode).toBeNull();
});

test("Pi tool receipts dedupe concurrent effects and survive a daemon restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-receipts-")), file = join(dir, "hub.db");
  let ledger = new PiToolReceipts(file), calls = 0;
  try {
    const perform = async () => { calls++; await Bun.sleep(5); return "written"; };
    const a = ledger.execute("s", "c", "write", { path: "a" }, perform);
    const b = ledger.execute("s", "c", "write", { path: "a" }, perform);
    expect(await Promise.all([a,b])).toEqual(["written", "written"]);
    expect(calls).toBe(1);
    expect(await ledger.execute("s", "c", "write", { path: "b" }, perform)).toContain("different arguments");
    await ledger.close(); ledger = new PiToolReceipts(file);
    expect(await ledger.execute("s", "c", "write", { path: "a" }, perform)).toBe("written");
    expect(calls).toBe(1);
    expect(await ledger.execute("s", "uncertain", "bash", {}, async () => { calls++; throw new Error("lost reply"); })).toContain("uncertain");
    expect(await ledger.execute("s", "uncertain", "bash", {}, perform)).toContain("uncertain");
    expect(calls).toBe(2);
  } finally { await ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("closing a Pi ledger fences new effects while its accepted effect settles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-receipts-close-"));
  const ledger = new PiToolReceipts(join(dir, "hub.db"));
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const effect = ledger.execute("s", "accepted", "write", {}, async () => { await barrier; return "done"; });
  const closing = ledger.close();
  let calls = 0;
  expect(await ledger.execute("s", "late", "write", {}, async () => { calls++; return "unexpected"; })).toContain("shutting down");
  release();
  expect(await effect).toBe("done");
  await closing;
  expect(calls).toBe(0);
  const reopened = new PiToolReceipts(join(dir, "hub.db"));
  expect(await reopened.execute("s", "accepted", "write", {}, async () => "unexpected")).toBe("done");
  await reopened.close(); rmSync(dir, { recursive: true, force: true });
});


test("only a proven pre-effect refusal settles a Pi receipt with its exact error, including after restart (#254)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-refusal-")), file = join(dir, "hub.db");
  let ledger = new PiToolReceipts(file), calls = 0;
  const db = new Database(file);
  try {
    const refused = async () => { calls++; throw new PreEffectToolRefusal("only its owner can do that"); };
    expect(await ledger.execute("s", "refused", "hub_task_done", { id: 1 }, refused)).toBe("error: only its owner can do that");
    expect(db.query("SELECT state,result FROM pi_tool_receipts WHERE call_id='refused'").get()).toEqual({ state: "done", result: "error: only its owner can do that" });
    await ledger.close(); ledger = new PiToolReceipts(file);
    expect(await ledger.execute("s", "refused", "hub_task_done", { id: 1 }, refused)).toBe("error: only its owner can do that");
    expect(calls).toBe(1);
    const forged = Object.assign(new Error("only its owner can do that"), { name: "PreEffectToolRefusal" });
    expect(await ledger.execute("s", "generic", "hub_task_done", { id: 1 }, async () => { throw forged; })).toContain("uncertain");
    expect(db.query("SELECT state FROM pi_tool_receipts WHERE call_id='generic'").get()).toEqual({ state: "pending" });
  } finally { await ledger.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a post-effect failure and an unproven legacy pending receipt stay uncertain across restart (#254)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-post-effect-")), file = join(dir, "hub.db"), effect = join(dir, "effect.txt");
  let ledger = new PiToolReceipts(file), calls = 0;
  const db = new Database(file);
  try {
    const perform = async () => { calls++; writeFileSync(effect, "written"); throw new Error("lost reply after board write"); };
    expect(await ledger.execute("s", "legacy", "hub_task_accept", { id: 1 }, perform)).toContain("uncertain");
    expect(readFileSync(effect, "utf8")).toBe("written");
    expect(db.query("SELECT state,result FROM pi_tool_receipts WHERE call_id='legacy'").get()).toEqual({ state: "pending", result: null });
    await ledger.close(); ledger = new PiToolReceipts(file);
    expect(await ledger.execute("s", "legacy", "hub_task_accept", { id: 1 }, perform)).toContain("uncertain");
    expect(calls).toBe(1);
    expect(db.query("SELECT state,result FROM pi_tool_receipts WHERE call_id='legacy'").get()).toEqual({ state: "pending", result: null });
  } finally { await ledger.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a refused Pi call whose settlement write fails stays pending and cannot repeat (#254)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-refusal-storage-")), file = join(dir, "hub.db");
  const ledger = new PiToolReceipts(file), db = new Database(file);
  let calls = 0;
  try {
    db.run("CREATE TRIGGER no_settlement BEFORE UPDATE ON pi_tool_receipts BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    const refused = async () => { calls++; throw new PreEffectToolRefusal("this operation requires the explicit conductor role"); };
    expect(await ledger.execute("s", "refused", "hub_task_assign", { id: 1 }, refused)).toContain("uncertain");
    expect(db.query("SELECT state,result FROM pi_tool_receipts WHERE call_id='refused'").get()).toEqual({ state: "pending", result: null });
    db.run("DROP TRIGGER no_settlement");
    expect(await ledger.execute("s", "refused", "hub_task_assign", { id: 1 }, refused)).toContain("uncertain");
    expect(calls).toBe(1);
  } finally { await ledger.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
