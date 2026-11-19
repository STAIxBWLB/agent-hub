import { expect, test } from "bun:test";
import { QuotaEventFilter, QUOTA_HEARTBEAT_MS } from "../src/hub/quota-events.ts";
import { buildResearchQuality } from "../src/hub/research-quality.ts";
import type { HubEvent, StampedEvent } from "../src/hub/events.ts";

const MINUTE = 60_000, BASE = Date.UTC(2026, 0, 1);
type Quota = Extract<HubEvent, { type: "quota" }>;
const windows = [{ id: "5h", used: 0.2, resetsAt: BASE + 500 * MINUTE }];

test("#1555 quota rows preserve gaps, interval bounds, clean stop and restart", () => {
  for (const silence of [14, 15, 50, 70]) {
    let now = BASE;
    const raw: StampedEvent[] = [], saved: StampedEvent[] = [];
    const emit = (event: Quota) => saved.push({ ...event, v: 1, at: new Date(now).toISOString() });
    let filter = new QuotaEventFilter(emit);
    const read = (minute: number, peer = "codex") => {
      now = BASE + minute * MINUTE;
      raw.push({ type: "quota", peer, windows, hard: false, v: 1, at: new Date(now).toISOString(), measuredAt: new Date(now).toISOString() });
      filter.record(peer, windows, false, now);
    };
    read(0); read(5); read(10); read(10 + silence); read(15 + silence);
    filter.flush();
    filter = new QuotaEventFilter(emit);
    read(20 + silence); read(25 + silence); filter.flush();
    const before = buildResearchQuality([], raw).quota.codex!, after = buildResearchQuality([], saved).quota.codex!;
    expect({ gaps: after.gaps, gapMs: after.gapMs }).toEqual({ gaps: before.gaps, gapMs: before.gapMs });
    const rawTimes = raw.map(row => Date.parse((row as Quota).measuredAt!));
    const savedTimes = saved.map(row => Date.parse((row as Quota).measuredAt!)).sort((a, b) => a - b);
    for (let i = 1; i < savedTimes.length; i++) {
      const a = savedTimes[i - 1]!, b = savedTimes[i]!, gap = b - a;
      const original = rawTimes.some((time, index) => time === a && rawTimes[index + 1] === b);
      expect(gap < 2 * QUOTA_HEARTBEAT_MS || (original && gap >= QUOTA_HEARTBEAT_MS)).toBe(true);
    }
  }
});

test("#1555 another peer flushes the pending family reading before a silence", () => {
  let now = BASE;
  const saved: StampedEvent[] = [], raw: StampedEvent[] = [];
  const filter = new QuotaEventFilter(event => saved.push({ ...event, v: 1, at: new Date(now).toISOString() }));
  for (const [minute, peer] of [[0, "codex"], [10, "codex"], [70, "codex-review"]] as const) {
    now = BASE + minute * MINUTE;
    raw.push({ type: "quota", peer, windows, hard: false, v: 1, at: new Date(now).toISOString(), measuredAt: new Date(now).toISOString() });
    filter.record(peer, windows, false, now);
  }
  const family = () => "codex";
  expect(saved).toHaveLength(3);
  expect(buildResearchQuality([], saved, {}, family).quota.codex).toMatchObject({ gaps: 0, gapMs: 0 });
  expect(buildResearchQuality([], saved, {}, family).quota.codex?.gaps).toBe(buildResearchQuality([], raw, {}, family).quota.codex?.gaps);
});

test("#1555 hard, window, reset and material usage changes emit immediately", () => {
  const rows: Quota[] = [], filter = new QuotaEventFilter(row => rows.push(row));
  filter.record("codex", windows, false, BASE);
  filter.record("codex", windows, false, BASE + MINUTE);
  expect(rows).toHaveLength(1);
  filter.record("codex", [{ ...windows[0]!, used: 0.21 }], false, BASE + 2 * MINUTE);
  filter.record("codex", [{ ...windows[0]!, used: 0.21 }], true, BASE + 3 * MINUTE);
  filter.record("codex", [{ ...windows[0]!, used: 0.21, resetsAt: BASE + 501 * MINUTE }], true, BASE + 4 * MINUTE);
  filter.record("codex", [{ id: "week", used: 0.21 }], true, BASE + 5 * MINUTE);
  expect(rows).toHaveLength(5);
});

test("#1555 the used delta boundary and each peer's first reading are recorded", () => {
  const rows: Quota[] = [], filter = new QuotaEventFilter(row => rows.push(row));
  filter.record("codex", windows, false, BASE);
  filter.record("codex", [{ ...windows[0]!, used: 0.204 }], false, BASE + MINUTE);
  expect(rows).toHaveLength(1);
  filter.record("codex", [{ ...windows[0]!, used: 0.205 }], false, BASE + 2 * MINUTE);
  expect(rows).toHaveLength(2);
  filter.record("codex-review", windows, false, BASE + 3 * MINUTE);
  expect(rows).toHaveLength(3);
});

test("#1555 a late flushed reading outside a quality window stays outside", () => {
  let now = BASE;
  const saved: StampedEvent[] = [], raw: StampedEvent[] = [];
  const filter = new QuotaEventFilter(event => saved.push({ ...event, v: 1, at: new Date(now).toISOString() }));
  for (const [minute, peer] of [[0, "codex"], [10, "codex"], [80, "codex-review"]] as const) {
    now = BASE + minute * MINUTE;
    raw.push({ type: "quota", peer, windows, hard: false, v: 1, at: new Date(now).toISOString(), measuredAt: new Date(now).toISOString() });
    filter.record(peer, windows, false, now);
  }
  const family = () => "codex", window = { since: BASE + 60 * MINUTE };
  const before = buildResearchQuality([], raw, window, family).quota.codex!;
  const after = buildResearchQuality([], saved, window, family).quota.codex!;
  expect({ readings: after.readings, gaps: after.gaps, gapMs: after.gapMs }).toEqual({ readings: before.readings, gaps: before.gaps, gapMs: before.gapMs });
});
