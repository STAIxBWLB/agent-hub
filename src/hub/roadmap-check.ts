/** Evidence is supplied by the host, never by a model. Missing evidence stays unknown. */
export interface DriftTask {
  id: number; state: string; issue: string | null | undefined; issueState: "open" | "closed" | "unknown";
  feature: boolean; mergedAt: number | null | undefined;
  unchangedSpecs: readonly string[] | undefined;
}
export interface DriftMilestone {
  id: number; state: string; tasks: readonly DriftTask[]; openItems: boolean | undefined;
  mergedCode: boolean | undefined; specs: readonly { id: string; state: string }[];
  mirrorDiff: boolean | undefined;
}
export interface RoadmapDriftInput {
  milestones: readonly DriftMilestone[]; now: number; closeLagMs: number;
  mirrorEnabled: boolean; exportMatches: boolean | undefined;
}
export interface RoadmapDrift {
  rule: number; milestone: number | null; items: string[]; cause: string; remedy: string;
}
export function checkRoadmap(input: RoadmapDriftInput): { findings: RoadmapDrift[]; unknown: number[] } {
  if (!Number.isFinite(input.now) || !Number.isFinite(input.closeLagMs) || input.closeLagMs < 0) throw new Error("invalid roadmap clock");
  const findings: RoadmapDrift[] = [], missing = new Set<number>();
  const add = (rule: number, milestone: number | null, items: string[], cause: string, remedy: string) => findings.push({ rule, milestone, items, cause, remedy });
  for (const m of [...input.milestones].sort((a, b) => a.id - b.id)) {
    if (!Number.isSafeInteger(m.id) || m.id < 1) throw new Error("invalid milestone id");
    for (const task of [...m.tasks].sort((a, b) => a.id - b.id)) {
      if (!Number.isSafeInteger(task.id) || task.id < 1) throw new Error("invalid task id");
      const item = [`task:${task.id}`];
      if (task.issue === undefined || task.issue !== null && task.issueState === "unknown") { missing.add(1); missing.add(2); }
      else {
        if (task.issue !== null && task.issueState === "closed" && !["approved", "cancelled"].includes(task.state))
          add(1, m.id, item, "closed issue has unfinished task", `ahub task show ${task.id}`);
        if (task.state === "approved" && task.issue !== null && task.issueState === "open") {
          if (task.mergedAt === undefined) missing.add(2);
          else if (task.mergedAt !== null && task.mergedAt <= input.now - input.closeLagMs)
            add(2, m.id, item, "merged task issue remains open", `ahub roadmap show ${m.id}`);
        }
      }
      if (task.feature && task.issue === undefined) missing.add(6);
      else if (task.feature && task.issue === null) add(6, m.id, item, "feature task has no spec issue", `ahub task show ${task.id}`);
      if (task.issue === undefined) missing.add(6);
      else if (task.issue === null && !task.feature) add(6, m.id, item, "task has no issue", `ahub task show ${task.id}`);
      if (task.mergedAt === undefined || task.mergedAt !== null && task.unchangedSpecs === undefined) missing.add(5);
      else if (task.mergedAt !== null) for (const id of task.unchangedSpecs ?? [])
        add(5, m.id, [...item, `spec:${id}`], "merged change did not update covering spec", "ahub specs check");
    }
    if (m.openItems === undefined) missing.add(3);
    else if (m.state === "done" && m.openItems || m.state === "active" && !m.openItems)
      add(3, m.id, [], m.openItems ? "done milestone has open items" : "active milestone has no open items", `ahub roadmap show ${m.id}`);
    if (m.mergedCode === undefined) missing.add(4);
    else if (m.mergedCode) for (const spec of m.specs) {
      if (spec.state === "unknown") missing.add(4);
      else if (["stale", "unverified"].includes(spec.state)) add(4, m.id, [`spec:${spec.id}`], `spec is ${spec.state}`, `ahub specs check`);
    }
    if (input.mirrorEnabled && m.mirrorDiff === undefined) missing.add(7);
    else if (input.mirrorEnabled && m.mirrorDiff) add(7, m.id, [], "GitHub mirror differs", "ahub roadmap sync");
  }
  if (input.exportMatches === undefined) missing.add(8);
  else if (!input.exportMatches) add(8, null, [], "roadmap export differs from board", "ahub roadmap export --write");
  return { findings, unknown: [...missing].sort((a, b) => a - b) };
}
