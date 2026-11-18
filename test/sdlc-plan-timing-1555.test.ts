import { expect, test } from "bun:test";
import { taskSample, sdlcMetrics } from "../src/hub/sdlc-metrics.ts";

test("#1555 carried spec acceptance and task acceptance use distinct plan clocks", () => {
  const carried = { id: 1, history: [{ at: 10, event: "accepted" }, { at: 20, event: "spec acceptance carried" }, { at: 35, event: "plan reviewed" }] };
  const unspecced = { id: 2, history: [{ at: 10, event: "accepted" }, { at: 35, event: "plan reviewed" }] };
  expect(taskSample(carried)).toMatchObject({ acceptance_to_plan_ms: 15, accepted_to_plan_ms: null });
  expect(taskSample(unspecced)).toMatchObject({ acceptance_to_plan_ms: null, accepted_to_plan_ms: 25 });
  expect(sdlcMetrics([carried, unspecced]).metrics.accepted_to_plan_ms).toMatchObject({ n: 1, unknown: 1, mean: 25 });
});
