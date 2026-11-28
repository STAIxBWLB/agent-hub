import type { MilestoneView } from "./roadmap-view.ts";

/** A projection of the already screened roadmap view; never accepts raw task records. */
export function roadmapExport(views: readonly MilestoneView[], issueStates: ReadonlyMap<string, "open" | "closed"> = new Map()): { json: string; markdown: string } {
  const horizonOrder = { now: 0, next: 1, later: 2 } as const;
  const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
  const milestones = [...views].sort((a, b) => horizonOrder[a.horizon] - horizonOrder[b.horizon] || a.order - b.order || a.id - b.id).map(view => {
    const issues = view.issues.map(({ ref }) => ({ ref, state: issueStates.get(ref) ?? "unknown" })).sort((a, b) => compare(a.ref, b.ref));
    return {
      id: view.id, title: view.title, outcome: view.outcome, state: view.state, horizon: view.horizon,
      order: view.order, target: view.target, parent: view.parent,
      issues,
      specs: [...view.specs].map(spec => ({ id: spec.id, state: spec.state })).sort((a, b) => compare(a.id, b.id)),
      progress: { tasks: { ...view.rollup.tasks }, issues: { closed: issues.filter(issue => issue.state === "closed").length, total: issues.length, unknown: issues.filter(issue => issue.state === "unknown").length }, specs: { ...view.rollup.specs }, releases: { ...view.rollup.releases } },
      withheld: view.withheld,
    };
  });
  const json = `${JSON.stringify({ version: 1, milestones }, null, 2)}\n`;
  const inline = (value: string): string => value.replace(/[\\`*_\[\]<>]/g, "\\$&").replace(/[\r\n]+/g, " ");
  const lines = ["# Roadmap", "", "Generated from the public roadmap view."];
  for (const horizon of ["now", "next", "later"] as const) {
    lines.push("", `## ${horizon[0]!.toUpperCase()}${horizon.slice(1)}`);
    for (const milestone of milestones.filter(row => row.horizon === horizon)) {
      lines.push("", `### ${milestone.id}. ${inline(milestone.title)}`, "", inline(milestone.outcome), "",
        `State: ${milestone.state}. Tasks: ${milestone.progress.tasks.approved}/${milestone.progress.tasks.total} approved. Issues: ${milestone.progress.issues.closed}/${milestone.progress.issues.total} closed; ${milestone.progress.issues.unknown} unknown. Private tasks withheld: ${milestone.withheld}.`);
      for (const issue of milestone.issues) lines.push(`- ${inline(issue.ref)}: ${issue.state}`);
    }
  }
  return { json, markdown: `${lines.join("\n")}\n` };
}
