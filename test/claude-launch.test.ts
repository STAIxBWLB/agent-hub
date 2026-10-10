import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStaleClaudeSettings, readClaudeNative } from "../src/cli/launch.ts";
import { processLiveness } from "../src/pi/process-signature.ts";
import { processTable } from "../src/hub/child-process.ts";

test("a killed Claude launcher records its actual child; crash cleanup waits for verified native exit (#270)", async () => {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "claude-launch-crash-")));
  const module = join(import.meta.dir, "../src/cli/launch.ts"), identity = join(import.meta.dir, "../src/pi/process-signature.ts");
  const wrapper = join(stateDir, "launcher.ts");
  writeFileSync(wrapper, `import { buildLaunch, claudeObservationHooks, recordClaudeLaunch, runClaudeLaunch } from ${JSON.stringify(module)};
import { processSignature } from ${JSON.stringify(identity)};
const stateDir = ${JSON.stringify(stateDir)};
const facts = claudeObservationHooks({}, { script: "/fixture/facts-hook.ts", stateDir });
const launch = buildLaunch("claude", [], { unattended: false, facts });
const record = { instanceId: "fixture", launchId: "crash-fixture", launcherPid: process.pid, launcherSignature: processSignature(process.pid), settingsFile: launch.settingsFile };
recordClaudeLaunch(stateDir, record);
await runClaudeLaunch({ ...launch, cmd: "/bin/sleep", args: ["60"] }, { cwd: stateDir, stateDir, record, env: { ...process.env, LAUNCH_FIXTURE_SECRET: "private-native-env-canary" } });
`);
  const launcher = Bun.spawn([process.execPath, wrapper], { cwd: stateDir, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let record: any;
  try {
    for (let i = 0; i < 400; i++) {
      try { const managed = JSON.parse(readFileSync(join(stateDir, "claude-launch.json"), "utf8")); record = readClaudeNative(stateDir, managed) ?? managed; } catch { /* wait for publication */ }
      if (record?.nativePid && !existsSync(join(stateDir, "claude-launch.lock"))) break;
      await Bun.sleep(10);
    }
    expect(record.launcherPid).toBe(launcher.pid);
    expect(record.nativePid).toBeGreaterThan(0); expect(record.nativePid).not.toBe(launcher.pid);
    expect(record.nativeSignature).toBeTruthy(); expect(record.nativeIdentity).toBe("direct-child");
    expect(processLiveness(record.nativePid, record.nativeSignature)).toBe("live");
    expect(existsSync(record.settingsFile)).toBe(true);
    expect(readFileSync(join(stateDir, "claude-launch.json"), "utf8")).not.toContain("private-native-env-canary");
    launcher.kill("SIGKILL"); await launcher.exited;
    expect(processLiveness(record.launcherPid, record.launcherSignature)).toBe("gone");
    cleanupStaleClaudeSettings(stateDir, record);
    expect(existsSync(record.settingsFile)).toBe(true); // the independently owned native child still lives
    cleanupStaleClaudeSettings(stateDir, record, pid => pid === record.nativePid ? undefined : "different-launcher");
    expect(existsSync(record.settingsFile)).toBe(true); // unknown native signature never permits removal of a running child
    cleanupStaleClaudeSettings(stateDir, record, () => "different-identity");
    expect(existsSync(record.settingsFile)).toBe(true); // an exec-like signature change is not native exit
    expect(processLiveness(record.nativePid, record.nativeSignature)).toBe("live");
    process.kill(record.nativePid, "SIGKILL"); // only this test's independently recorded stand-in native process
    let gone = false;
    for (let i = 0; i < 100; i++) {
      const table = processTable(); expect(table).toBeDefined();
      if (!table!.some(row => row.pid === record.nativePid)) { gone = true; break; }
      await Bun.sleep(10);
    }
    expect(gone).toBe(true);
    cleanupStaleClaudeSettings(stateDir, record);
    expect(existsSync(record.settingsFile)).toBe(false);
    expect(readClaudeNative(stateDir, record)).toBeUndefined();
  } finally {
    if (launcher.exitCode === null) { launcher.kill("SIGKILL"); await launcher.exited; }
    if (record?.nativePid && processLiveness(record.nativePid, record.nativeSignature) === "live") { try { process.kill(record.nativePid, "SIGKILL"); } catch { /* the fixture may already have exited */ } }
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 30_000);
