import { expect, test } from "bun:test";
import { renderStatus, type StatusOutput } from "../src/cli/output.ts";

const text = (data: StatusOutput, columns?: number) => renderStatus(data, columns).map(row => row.map(span => span.text).join("")).join("\n");
test("status omits specs for absent, empty and malformed observations", () => {
  expect(text({ peers: {} })).not.toContain("specs:");
  expect(text({ peers: {}, specs: { specCount: 0, documents: 0, errors: 0, stale: 0, truncated: false, missingBlockHint: true } })).not.toContain("specs:");
  expect(text({ peers: {}, specs: { specCount: -1, documents: 0, errors: 0, stale: 0, truncated: false } })).not.toContain("specs:");
});
test("status names spec errors and stale counts and shows only the supplied hint", () => {
  const specs = { specCount: 3, documents: 2, errors: 1, stale: 2, truncated: false };
  expect(text({ peers: {}, specs })).toContain("specs: 3 (errors 1, stale 2)");
  expect(text({ peers: {}, specs })).not.toContain("instruction block");
  const output = text({ peers: {}, specs: { ...specs, truncated: true, missingBlockHint: true } }, 80);
  expect(output).toContain("narrow specs.roots"); expect(output).toContain("AGENTS.md has no specs instruction block");
  expect(output.split("\n").every(line => Bun.stringWidth(line) <= 80)).toBe(true);
});
test("status includes stamped documents even when there are no spec nodes", () => {
  expect(text({ peers: {}, specs: { specCount: 0, documents: 2, errors: 0, stale: 1, truncated: false } })).toContain("specs: 0 (errors 0, stale 1)");
});
