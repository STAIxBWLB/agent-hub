import { expect, test } from "bun:test";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
import { ROADMAP_FORMS, parseRoadmapArgs, renderRoadmap } from "../src/cli/roadmap.ts";

// R3 (#1481): argv for the bottom-up commands. Parsing refuses before any connection, and authority is closed per form.
test("unplaced, triage, accept, reject and import-github parse to their closed ops", () => {
  expect(parseRoadmapArgs(["unplaced"])).toEqual({ op: "hub_roadmap_unplaced", args: {}, json: false });
  expect(parseRoadmapArgs(["unplaced", "--repo", "Example/Repo", "--json"])).toEqual({ op: "hub_roadmap_unplaced", args: { repo: "example/repo" }, json: true });
  expect(parseRoadmapArgs(["--json", "unplaced", "--repo=o/r"]).args).toEqual({ repo: "o/r" });
  expect(parseRoadmapArgs(["triage"])).toEqual({ op: "hub_roadmap_triage", args: {}, json: false });
  expect(parseRoadmapArgs(["triage", "--list", "--repo", "o/r"]).args).toEqual({ repo: "o/r", list: true });
  expect(parseRoadmapArgs(["accept", "12"])).toEqual({ op: "hub_roadmap_edit", args: { op: "accept", suggestion: 12 }, json: false });
  expect(parseRoadmapArgs(["reject", "3"]).args).toEqual({ op: "reject", suggestion: 3 });
  expect(parseRoadmapArgs(["import-github"])).toEqual({ op: "roadmap_import_github", args: {}, json: false });
  expect(parseRoadmapArgs(["import-github", "--apply", "--repo", "o/r", "--json"])).toEqual({ op: "roadmap_import_github", args: { repo: "o/r", apply: true }, json: true });
});

test("the new commands refuse unknown, duplicate, misplaced and malformed input before connecting", () => {
  const invalid = [
    ["unplaced", "extra"], ["unplaced", "--repo"], ["unplaced", "--repo", "not a repo"], ["unplaced", "--repo", "-x/y"], ["unplaced", "--repo", "o/r", "--repo", "o/r"],
    ["unplaced", "--apply"], ["unplaced", "--list"], ["unplaced", "--json", "--json"],
    ["triage", "--apply"], ["triage", "--list", "--list"], ["triage", "7"],
    ["accept"], ["accept", "0"], ["accept", "01"], ["accept", "x"], ["accept", "1", "2"], ["accept", "1", "--json"], ["accept", "--repo", "o/r"],
    ["reject"], ["reject", "-1"], ["reject", "1", "--list"],
    ["import-github", "--list"], ["import-github", "--apply", "--apply"], ["import-github", "2"], ["import-github", "--unknown"],
  ];
  for (const argv of invalid) expect(() => parseRoadmapArgs(argv), argv.join(" ")).toThrow("roadmap");
});

test("import-github is the person's alone, and the delegated forms are refused (AC4 authority)", () => {
  for (const argv of [["import-github"], ["import-github", "--apply"], ["--json", "import-github"]]) {
    expect(classifyPeerCommand("roadmap", argv)).toBe("console");
    expect(liveTestRefusal("roadmap", argv)).toBe(true);
  }
  // Triage, accept and reject are the planner's tools, so an agent shell keeps its peer identity; live-test cannot delegate any write.
  for (const sub of ["unplaced", "triage", "accept", "reject"]) expect(classifyPeerCommand("roadmap", [sub, "1"])).toBe("allowed");
  for (const sub of ["triage", "accept", "reject"]) expect(liveTestRefusal("roadmap", [sub, "1"])).toBe(true);
  expect(liveTestRefusal("roadmap", ["unplaced"])).toBe(true);
  for (const sub of ["unplaced", "triage", "accept", "reject", "import-github"]) {
    const canary = "PRIVATE_ARGUMENT_CANARY";
    expect(cliCommandLabel("roadmap", [sub, canary])).toBe(`roadmap ${sub}`);
    expect(cliCommandLabel("roadmap", ["--json", sub, canary])).toBe(`roadmap ${sub}`);
  }
});

test("every new form is listed in the usage text", () => {
  for (const form of [ROADMAP_FORMS.unplaced, ROADMAP_FORMS.triage, ROADMAP_FORMS.accept, ROADMAP_FORMS.reject, ROADMAP_FORMS.importGithub]) expect(form.length).toBeGreaterThan(5);
  expect(() => parseRoadmapArgs(["nonsense"])).toThrow(ROADMAP_FORMS.importGithub);
});

