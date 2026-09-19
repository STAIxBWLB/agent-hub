import { expect, test } from "bun:test";
import { PiToolReceipts } from "../src/pi/tool-receipts.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
