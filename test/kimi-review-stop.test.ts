import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopKimiReview } from "../src/adapters/kimi-review.ts";
import { stopOwnedProcess, trackGroup } from "../src/hub/child-process.ts";

test("Kimi locked refresh gets SIGTERM grace without SIGKILL until the lock clears", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-kimi-stop-")), ready = join(root, "ready"), lock = join(root, "kimi-code.lock");
  writeFileSync(lock, "synthetic refresh lock");
  const child = spawn(process.execPath, ["-e", `process.on('SIGTERM',()=>{});await Bun.write(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { detached: true, stdio: "ignore" });
  child.once("spawn", () => trackGroup(child));
  try {
    for (let n = 0; n < 100 && !existsSync(ready); n++) await Bun.sleep(5);
    expect(existsSync(ready)).toBe(true);
    await expect(stopKimiReview(child, [lock], 30)).rejects.toThrow("graceful stop incomplete");
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
  } finally {
    rmSync(lock, { force: true });
    await stopOwnedProcess(child, { group: true, termMs: 50, killMs: 1000 });
    rmSync(root, { recursive: true, force: true });
  }
});
