// Human output for `ahub source add|list` (#508). Pure: data in, spans out, no I/O. `--json` is the caller's branch and prints the same data.
import { grid, moment, s } from "./sdlc-output.ts";
import { Report, type Span } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const size = (bytes: unknown) => typeof bytes === "number" && Number.isFinite(bytes) ? bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB` : "unknown";

/** `ahub source add`: what was registered, and whether it was new or an upgrade of an existing record. */
export function renderSourceAdd(result: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const r = result as any;
  const out = new Report(columns, ascii).titled("ahub", r?.created ? `Registered ${r?.id}` : r?.upgraded ? `Already registered ${r?.id}; now private` : `Already registered ${r?.id}`);
  // Keys are padded to an 8-cell label column without a colon: the layout `ahub source add` has always printed and its tests pin.
  const rows: [string, unknown][] = [["kind", r?.kind ?? "unknown"], ["origin", r?.origin ?? "unknown"], ["sha256", r?.sha256 ?? "unknown"], ["size", size(r?.bytes)], ["private", r?.private ? "yes" : "no"], ["text", r?.text ? "projected" : "none (no converter handles these bytes)"]];
  if (list(r?.reasons).length) rows.push(["because", list(r.reasons).join("; ")]);
  out.section("Source").kv(rows.map(([key, value]): [string, unknown] => [key.padEnd(8), value]), 2, { colon: false });
  if (r?.private) out.bullet("warn", "private source");
  return out.lines();
}

/** `ahub source list`: one row per registered source, newest last. The person sees every origin of a private source. */
export function renderSourceList(rows: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] {
  const sources = list(rows);
  // An empty list is one bare line, as `ahub board` prints it: there is nothing to put under a header.
  if (!sources.length) return [[s("no sources registered; add one with ahub source add <path|url>", "muted")]];
  const out = new Report(columns, ascii).titled("ahub", `Sources (${sources.length})`);
  out.section("Registered", String(sources.length)).append(grid(["ID", "KIND", "SIZE", "PRIVATE", "ADDED", "ORIGIN"], sources.map((row: any) => [
    s(row.id, "issueRef"), s(row.kind), s(size(row.bytes)), s(row.private ? "yes" : "no", row.private ? "attention" : "muted"), s(moment(row.added_at, now)), s(row.origin),
  ]), columns));
  const many = sources.filter((row: any) => list(row.origins).length > 1);
  if (many.length) out.section("Several origins", String(many.length)).kv(many.map((row: any): [string, unknown] => [String(row.id), `${list(row.origins).length} origins: ${list(row.origins).map((o: any) => `${o.origin}${o.private ? " (private)" : ""}`).join("; ")}`]));
  return out.lines();
}
