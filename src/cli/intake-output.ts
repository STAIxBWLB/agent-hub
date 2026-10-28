// Human output for `ahub intake` (#334, #511a). Pure: parsed hub-tool JSON in, spans out, no I/O. `--json` is the caller's branch and prints the same text.
// A private request arrives from the hub as a stub (`[pii]` title and detail); this module shows that stub and never asks for more.
import { blank, grid, heading, pair, s } from "./sdlc-output.ts";
import type { Span } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const dash = (value: unknown) => value === undefined || value === null || value === "" ? "-" : String(value);
const ids = (values: unknown) => list(values).map(id => `#${id}`).join(" ") || "-";

const HOW: Record<string, string> = {
  planner: "asked the planner to split it with hub_backlog_split",
  hub: "split by the hub's model",
  unsplit: "left whole: nothing split it",
};

/** `ahub intake "<text>"`: the draft, who is splitting it, and the children if the hub split it. */
export function renderIntake(result: unknown, columns?: number): Span[][] {
  const r = result as any, draft = r?.draft, children = list(r?.children);
  const out: Span[][] = [...heading(`Intake draft #${draft?.id ?? "?"}`, columns)];
  out.push(...pair("title", dash(draft?.title), columns, 8), ...pair("state", "draft: held until you approve it", columns, 8, "attention"), ...pair("split", HOW[r?.split] ?? dash(r?.split), columns, 8));
  if (r?.reason) out.push(...pair("because", String(r.reason), columns, 8, "attention"));
  if (children.length) out.push(blank, [s(`${children.length} draft part${children.length === 1 ? "" : "s"}`, "muted")], ...grid(["ID", "CLASS", "AFTER", "TITLE"], children.map((c: any) => [s(`#${c.id}`, "taskRef"), s(dash(c.profileClass ?? c.class)), s(ids(c.deps)), s(dash(c.title))]), columns));
  out.push(blank, [s(`approve with ahub intake approve ${draft?.id ?? "<id>"}, or discard with ahub intake discard ${draft?.id ?? "<id>"}`, "muted")]);
  return out;
}

/** `ahub intake approve|discard <id>`: every card the command changed. */
export function renderIntakeChange(op: "approve" | "discard", result: unknown, columns?: number): Span[][] {
  const rows = list(result);
  const out: Span[][] = [...heading(op === "approve" ? `Intake approved: ${rows.length} card${rows.length === 1 ? "" : "s"} released to the backlog` : `Intake discarded: ${rows.length} card${rows.length === 1 ? "" : "s"} cancelled`, columns)];
  out.push(...grid(["ID", "STATE", "TITLE"], rows.map((c: any) => [s(`#${c.id}`, "taskRef"), s(dash(c.state), c.state === "cancelled" ? "muted" : undefined), s(dash(c.title))]), columns));
  return out;
}
