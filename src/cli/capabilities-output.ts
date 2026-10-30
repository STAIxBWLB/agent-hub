// Human output for `ahub capabilities` (#445 C1). Pure: parsed hub-tool JSON in, spans out, no I/O. `--json` is the caller's branch and prints the same text.
// A description is another agent's words: the daemon has already sanitized it, and it is shown here as data on its own row, never as part of a command line.
import { blank, grid, heading, pair, s } from "./sdlc-output.ts";
import type { Span } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const dash = (value: unknown) => value === undefined || value === null || value === "" ? "-" : String(value);
const STATE_TONE: Record<string, "attention" | "muted" | undefined> = { listed: undefined, "digest-changed": "attention", unshared: "muted" };

/** `ahub capabilities`: per peer, each capability the hub can see, whether you share it, and the class that would apply to a call. */
export function renderCapabilities(result: unknown, columns?: number): Span[][] {
  const peers = list((result as { peers?: unknown } | null)?.peers);
  const out: Span[][] = [...heading(`Capabilities: ${peers.length} peer${peers.length === 1 ? "" : "s"} listing`, columns)];
  if (!peers.length) {
    out.push(blank, [s("no peer lists a capability: an agent must be attached, on a version the hub has probed, and offer a skill or command", "muted")]);
    return out;
  }
  for (const peer of peers) {
    const entries = list(peer.entries);
    const shared = entries.filter(entry => entry.state === "listed").length;
    out.push(blank, ...heading(`${dash(peer.peer)}: ${entries.length} found, ${shared} shared, mode ${dash(peer.permission_mode)}`, columns));
    out.push(...grid(["ID", "STATE", "CLASS", "SOURCE", "DIGEST"], entries.map((entry: any) => [
      s(dash(entry.id)), s(dash(entry.state), STATE_TONE[String(entry.state)]), s(dash(entry.class), entry.class === "destructive" ? "attention" : undefined), s(`${dash(entry.source)}/${dash(entry.invoke)}`), s(dash(entry.digest)),
    ]), columns));
    const stale = entries.filter(entry => entry.state === "digest-changed");
    for (const entry of stale) out.push(...pair("changed", `${dash(entry.id)} no longer matches its pinned digest and is unlisted until you pin the new one`, columns, 8, "attention"));
  }
  out.push(blank, [s("Share an entry by adding its digest under invocation.share.<peer> in .agenthub/config.local.json (this machine only). A class you set can only raise the one the source declared. An entry with no class anywhere counts as destructive and is refused.", "muted")]);
  return out;
}
