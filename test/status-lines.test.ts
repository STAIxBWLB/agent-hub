import { expect, test } from "bun:test";
import { backendLabel, backendLine, peerLine } from "../src/cli/status-lines.ts";

// issue #32: the label read "dgx/dgx/coding", and a Pi turn's backend was only visible in status.json.

test("a namespaced alias is printed as it is, an unnamespaced one keeps its kind", () => {
  expect(backendLabel({ kind: "dgx", alias: "dgx/coding" })).toBe("dgx/coding");
  expect(backendLabel({ kind: "mlx", alias: "mlx/fast" })).toBe("mlx/fast");
  expect(backendLabel({ kind: "dgx", alias: "coding" })).toBe("dgx/coding");
  expect(backendLabel({})).toBe("unknown/unknown");
});

test("a backend line carries the requested and actual model", () => {
  expect(backendLine({ kind: "mlx", alias: "mlx/fast", state: "ready", active: 0, requestedModel: "mlx/fast", actualModel: "/models/qwen3-8b-mlx" }))
    .toBe("  model    mlx/fast ready active 0 requested mlx/fast actual /models/qwen3-8b-mlx");
});

test("a peer line names the backend the peer asked for on its last turn", () => {
  expect(peerLine("pi", { state: "idle", queued: 0, requestedModel: "dgx/coding" })).toContain("model: dgx/coding");
  expect(peerLine("kimi", { state: "idle", queued: 0 })).toBe("  kimi     idle     queued 0");
  expect(peerLine("local", { state: "idle", queued: 0, servedBy: "switchyard sy/coding -> glm53" })).toContain("last call: switchyard sy/coding -> glm53");
  expect(peerLine("codex", { state: "paused", queued: 2, paused: "budget" })).toBe("  codex    paused   queued 2  (budget)");
});
