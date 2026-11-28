import type { AgentVersionRow } from "./agents.ts";
import { Report, type Span } from "./console-state.ts";
import { grid, s } from "./sdlc-output.ts";

export function renderAgents(rows: readonly AgentVersionRow[], columns?: number, ascii = false): Span[][] {
  if (!rows.length) return [[{ text: "no native agents" }]];
  const items = rows.map(({ id, verdict, policy }) => [
    s(id, "info"), s(verdict.version ?? "-"), s(verdict.state, verdict.ok ? "success" : "attention"),
    s(policy), s(verdict.ok ? verdict.note ?? "" : verdict.reason),
  ]);
  return new Report(columns, ascii).titled("ahub", "Agents")
    .section("Versions", String(rows.length)).append(grid(["AGENT", "VERSION", "STATE", "POLICY", "DETAIL"], items, columns)).lines();
}
