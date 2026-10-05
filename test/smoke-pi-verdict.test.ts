import { expect, test } from "bun:test";
import { piSmokeVerdict, PI_ROUTE_SENTINEL, type SmokeDispatch } from "../scripts/smoke-pi-verdict.ts";

function record(alias: string, outcome: SmokeDispatch["outcome"], extra: Partial<SmokeDispatch> = {}): SmokeDispatch {
  return { id: "primary-id", alias, outcome, identified: outcome === "completed", identitySource: outcome === "completed" ? "stream" : "none", durationMs: 10, ...extra };
}
const verdict = (requests: SmokeDispatch[], answer = PI_ROUTE_SENTINEL, requirePrimary = false) => piSmokeVerdict({ answer, failed: false, choices: ["mlx/fast"], requests, requirePrimary });

test("failed local primary and completed remote fallback retain linked IDs and separate verdicts", () => {
  const records = [record("mlx/fast", "failed", { dispatchGroupId: "group-id", failureClass: "startup" }), record("dgx/fast", "completed", { id: "fallback-id", dispatchGroupId: "group-id", fallbackOfId: "primary-id" })];
  expect(verdict(records)).toMatchObject({ passed: true, nativeResponse: "passed", primaryRoute: "failed", fallbackRoute: "passed", fallbackOccurred: true });
  expect(verdict(records).dispatches[1]).toMatchObject({ id: "fallback-id", fallbackOfId: "primary-id", dispatchGroupId: "group-id" });
  expect(verdict(records, PI_ROUTE_SENTINEL, true).passed).toBe(false);
});

test("primary success passes strict mode and unidentified completion stays unidentified", () => {
  const result = verdict([record("dgx/fast", "completed", { identified: false, identitySource: "none" })], PI_ROUTE_SENTINEL, true);
  expect(result).toMatchObject({ passed: true, primaryRoute: "passed", fallbackRoute: "unknown", fallbackOccurred: false });
  expect(result.dispatches[0]?.identified).toBe(false);
});

test("both failed or a cancelled dispatch never pass connectivity", () => {
  expect(verdict([record("mlx/fast", "failed"), record("dgx/fast", "failed", { id: "fallback-id", fallbackOfId: "primary-id" })])).toMatchObject({ passed: false, primaryRoute: "failed", fallbackRoute: "failed" });
  expect(verdict([record("mlx/fast", "cancelled")])).toMatchObject({ passed: false, primaryRoute: "cancelled" });
  expect(verdict([])).toMatchObject({ passed: false, primaryRoute: "unknown" });
});

test("exact sentinel rejects arbitrary surrounding text or whitespace", () => {
  const requests = [record("dgx/fast", "completed")];
  for (const answer of [`prefix ${PI_ROUTE_SENTINEL}`, `${PI_ROUTE_SENTINEL}\n`, ` ${PI_ROUTE_SENTINEL}`, `${PI_ROUTE_SENTINEL} suffix`]) expect(verdict(requests, answer).passed).toBe(false);
});

test("diagnostics project only sanitized scalar fields, never raw backend/provider text", () => {
  const secret = "https://private.example/token=secret";
  const request = record(secret, "failed", { id: secret, failureClass: secret, httpStatus: 503 });
  Object.assign(request, { lastError: secret, actualModel: secret, provider: secret, headers: { authorization: secret } });
  const result = piSmokeVerdict({ answer: secret, failed: false, choices: [secret], requests: [request] });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.dispatches[0]).toMatchObject({ alias: "unknown", httpStatus: 503 });
});
