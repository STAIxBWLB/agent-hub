import { expect, test } from "bun:test";
import { diagnoseStageResult } from "../src/models/route/stage-diagnostics.ts";
const result = (text: string, error = false, family: "read" | "mutation" | "other" = "other") => ({ text, error, family, associated: true });
test("separate reported, exception and critical diagnostics without elevating successful quoted reads", () => {
  expect(diagnoseStageResult(result("3 failed, 8 passed")).fault).toBe("reported");
  expect(diagnoseStageResult(result("ReferenceError: synthetic symbol missing", true)).fault).toBe("exception");
  expect(diagnoseStageResult(result("fatal: synthetic allocation refused", true)).fault).toBe("critical");
  expect(diagnoseStageResult(result("documentation says fatal: is an example", false, "read")).fault).toBe("none");
  expect(diagnoseStageResult(result("MemoryError: 4 tests failed", true)).fault).toBe("critical");
  expect(diagnoseStageResult(result("18 passed, 0 failed")).test).toBe("pass");
});
test("repetition keys are local, stable for retry counters and separate for distinct failure text", () => {
  const first = diagnoseStageResult(result("build failed at attempt 12"));
  const second = diagnoseStageResult(result("build failed at attempt 13"));
  expect(first.fingerprint).toBe(second.fingerprint);
  expect(first.fingerprint).not.toBe(diagnoseStageResult(result("copy failed on fixture")).fingerprint);
});

test("zero-failure pass summaries stay successful, while explicit error and critical diagnostics win", () => {
  expect(diagnoseStageResult(result("18 passed, 0 failed"))).toEqual({ fault: "none", test: "pass" });
  expect(diagnoseStageResult(result("6 pass, 0 fail"))).toEqual({ fault: "none", test: "pass" });
  expect(diagnoseStageResult(result("18 passed, 0 failed", true)).fault).toBe("reported");
  expect(diagnoseStageResult(result("MemoryError: 18 passed, 0 failed", true)).fault).toBe("critical");
  expect(diagnoseStageResult(result("18 passed, 0 failed; copy failed"))).toMatchObject({ fault: "reported", test: "none" });
});
