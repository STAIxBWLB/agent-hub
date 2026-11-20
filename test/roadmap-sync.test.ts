import { expect, test } from "bun:test";
import { planRoadmapMirror, recoverMirrorBinding } from "../src/hub/roadmap-sync.ts";

test("recovery binds only an unambiguous marker, never a matching title", () => {
  const marker = "<!-- ahub-roadmap:project:4 -->";
  const row = { number: 8, title: "Outcome", description: null };
  expect(recoverMirrorBinding(marker, "Outcome", [])).toEqual({ kind: "create", titleConflicts: [] });
  expect(recoverMirrorBinding(marker, "Outcome", [row])).toEqual({ kind: "create", titleConflicts: [8] });
  expect(recoverMirrorBinding(marker, "Outcome", [{ ...row, description: marker }])).toEqual({ kind: "bind", number: 8, titleConflicts: [] });
  expect(recoverMirrorBinding(marker, "Outcome", [{ ...row, description: marker }, { ...row, number: 2, description: marker }])).toEqual({ kind: "ambiguous", numbers: [2, 8], titleConflicts: [] });
  expect(() => recoverMirrorBinding("", "Outcome", [row])).toThrow("invalid roadmap marker");
});

test("new milestone preview contains creation only, with a separately bound membership preview", () => {
  const desired = { title: "Outcome", state: "open" as const, issues: [4] };
  const create = planRoadmapMirror("example/repo", desired, null, []);
  expect(create.calls).toEqual([["api", "repos/example/repo/milestones", "--method", "POST", "-f", "title=Outcome", "-f", "state=open"]]);
  const next = planRoadmapMirror("example/repo", desired, { number: 7, title: "Outcome", state: "open" }, [{ number: 4, milestone: null }]);
  expect(next.calls).toEqual([["api", "repos/example/repo/issues/4", "--method", "PATCH", "-F", "milestone=7"]]);
  expect(next.fingerprint).not.toBe(create.fingerprint);
  expect(planRoadmapMirror("example/repo", desired, { number: 7, title: "Outcome", state: "open" }, [{ number: 4, milestone: 7 }]).calls).toEqual([]);
});

test("incomplete or duplicate remote membership cannot become a write plan", () => {
  const desired = { title: "Outcome", state: "open" as const, issues: [4] };
  const remote = { number: 7, title: "Outcome", state: "open" as const };
  expect(() => planRoadmapMirror("example/repo", desired, remote, [])).toThrow("incomplete");
  expect(() => planRoadmapMirror("example/repo", desired, remote, [{ number: 4, milestone: null }, { number: 4, milestone: null }])).toThrow("duplicate");
});
