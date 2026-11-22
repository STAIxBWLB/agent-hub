/**
 * #1483 R5: the dashboard roadmap view's pure projection. The snapshot carries the milestone views the hub already
 * projects for `ahub roadmap show`; this turns them into the Now/Next/Later lanes and the text a card shows, so the page
 * holds no rule of its own and a test pins the ordering, the counts and the withheld members without a browser.
 *
 * Self-contained on purpose: the dashboard injects this function's source into the page (`renderDashboard` in
 * `src/hub/ui.ts`), so it keeps every helper inside itself and closes over nothing from this module.
 */

/** The fields of a hub milestone view this projection reads. Unknown numbers stay unknown, never zero. */
export interface RoadmapMilestoneInput {
  id: number;
  title: string;
  outcome: string;
  state: string;
  horizon: string;
  order: number;
  target: string | null;
  revision: number;
  withheld: number;
  rollup: {
    tasks: { approved: number; total: number };
    issues: { closed: number; total: number; unknown: number };
    specs: { fresh: number; stale: number; unverified: number; unknown: number; total: number };
    releases: { shipped: number; total: number; unknown: number };
  };
}

export interface RoadmapCard {
  id: number; title: string; outcome: string; state: string; horizon: string; target: string; revision: number;
  /** Percent of the member tasks approved, or null when the milestone has no visible member (unknown, not 0). */
  percent: number | null;
  progress: string;
  /** What the card shows as chips; a withheld member is a count, never a stub. */
  chips: { fresh: number; stale: number; unverified: number; unknownSpecs: number; trains: number; withheld: number };
  specText: string;
  issueText: string;
}

export interface RoadmapLane { id: "now" | "next" | "later"; label: string; cards: RoadmapCard[] }

export function roadmapModel(views: readonly RoadmapMilestoneInput[]): { lanes: RoadmapLane[]; cards: RoadmapCard[] } {
  const lanes: RoadmapLane[] = [
    { id: "now", label: "Now", cards: [] },
    { id: "next", label: "Next", cards: [] },
    { id: "later", label: "Later", cards: [] },
  ];
  const cards = [...views].sort((a, b) => a.order - b.order || a.id - b.id).map((view): RoadmapCard => {
    const total = view.rollup.tasks.total, approved = view.rollup.tasks.approved, specs = view.rollup.specs, issues = view.rollup.issues;
    const specParts: string[] = [];
    if (specs.fresh) specParts.push("fresh " + specs.fresh);
    if (specs.stale) specParts.push("stale " + specs.stale);
    if (specs.unverified) specParts.push("unverified " + specs.unverified);
    if (specs.unknown) specParts.push("unknown " + specs.unknown);
    const card: RoadmapCard = {
      id: view.id, title: view.title, outcome: view.outcome, state: view.state, horizon: view.horizon,
      target: typeof view.target === "string" ? view.target : "", revision: view.revision,
      percent: total > 0 ? Math.round((approved / total) * 100) : null,
      progress: total > 0 ? approved + " of " + total + " tasks approved" : "no tasks yet",
      chips: { fresh: specs.fresh, stale: specs.stale, unverified: specs.unverified, unknownSpecs: specs.unknown,
        trains: view.rollup.releases.total, withheld: view.withheld },
      specText: specParts.length ? "specs " + specParts.join(", ") : "",
      issueText: issues.total ? "issues " + issues.closed + "/" + issues.total + " closed" + (issues.unknown ? ", " + issues.unknown + " unknown" : "") : "",
    };
    // A horizon the hub does not define (an older page, an unknown row) lands in Later rather than disappearing.
    (lanes.find(lane => lane.id === view.horizon) ?? lanes[lanes.length - 1]!).cards.push(card);
    return card;
  });
  return { lanes, cards };
}
