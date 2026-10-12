import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personEnv } from "../src/hub/child-process.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
test("pet CLI reads a signed status file without a control token or connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-pet-cli-")), home = join(root, "home");
  const state = join(root, ".agenthub/state"); mkdirSync(state, { recursive: true }); mkdirSync(home);
  const env: NodeJS.ProcessEnv = { ...personEnv(), AGENTHUB_HOME: home };
  delete env.AGENTHUB_STATE_DIR; delete env.AGENTHUB_PROJECT_DIR; delete env.AGENTHUB_INSTANCE_ID; delete env.AGENTHUB_LAUNCH_ID;
  const call = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, CLI, "--project", root, "pet", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  };
  try {
    writeFileSync(join(state, "status.json"), JSON.stringify({ pid: process.pid, pidSignature: processSignature(process.pid), needs: { act: 1, watch: 0, state: "review", first: { kind: "review", level: "act", id: 7 } } }));
    expect(await call()).toEqual({ out: "(O O) ? 1 for review\n", err: "", code: 0 });
    expect(await call("--short")).toEqual({ out: "ahub!1", err: "", code: 0 });
    writeFileSync(join(state, "status.json"), JSON.stringify({ pid: process.pid, pidSignature: processSignature(process.pid), needs: { act: 0, watch: 0, state: "idle" } }));
    expect((await call("--short")).out).toBe("");
    expect((await call("--unknown")).code).not.toBe(0);
    expect(classifyPeerCommand("pet", [])).toBe("allowed");
  } finally { rmSync(root, { recursive: true }); }
}, 20000);
