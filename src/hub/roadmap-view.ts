import type { Task } from "./board.ts";
import type { Release } from "./planning.ts";
import type { SpecsFreshness } from "./specs.ts";
import type { Milestone, MilestoneLink } from "./roadmap.ts";
import { sanitize } from "./envelope.ts";

export interface RoadmapSnapshot {
  milestones: Milestone[];
  links: MilestoneLink[];
  tasks: Task[];
  releases: Release[];
  freshness: SpecsFreshness[] | undefined;
  issueOf(task: Task): string | undefined;
  privateTask(task: Task): boolean;
  publicText(text: string): boolean;
}

/** Only public task identities enter a view. Withheld membership is a count, never a stub. */
export function milestoneViews(snapshot: RoadmapSnapshot) {
  const explicit = new Set(snapshot.links.filter(link => link.kind === "task").map(link => Number(link.ref)));
  const tasks = new Map(snapshot.tasks.map(task => [task.id, task]));
  const safe = (text: string) => { try { return snapshot.publicText(text); } catch { return false; } };
  return snapshot.milestones.map(milestone => {
    const allLinks = snapshot.links.filter(link => link.milestone === milestone.id);
    const issues = new Set(allLinks.filter(link => link.kind === "issue").map(link => link.ref));
    const members = new Map<number, { rule: "explicit" | "source-issue"; issue?: string }>();
    for (const link of allLinks) if (link.kind === "task") members.set(Number(link.ref), { rule: "explicit" });
    for (const task of snapshot.tasks) {
      if (explicit.has(task.id)) continue;
      const issue = snapshot.issueOf(task);
      if (issue && issues.has(issue)) members.set(task.id, { rule: "source-issue", issue });
    }
    let withheld = 0;
    const visible = [] as { id: number; title: string; state: Task["state"]; placement: { rule: "explicit" | "source-issue"; issue?: string } }[];
    const visibleIds = new Set<number>();
    for (const [id, placement] of members) {
      const task = tasks.get(id);
      if (!task || snapshot.privateTask(task) || !safe(task.title) || placement.issue !== undefined && !safe(placement.issue)) { withheld++; continue; }
      visible.push({ id, title: sanitize(task.title), state: task.state, placement }); visibleIds.add(id);
    }
    visible.sort((a, b) => a.id - b.id);
    const links = allLinks.filter(link => (link.kind !== "task" || visibleIds.has(Number(link.ref))) && safe(link.ref))
      .map(link => ({ ...link, by: safe(link.by) ? link.by : "withheld" }));
    const issueRows = [...issues].filter(safe).map(ref => {
      let at: number | undefined;
      const states = new Set<"open" | "closed">();
      for (const task of snapshot.tasks) {
        if (snapshot.privateTask(task) || snapshot.issueOf(task) !== ref) continue;
        const review = task.sdlc?.planReview, cached = review?.issue;
        if (!cached || `${cached.repo.toLowerCase()}#${cached.issue}` !== ref || !review
          || !Number.isSafeInteger(review.recordedAt) || review.recordedAt <= 0 || !["OPEN", "CLOSED"].includes(cached.state)) continue;
        if (at === undefined || review.recordedAt > at) { at = review.recordedAt; states.clear(); }
        if (review.recordedAt === at) states.add(cached.state === "CLOSED" ? "closed" : "open");
      }
      const state = states.size === 1 ? [...states][0]! : "unknown";
      return { ref, state, ...(at === undefined ? {} : { cachedAt: at }) };
    });
    const specs = allLinks.filter(link => link.kind === "spec" && safe(link.ref)).map(link => {
      const rows = snapshot.freshness?.filter(row => row.id === link.ref);
      const sourceState = rows?.length === 1 ? rows[0]!.state : "unknown";
      const state = sourceState === "fresh" || sourceState === "stale" || sourceState === "unverified" ? sourceState : "unknown";
      return { id: link.ref, state, ...(sourceState === "nonancestor" ? { sourceState } : {}) };
    });
    const releases = allLinks.filter(link => link.kind === "release" && safe(link.ref)).map(link => {
      const release = snapshot.releases.find(row => row.id === Number(link.ref));
      return { id: Number(link.ref), state: release?.state ?? "unknown", ...(release && safe(release.name) ? { name: release.name } : {}) };
    });
    const metadataVisible = safe(milestone.title) && safe(milestone.outcome);
    return { ...milestone, title: metadataVisible ? milestone.title : "[withheld]", outcome: metadataVisible ? milestone.outcome : "[withheld]",
      history: milestone.history.map(entry => ({ ...entry, by: safe(entry.by) ? entry.by : "withheld" })),
      links, tasks: visible, withheld, issues: issueRows, specs, releases,
      children: snapshot.milestones.filter(row => row.parent === milestone.id).map(row => row.id),
      rollup: {
        tasks: { approved: visible.filter(task => task.state === "approved").length, total: visible.length },
        issues: { closed: issueRows.filter(issue => issue.state === "closed").length, total: issueRows.length, unknown: issueRows.filter(issue => issue.state === "unknown").length },
        specs: { fresh: specs.filter(spec => spec.state === "fresh").length, stale: specs.filter(spec => spec.state === "stale").length,
          unverified: specs.filter(spec => spec.state === "unverified").length, unknown: specs.filter(spec => spec.state === "unknown").length, total: specs.length },
        releases: { shipped: releases.filter(release => release.state === "shipped").length, total: releases.length, unknown: releases.filter(release => release.state === "unknown").length },
      },
    };
  });
}
export type MilestoneView = ReturnType<typeof milestoneViews>[number];
