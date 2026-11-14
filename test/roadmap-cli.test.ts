import { expect, test } from "bun:test";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
import { parseRoadmapArgs, renderRoadmap } from "../src/cli/roadmap.ts";

test("roadmap parses reads, optional default list and explicit JSON", () => {
  expect(parseRoadmapArgs([])).toEqual({ op: "hub_roadmap_list", args: {}, json: false });
  expect(parseRoadmapArgs(["--json"])).toEqual({ op: "hub_roadmap_list", args: {}, json: true });
  expect(parseRoadmapArgs(["list", "--json"])).toEqual({ op: "hub_roadmap_list", args: {}, json: true });
  expect(parseRoadmapArgs(["show", "12", "--json"])).toEqual({ op: "hub_roadmap_show", args: { id: 12 }, json: true });
  expect(parseRoadmapArgs(["--json", "show", "12"])).toEqual({ op: "hub_roadmap_show", args: { id: 12 }, json: true });
});

test("roadmap audit labels contain only closed command names and person states cannot be delegated", () => {
  const canary = "PRIVATE_ROADMAP_ARGUMENT_CANARY";
  for (const op of ["list", "show", "new", "edit", "link", "unlink", "order", "state"]) {
    expect(cliCommandLabel("roadmap", [op, "42", canary])).toBe(`roadmap ${op}`);
    expect(cliCommandLabel("roadmap", [op, "42", canary])).not.toContain(canary);
    if (!["list", "show"].includes(op)) expect(liveTestRefusal("roadmap", [op, "42", canary])).toBe(true);
  }
  expect(cliCommandLabel("roadmap", ["future", canary])).toBe("roadmap");
  expect(classifyPeerCommand("roadmap", ["list", "--as-user"])).toBe("console");
  for (const state of ["done", "dropped"]) expect(classifyPeerCommand("roadmap", ["state", "42", state])).toBe("console");
});

test("new/edit preserve text values and consume text that looks like a presentation option", () => {
  const title = "  제주 roadmap  ", outcome = 'Keep "--json" and --full as words';
  expect(parseRoadmapArgs(["new", "--title", title, `--outcome=${outcome}`, "--horizon", "now", "--order=0", "--parent", "2", "--target", "2028-02-29"])).toEqual({
    op: "hub_roadmap_edit", json: false,
    args: { op: "new", fields: { title, outcome, horizon: "now", order: 0, parent: 2, target: "2028-02-29" } },
  });
  expect(parseRoadmapArgs(["new", "--title", "--json", "--outcome", "Literal flag title"]).args).toEqual({ op: "new", fields: { title: "--json", outcome: "Literal flag title" } });
  expect(parseRoadmapArgs(["edit", "2", "--revision=3", "--target", "none", "--parent=none"]).args).toEqual({ op: "edit", id: 2, revision: 3, fields: { target: null, parent: null } });
});

test("roadmap parses closed link, unlink, order and state operations", () => {
  expect(parseRoadmapArgs(["link", "2", "issue", "Example/Repo#42"]).args).toEqual({ op: "link", id: 2, kind: "issue", ref: "example/repo#42" });
  expect(parseRoadmapArgs(["unlink", "2", "task", "3"]).args).toEqual({ op: "unlink", id: 2, kind: "task", ref: "3" });
  expect(parseRoadmapArgs(["order", "2", "0"]).args).toEqual({ op: "order", id: 2, order: 0 });
  expect(parseRoadmapArgs(["state", "2", "done"]).args).toEqual({ op: "state", id: 2, state: "done" });
});

test("roadmap refuses unknown, duplicate, missing and unused operands before connection", () => {
  const invalid = [
    ["unknown"], ["show"], ["show", "1", "extra"], ["list", "extra"], ["list", "--json", "--json"], ["list", "--json=true"],
    ["show", "01"], ["show", "9007199254740992"], ["new", "--title", "T"],
    ["new", "--title", "T", "--outcome", "O", "--unknown", "X"],
    ["new", "--title", "T", "--outcome", "O", "--title", "Other"],
    ["new", "--title", "T", "--outcome", "O", "--json"],
    ["new", "--title", "T", "--outcome", "O", "--state", "done"],
    ["new", "--title", "T", "--outcome", "O", "extra"],
    ["new", "--title", "T", "--outcome", "O", "--target", "2026-02-29"],
    ["edit", "1", "--title", "T"], ["edit", "1", "--revision", "0"],
    ["link", "1", "issue", "#42"], ["link", "1", "unknown", "x"], ["unlink", "1", "task", "2", "extra"],
    ["order", "1", "-1"], ["order", "1", "2", "--json"], ["state", "1", "shipped"], ["state", "1", "done", "-h"],
  ];
  for (const argv of invalid) expect(() => parseRoadmapArgs(argv)).toThrow();
});

const view = {
  id: 4, title: "Roadmap outcome", outcome: "Visible progress without inventing evidence", state: "active", horizon: "now", order: 2, revision: 3, target: "2026-12-01", parent: null,
  links: [{ kind: "issue", ref: "example/repo#42" }],
  tasks: [{ id: 8, title: "Imported work", state: "in_progress", placement: { rule: "source-issue", issue: "example/repo#42" } }],
  withheld: 1,
  rollup: { tasks: { approved: 1, total: 2 }, issues: { closed: null, total: 1, unknown: 1 }, specs: { fresh: 0, stale: 1, unverified: 0, unknown: 1, total: 2 }, releases: { shipped: null, total: 1, unknown: 1 } },
};

test("roadmap renders a human view by default and keeps unknown totals unknown", () => {
  const output = renderRoadmap(view);
  expect(output).toContain("Milestone 4: Roadmap outcome");
  expect(output).toContain("Tasks approved: 1/2");
  expect(output).toContain("issues closed: unknown/1");
  expect(output).toContain("Releases shipped: unknown/1");
  expect(output).toContain("inherited from example/repo#42");
  expect(output).toContain("Private tasks withheld: 1");
  expect(() => JSON.parse(output)).toThrow();
  expect(renderRoadmap({ id: 4 })).toContain("unknown/unknown");
  expect(renderRoadmap({ milestones: [] })).toContain("No milestones recorded.");
  expect(renderRoadmap(null)).toContain("unavailable");
  expect(renderRoadmap("The hub refused this read")).toBe("The hub refused this read");
});

test("roadmap stays within 80/200 columns with Unicode and emits plain sanitized text", () => {
  const unsafe = String.fromCharCode(27) + "[31m";
  const wide = { ...view, title: unsafe + "한글 roadmap ".repeat(20), outcome: "Long outcome ".repeat(30) };
  for (const columns of [80, 200]) {
    const output = renderRoadmap({ milestones: [wide] }, columns);
    expect(output.split("\n").every(line => Bun.stringWidth(line) <= columns)).toBe(true);
    expect(output).not.toContain(String.fromCharCode(27));
    expect(output).toContain("example/repo#42");
  }
  expect(renderRoadmap(JSON.stringify(view), 200)).toContain("Milestone 4");
});
