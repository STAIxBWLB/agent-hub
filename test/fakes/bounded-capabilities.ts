import type { DaemonOptions } from "../../src/hub/daemon.ts";

/** Emulated peers in routing/lifecycle fixtures advertise capabilities without consulting host accounts or a VM. */
export function emulatedBoundedTools(): NonNullable<DaemonOptions["boundedTools"]> {
  return {
    specAvailable: async () => ({ available: true }),
    fetchSpec: async () => { throw new Error("unexpected spec fetch in emulated peer fixture"); },
    runner: () => ({
      available: async () => ({ available: true }),
      start: () => { throw new Error("unexpected isolated check in emulated peer fixture"); },
      result: async () => undefined, sweep: async () => [], stopAll: async () => {},
      consumeOutput: async () => {}, cancel: async () => {}, markStale: async () => {},
    }),
  };
}
