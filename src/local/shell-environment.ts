import { homedir } from "node:os";

export interface HostShellEnvironment extends Record<string, string> { PATH: string; HOME: string; LANG: string; TERM: string }

/** The #816 executor's fixed baseline, shared by the proof and host wrapper; never inherit a native agent's environment.
 * ponytail: Seatbelt's accepted source stays byte-identical and adds TMPDIR separately; a future shared-executor
 * extraction must preserve the runtime environment parity test and explicitly revise that source's byte guard. */
export function hostShellEnvironment(extra: Readonly<Record<string, string>> = {}): HostShellEnvironment {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), LANG: process.env.LANG ?? "en_US.UTF-8", TERM: "dumb", ...extra };
}
