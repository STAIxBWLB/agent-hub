/**
 * The agent actor for `ahub memory` (hub task 969, #1522 AC2).
 *
 * amem names who made a change from an attribution scope (`withCliAttribution`): with none it records the person ("user"), with an
 * `agent` scope it records the agent, shows `actor: agent` and applies its read-visibility checks to every target. The scope is
 * how amem's own CLI marks a session, but its module is not on the package's public entry, so this is the one place that reaches it.
 *
 * ponytail: this imports `src/memory/cli-attribution.ts` by file URL, past the package's `exports` map, so it depends on amem's file
 * layout. The ceiling is a pin raise that moves or renames that file; `test/memory-agent-shell.test.ts` pins it (an agent `forget` must
 * record `agent`, never `user`) so such a raise fails there. The upgrade path is amem exporting `withCliAttribution` from its root,
 * which is an amem change and goes through its board. A missing or changed module refuses the command: a memory change that cannot
 * be attributed to the agent is never run as the person.
 */
import { configuredPolicy, memoryHome } from "@staix/agent-mem";

interface Attribution { actor: "person" | "agent"; peer: string; policy?: () => { screenStandalone(value: unknown): boolean } }
interface Seam { withCliAttribution<T>(identity: Attribution, work: () => T): T; cliAttribution(): Readonly<Attribution> | undefined }

let loaded: Promise<Seam> | undefined;
function seam(): Promise<Seam> {
  return loaded ??= (async () => {
    const module = await import(new URL("./memory/cli-attribution.ts", import.meta.resolve("@staix/agent-mem")).href) as Partial<Seam>;
    if (typeof module.withCliAttribution !== "function" || typeof module.cliAttribution !== "function") throw new Error("shape changed");
    return module as Seam;
  })();
}

/** Run `work` so every amem writer inside it records `peer` as an agent. Refuses, running nothing, when amem's scope cannot be reached. */
export async function withAgentAttribution<T>(peer: string, cwd: string, work: () => Promise<T>): Promise<T> {
  let attribution: Seam;
  try { attribution = await seam(); }
  catch { loaded = undefined; throw new Error("memory attribution for an agent is unavailable in the installed agent-mem; nothing was run. Check that `ahub doctor` reports the exact agent-mem pin, or ask the person to run the command in a terminal"); }
  return attribution.withCliAttribution({ actor: "agent", peer, policy: () => configuredPolicy(memoryHome(), cwd) }, work);
}
