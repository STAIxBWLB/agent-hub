import { readPlanIssueMetadata, type SdlcGh } from "./sdlc.ts";

type IssueState = "open" | "closed";

/** Live evidence for one roadmap snapshot. Missing keys are unknown. */
export async function roadmapIssueStates(refs: ReadonlySet<string>, gh: SdlcGh, current: () => void): Promise<Map<string, IssueState>> {
  const pending = [...refs].sort().slice(0, 100), states = new Map<string, IssueState>();
  const deadline = performance.now() + 20_000;
  let next = 0, stopped = false;
  const worker = async () => {
    try {
      while (!stopped && next < pending.length && performance.now() < deadline) {
        const ref = pending[next++]!;
        const match = /^([^#]+)#([1-9][0-9]*)$/.exec(ref);
        if (!match) continue;
        current();
        const value = await readPlanIssueMetadata(match[1]!, Number(match[2]), (args, timeout, cwd, cap) => {
          const remaining = deadline - performance.now();
          return remaining > 0
            ? gh([...args.slice(0, 2), "--hostname", "github.com", ...args.slice(2)], Math.min(timeout ?? remaining, remaining), cwd, cap)
            : Promise.resolve({ code: 1, stdout: "" });
        });
        current();
        if (value && performance.now() < deadline) states.set(ref, value.state === "CLOSED" ? "closed" : "open");
      }
    } catch (error) {
      stopped = true;
      throw error;
    }
  };
  // Drain already started reads before surfacing a revoked snapshot.
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, worker));
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return states;
}
