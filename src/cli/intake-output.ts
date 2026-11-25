// Human output for `ahub intake` (#334, #511a). Pure: parsed hub-tool JSON in, spans out, no I/O. `--json` is the caller's branch and prints the same text.
// A private request arrives from the hub as a stub (`[pii]` title and detail); this module shows that stub and never asks for more.
import { grid, s } from "./sdlc-output.ts";
import { Report, plural, type Span } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const dash = (value: unknown) => value === undefined || value === null || value === "" ? "-" : String(value);
const ids = (values: unknown) => list(values).map(id => `#${id}`).join(" ") || "-";

const HOW: Record<string, string> = {
  planner: "asked the planner to split it with hub_backlog_split",
  hub: "split by the hub's model",
  unsplit: "left whole: nothing split it",
};

/** `ahub intake "<text>"`: the draft, who is splitting it, and the children if the hub split it. */
export function renderIntake(result: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const r = result as any, draft = r?.draft, children = list(r?.children);
  const out = new Report(columns, ascii).titled("ahub", "Intake draft", `#${draft?.id ?? "?"}`, true);
  out.section("Draft").kv([["title", dash(draft?.title)], ["state", "draft: held until you approve it"], ["split", HOW[r?.split] ?? dash(r?.split)]]);
  if (r?.reason) out.bullet("warn", `because: ${String(r.reason)}`);
  if (children.length) out.section(plural(children.length, "draft part")).append(grid(["ID", "CLASS", "AFTER", "TITLE"], children.map((c: any) => [s(`#${c.id}`, "taskRef"), s(dash(c.profileClass ?? c.class)), s(ids(c.deps)), s(dash(c.title))]), columns));
  out.note(`approve with ahub intake approve ${draft?.id ?? "<id>"}, or discard with ahub intake discard ${draft?.id ?? "<id>"}`);
  return out.lines();
}

/** `ahub intake approve|discard <id>`: every card the command changed. */
export function renderIntakeChange(op: "approve" | "discard", result: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const rows = list(result);
  const out = new Report(columns, ascii).titled("ahub", op === "approve" ? `Intake approved: ${plural(rows.length, "card")} released to the backlog` : `Intake discarded: ${plural(rows.length, "card")} cancelled`);
  out.section("Cards", String(rows.length)).append(grid(["ID", "STATE", "TITLE"], rows.map((c: any) => [s(`#${c.id}`, "taskRef"), s(dash(c.state), c.state === "cancelled" ? "muted" : undefined), s(dash(c.title))]), columns));
  return out.lines();
}
