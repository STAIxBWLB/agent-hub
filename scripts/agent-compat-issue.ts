/** The label is for people; only this exact title identifies the automation's issue. */
export const AGENT_COMPAT_ISSUE_TITLE = "agent CLI versions ahead of the verified set";
export const AGENT_COMPAT_ISSUE_LIMIT = 1000;

/** A complete open-issue inventory in, one unambiguous identity or confirmed absence out. No I/O or writes. */
export function selectAgentCompatIssue(inventory: unknown): number | undefined {
  if (!Array.isArray(inventory)) throw new Error("agent-compat: malformed open-issue inventory");
  if (inventory.length >= AGENT_COMPAT_ISSUE_LIMIT) throw new Error("agent-compat: open-issue inventory reached the 1000-issue limit; refusing potentially truncated results");
  const seen = new Set<number>(), matching: number[] = [];
  for (const row of inventory) {
    if (!row || typeof row !== "object" || Array.isArray(row)
        || !Number.isSafeInteger(row.number) || row.number <= 0
        || typeof row.title !== "string" || !row.title.length) {
      throw new Error("agent-compat: malformed open-issue inventory");
    }
    if (seen.has(row.number)) throw new Error(`agent-compat: duplicate issue identity #${row.number}`);
    seen.add(row.number);
    if (row.title === AGENT_COMPAT_ISSUE_TITLE) matching.push(row.number);
  }
  if (matching.length > 1) throw new Error(`agent-compat: multiple tracking issues match the exact title: ${matching.sort((a, b) => a - b).map(number => `#${number}`).join(", ")}; no issue selected`);
  return matching[0];
}

if (import.meta.main) {
  try {
    let inventory: unknown;
    try { inventory = JSON.parse(await Bun.stdin.text()); }
    catch { throw new Error("agent-compat: malformed JSON open-issue inventory"); }
    const number = selectAgentCompatIssue(inventory);
    if (number !== undefined) console.log(number);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "agent-compat: issue identity unavailable");
    process.exitCode = 1;
  }
}
