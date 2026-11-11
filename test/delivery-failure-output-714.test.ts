import { expect, test } from "bun:test";
import { renderQueueShow, renderStatus, type StatusOutput } from "../src/cli/output.ts";
import type { Span } from "../src/cli/console-state.ts";

const now = 1_800_000_000_000;
const text = (rows: Span[][]) => rows.map(row => row.map(span => span.text).join("")).join("\n");
const normalized = (value: string) => value.replace(/\s+/g, " ");

test("status names each peer's unresolved failed count and its discard next step (#1178)", () => {
  for (const columns of [undefined, 80, 200]) {
    const rows = renderStatus({ peers: {}, deliveryFailures: { codex: 14, jcode: 120, pi: 2 } }, columns, now);
    const rendered = normalized(text(rows));
    for (const [peer, count] of [["codex", 14], ["jcode", 120], ["pi", 2]] as const) {
      expect(rendered).toContain(`${peer} failed deliveries ${count}; next: ahub queue discard --peer ${peer} --state failed`);
    }
    if (columns) for (const line of text(rows).split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
  }
});

test("status omits zero, unavailable and malformed failure counts without claiming there are none (#1178)", () => {
  const cases: StatusOutput[] = [
    { peers: {} },
    { peers: {}, deliveryFailures: {} },
    { peers: {}, deliveryFailures: { codex: 0, jcode: -1, pi: Number.NaN, kimi: 1.5 } },
    { peers: {}, deliveryError: "delivery journal unavailable" },
  ];
  for (const data of cases) {
    const rendered = text(renderStatus(data, undefined, now));
    expect(rendered).not.toContain("failed deliveries");
    expect(rendered).not.toContain("--state failed");
    expect(rendered).not.toContain("no failed");
  }
  expect(text(renderStatus({ peers: {}, deliveryError: "delivery journal unavailable" }, undefined, now))).toContain("delivery journal unavailable; dispatch is stopped");
});

test("failure-count status is metadata only and never dumps a delivery payload (#1178)", () => {
  const data = {
    peers: {},
    deliveryFailures: { codex: 1 },
    deliveries: [{ body: "PRIVATE_FAILURE_BODY_714", reason: "PRIVATE_FAILURE_REASON_714" }],
  };
  const rendered = text(renderStatus(data, undefined, now));
  expect(rendered).toContain("codex failed deliveries");
  expect(rendered).not.toContain("PRIVATE_FAILURE_BODY_714");
  expect(rendered).not.toContain("PRIVATE_FAILURE_REASON_714");
});

test("queue show presents each recorded public-safe failure class without inventing a legacy cause (#1178)", () => {
  for (const failureCause of ["peer offline", "adapter refused", "push error", "turn aborted", "timeout"]) {
    const rendered = normalized(text(renderQueueShow({ id: "d-failed", peer: "codex", state: "failed", failureCause }, undefined, now)));
    expect(rendered).toContain(`failureCause ${failureCause}`);
    expect(rendered).not.toContain("not recorded");
    expect(rendered).toContain("ahub queue resolve d-failed");
  }
  const legacy = normalized(text(renderQueueShow({ id: "d-legacy", peer: "codex", state: "failed" }, 80, now)));
  expect(legacy).toContain("failure cause unknown (not recorded by this hub version)");
  expect(legacy).not.toContain("adapter refused");
  const held = normalized(text(renderQueueShow({ id: "d-held", state: "needs_review" }, undefined, now)));
  expect(held).not.toContain("not recorded");
  expect(held).toContain("--action retry"); expect(held).toContain("use --action completed instead if the peer already handled it, or discard if it is stale"); // #1399: one runnable action, the others named
});
