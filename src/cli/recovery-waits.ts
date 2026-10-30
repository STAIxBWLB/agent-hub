import { configRefusal } from "../hub/config-trust.ts";
import { readInstanceConfigLayers } from "../hub/instance-config.ts";
import { recoveryWaits, type RecoveryOperationalConfig, type RecoveryWaits } from "../hub/operational-settings.ts";

/**
 * #489 H4. The upgrade coordinator is a CLI process, not the daemon, so it reads the five recovery waits itself, from the project it is acting on, at the START of each wait (a wait already running keeps
 * its deadline, and the receipt's `waits` records it). Both layers count, the machine-local file last, as `loadConfig` merges them; a layer git tracks as local policy is refused like every other local
 * policy (`configRefusal`) and a file that cannot be read or parsed is the default. A recovery never fails on its configuration: bounds were checked when the value was written, and `recoveryWaits` falls
 * back to the default for a value outside them.
 */
const LEAVES = new Set(["reconnect_wait_s", "unmanaged_reconnect_wait_s", "control_timeout_s", "shutdown_wait_s", "terminal_idle_wait_s"]);
export function readRecoveryWaits(projectRoot: string | undefined, read: (cwd: string) => ReturnType<typeof readInstanceConfigLayers> = readInstanceConfigLayers): RecoveryWaits {
  if (!projectRoot) return recoveryWaits(() => undefined);
  let merged: RecoveryOperationalConfig["recovery"];
  try {
    for (const layer of read(projectRoot)) {
      const recovery = layer.raw.recovery;
      if (!recovery || typeof recovery !== "object" || Array.isArray(recovery) || !Object.keys(recovery).some(key => LEAVES.has(key))) continue;
      // The shared file is team policy and always read; the machine-local file only when git does not track it. Git is asked only when that file actually sets one of the five
      // (a recovery polls and sends many control requests, and a file that sets none must cost no subprocess).
      if (layer.name === "config.local.json" && configRefusal(projectRoot, layer.name)) continue;
      merged = { ...merged, ...(recovery as Record<string, unknown>) };
    }
  } catch { return recoveryWaits(() => undefined); }
  return recoveryWaits(() => ({ recovery: merged }));
}