const unplaced = {
  repo: "o/r", partial: true, unavailable: ["specs"], privateTasks: 2, more: { issues: 0, tasks: 1, specs: 0 },
  issues: [{ ref: "o/r#5", title: "Fix start", reason: "open issue: no milestone links it" }],
  tasks: [{ id: 7, title: "Add export", state: "proposed", reason: "open task: no explicit link" }], specs: [],
};
test("unplaced renders each item with its reason, the partial and unavailable notes and the private count", () => {
  const out = renderRoadmap(unplaced);
  expect(out).toContain("Unplaced work (o/r)");
  expect(out).toContain("Partial: the GitHub read stopped early");
  expect(out).toContain("Unavailable: specs could not be read");
  expect(out).toContain("o/r#5: Fix start"); expect(out).toContain("why: open issue: no milestone links it");
  expect(out).toContain("#7 Add export (proposed)"); expect(out).toContain("1 more");
  expect(out).toContain("Private tasks counted, not listed: 2");
  expect(() => JSON.parse(out)).toThrow();
});

test("triage renders the cited words and the exact accept and reject commands, and says nothing is linked yet", () => {
  const out = renderRoadmap({ asked: 2, dropped: 1, partial: false, unavailable: null, suggestions: [
    { id: 4, kind: "task", ref: "7", milestone: 1, proposal: null, citeItem: "roadmap export", citeMilestone: "export the roadmap", state: "pending" },
    { id: 5, kind: "issue", ref: "o/r#5", milestone: null, proposal: { title: "Reliability", outcome: "Stable" }, citeItem: "flaky start", citeMilestone: null, state: "pending" },
  ] });
  expect(out).toContain("Triage suggestions (2)");
  expect(out).toContain("#4 task 7 -> milestone 1"); expect(out).toContain('item words: "roadmap export"'); expect(out).toContain('milestone words: "export the roadmap"');
  expect(out).toContain("#5 issue o/r#5 -> new milestone: Reliability");
  expect(out).toContain("apply: ahub roadmap accept 4   drop: ahub roadmap reject 4");
  expect(out).toContain("1 model answer dropped as unsupported");
  expect(renderRoadmap({ suggestions: [] })).toContain("Nothing is linked until you run ahub roadmap accept");
  expect(renderRoadmap({ asked: 0, dropped: 0, unavailable: "no hub model is configured for roadmap triage", suggestions: [] })).toContain("Triage unavailable: no hub model");
});

test("import-github renders a dry run with how to apply, and an applied run with counts and withheld milestones", () => {
  const rows = [{ number: 2, title: "Beta", milestone: null, action: "create", issues: ["o/r#10", "o/r#11"], newLinks: 2 }];
  const dry = renderRoadmap({ repo: "o/r", apply: false, partial: false, milestones: rows, created: 0, linked: 0, withheld: 0 });
  expect(dry).toContain("dry run, nothing written; add --apply"); expect(dry).toContain("GitHub #2 Beta: would create; 2 issues, 2 new links");
  const applied = renderRoadmap({ repo: "o/r", apply: true, partial: true, milestones: [{ ...rows[0], milestone: 9, action: "exists", newLinks: 0 }], created: 1, linked: 2, withheld: 1 });
  expect(applied).toContain("applied"); expect(applied).toContain("already imported as milestone 9"); expect(applied).toContain("Created 1 milestone, linked 2 issues.");
  expect(applied).toContain("Partial: the GitHub read stopped early"); expect(applied).toContain("Withheld 1 milestone");
});

test("a milestone view shows ready to close for the person, with the reasons when it is not", () => {
  const base = { id: 4, title: "T", state: "active", horizon: "now", order: 0, revision: 1, outcome: "o", rollup: {}, tasks: [], links: [] };
  const ready = renderRoadmap({ ...base, readyToClose: { ready: true, reasons: [] }, tree: { children: 0 } });
  expect(ready).toContain("Ready to close"); expect(ready).toContain("ahub roadmap state 4 done");
  const notYet = renderRoadmap({ ...base, readyToClose: { ready: false, reasons: ["1 task not approved", "2 issues open"] }, tree: { children: 2, tasks: { approved: 1, total: 3 }, issues: { closed: 0, total: 2 }, releases: { shipped: 0, total: 0 } } });
  expect(notYet).toContain("Not ready to close: 1 task not approved; 2 issues open");
  expect(notYet).toContain("With children (2): tasks 1/3, issues 0/2");
  expect(renderRoadmap(base)).not.toContain("ready to close");
});

test("the new renderers keep to 80 and 200 columns with wide text and strip escapes", () => {
  const unsafe = String.fromCharCode(27) + "[31m";
  const wide = { ...unplaced, issues: [{ ref: "o/r#5", title: unsafe + "한글 title ".repeat(30), reason: "open issue: no milestone links it ".repeat(4) }] };
  for (const columns of [80, 200]) {
    const out = renderRoadmap(wide, columns);
    expect(out.split("\n").every(line => Bun.stringWidth(line) <= columns)).toBe(true);
    expect(out).not.toContain(String.fromCharCode(27));
  }
});
