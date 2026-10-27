// Human output for `ahub source add|list` (#508). Pure: data in, spans out, no I/O. `--json` is the caller's branch and prints the same data.
import { blank, grid, heading, pair, s } from "./sdlc-output.ts";
import { moment } from "./sdlc-output.ts";
import type { Span } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const size = (bytes: unknown) => typeof bytes === "number" && Number.isFinite(bytes) ? bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB` : "unknown";

/** `ahub source add`: what was registered, and whether it was new or an upgrade of an existing record. */
export function renderSourceAdd(result: unknown, columns?: number): Span[][] {
  const r = result as any, out: Span[][] = [...heading(r?.created ? `Registered ${r?.id}` : r?.upgraded ? `Already registered ${r?.id}; now private` : `Already registered ${r?.id}`, columns)];
  out.push(...pair("kind", r?.kind ?? "unknown", columns, 8), ...pair("origin", r?.origin ?? "unknown", columns, 8), ...pair("sha256", r?.sha256 ?? "unknown", columns, 8), ...pair("size", size(r?.bytes), columns, 8));
  out.push(...pair("private", r?.private ? "yes" : "no", columns, 8, r?.private ? "attention" : undefined), ...pair("text", r?.text ? "projected" : "none (no converter handles these bytes)", columns, 8, r?.text ? undefined : "muted"));
  if (list(r?.reasons).length) out.push(...pair("because", list(r.reasons).join("; "), columns, 8, "attention"));
  return out;
}

/** `ahub source list`: one row per registered source, newest last. The person sees every origin of a private source. */
export function renderSourceList(rows: unknown, columns?: number, now = Date.now()): Span[][] {
  const sources = list(rows);
  if (!sources.length) return [[s("no sources registered; add one with ahub source add <path|url>", "muted")]];
  const out: Span[][] = [...heading(`Sources (${sources.length})`, columns)];
  out.push(...grid(["ID", "KIND", "SIZE", "PRIVATE", "ADDED", "ORIGIN"], sources.map((row: any) => [
    s(row.id, "issueRef"), s(row.kind), s(size(row.bytes)), s(row.private ? "yes" : "no", row.private ? "attention" : "muted"), s(moment(row.added_at, now)), s(row.origin),
  ]), columns));
  const many = sources.filter((row: any) => list(row.origins).length > 1);
  for (const row of many) out.push(blank, ...pair(row.id, `${list(row.origins).length} origins: ${list(row.origins).map((o: any) => `${o.origin}${o.private ? " (private)" : ""}`).join("; ")}`, columns, 20, undefined));
  return out;
}
