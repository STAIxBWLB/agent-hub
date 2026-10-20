import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assign, parseOverlay, parseRouting } from "../src/hub/routing.ts";

const base = '[local]\nfixed_model = "coding"\n';
const stage = '[hub_routes."hub/stage"]\ntype = "stage"\nefficient = "fast"\ncapable = "coding"\n';

test("#553 retired target and route tables load as diagnostics without executable dictionaries", () => {
  const routing = parseRouting(base + `
[targets.old]
id = "retired/provider-model"
[routes."sy/coding"]
type = "stage_router"
efficient_target = "old"
capable_target = "old"
`);
  expect(routing.local.fixed_model).toBe("coding");
  expect(routing).not.toHaveProperty("targets");
  expect(routing).not.toHaveProperty("routes");
  const retired = (routing as { retired?: string[] }).retired ?? [];
  expect(retired).toHaveLength(2);
  expect(retired.find(line => line.includes("[targets]"))).toMatch(/gateway alias/i);
  const routes = retired.find(line => line.includes("[routes]"));
  expect(routes).toContain("hub_routes");
  expect(routes).toContain("stage");
  expect(routes).toContain("fixed_model");
  expect(routes).toContain("escalation");
});

test("#553 a retired sy route in an existing local overlay still loads without its retired table", () => {
  const shared = base + '[classes.implement]\npeers = ["local"]\n' + stage;
  const overlay = parseOverlay('[classes.implement]\nroute = "sy/previously-declared"\n');
  const routing = parseRouting(shared, overlay);
  expect(routing.classes.implement?.route).toBe("sy/previously-declared");
  expect(routing.sources?.["classes.implement.route"]).toBe("routing.local.toml");
  expect(routing.retired?.join("\n")).toContain("non-hub route");
  const assignment = assign({ class: "implement", signals: [] }, { local: "idle" }, routing);
  expect(assignment).toMatchObject({ owner: "local", fixedModel: "coding" });
});

test("#553 a class fixed_model without a route bypasses the global hub route in assignment and its trace", () => {
  const routing = parseRouting('[local]\nroute = "hub/stage"\nfixed_model = "coding"\n' + `
[classes.bulk_edit]
peers = ["local"]
fixed_model = "fast"
[classes.test]
peers = ["local"]
[classes.implement]
peers = ["local"]
route = "hub/explicit"
fixed_model = "fallback"
` + stage + '[hub_routes."hub/explicit"]\ntype = "stage"\n');
  const direct = assign({ class: "bulk_edit", signals: [] }, { local: "idle" }, routing);
  expect(direct).toMatchObject({ owner: "local", fixedModel: "fast" });
  expect(direct.route).toBeUndefined();
  expect(direct.trace).toContain("route: (none), fixed_model fast");
  expect(assign({ class: "test", signals: [] }, { local: "idle" }, routing).route).toBe("hub/stage");
  expect(assign({ class: "implement", signals: [] }, { local: "idle" }, routing)).toMatchObject({ route: "hub/explicit", fixedModel: "fallback" });
});

test("#553 the shipped template uses hub routes and direct fast aliases without legacy settings", () => {
  const text = readFileSync(new URL("../templates/routing.toml", import.meta.url), "utf8");
  expect(text).not.toContain("sy/");
  expect(text).not.toMatch(/\[(?:targets|routes)(?:\.|\])/);
  const routing = parseRouting(text);
  expect(routing.local).toMatchObject({ route: "hub/stage", fixed_model: "coding" });
  expect(routing.classes.implement?.route).toBe("hub/stage");
  for (const name of ["bulk_edit", "test", "summarize", "triage"] as const) {
    expect(routing.classes[name]?.fixed_model).toBe("fast");
    expect(routing.classes[name]?.route).toBeUndefined();
    expect(assign({ class: name, signals: [] }, { local: "idle" }, routing)).toMatchObject({ owner: "local", fixedModel: "fast" });
    expect(assign({ class: name, signals: [] }, { local: "idle" }, routing).route).toBeUndefined();
  }
  for (const route of [routing.local.route, ...Object.values(routing.classes).map(policy => policy.route)].filter((route): route is string => !!route)) {
    expect(route.startsWith("hub/")).toBe(true);
    expect(routing.hub_routes).toHaveProperty(route);
  }
  expect((routing as { retired?: string[] }).retired ?? []).toEqual([]);
});


test("#553 retired table extensions are not interpreted as active routing options", () => {
  const routing = parseRouting(base + '[targets.old.extension]\nstay_switch="retired-vendor-option"\n[routes."sy/old".extension]\nmax_switch_prefill_tokens=-1\n');
  expect(routing.stay_switch).toBe("shadow");
  expect(routing.max_switch_prefill_tokens).toBeGreaterThan(0);
  expect(routing.retired).toHaveLength(2);
});


test("#553 arbitrary legacy route ids survive the overlay and use the fixed fallback", () => {
  const routing = parseRouting(base + '[classes.implement]\npeers=["local"]\n[routes.coding]\ntype="passthrough"\n', parseOverlay('[classes.implement]\nroute="coding"\n'));
  expect(routing.classes.implement?.route).toBe("coding");
  expect(assign({ class: "implement", signals: [] }, { local: "idle" }, routing)).toMatchObject({ owner: "local", fixedModel: "coding" });
});
