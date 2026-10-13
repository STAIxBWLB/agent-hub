import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { personEnv } from "../src/hub/child-process.ts";
import { acquireRecoveryLock, claimRunner, operationPath, recoveryRunner } from "../src/hub/recovery-store.ts";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
test("pet CLI observes real absent live and unreadable recovery claims without changing them", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-pet-recovery-")), home = join(root, "home"); mkdirSync(join(home, "recovery"), { recursive: true });
  const operation = randomUUID(); acquireRecoveryLock(operation, home);
  const env: NodeJS.ProcessEnv = { ...personEnv(), AGENTHUB_HOME: home };
  delete env.AGENTHUB_STATE_DIR; delete env.AGENTHUB_PROJECT_DIR; delete env.AGENTHUB_INSTANCE_ID; delete env.AGENTHUB_LAUNCH_ID;
  const call = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, CLI, "--project", root, "pet", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(err).toBe(""); return out;
  };
  let release: (() => void) | undefined;
  try {
    expect(recoveryRunner(operation, home)).toBeUndefined();
    expect(await call("--short")).toBe("ahub!1");
    expect(await call()).toContain("blocked (1)");
    release = claimRunner(operation, home);
    expect(recoveryRunner(operation, home)).toBe(process.pid);
    expect(await call("--short")).toBe("");
    expect(await call()).toContain("+1");
    expect(recoveryRunner(operation, home)).toBe(process.pid);
    release(); release = undefined;
    writeFileSync(`${operationPath(operation, home)}.runner.db`, "INVALID_RUNNER_MARKER");
    expect(recoveryRunner(operation, home)).toBe("unknown");
    expect(await call("--short")).toBe("");
    const unknown = await call(); expect(unknown).toContain("runner unknown"); expect(unknown).not.toContain("INVALID_RUNNER_MARKER");
  } finally { release?.(); rmSync(root, { recursive: true }); }
}, 20000);
