import { describe, expect, test } from "bun:test";
import {
  CONTROL_WRITE_MAX_LINE_BYTES, CONTROL_WRITE_REQUEST_MAX_AGE_MS, ControlWriteTelemetry, controlWriteMetadata, controlWriteSpan,
} from "../src/hub/control-write-trace.ts";

const record = (line: string): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>;

describe("control write telemetry", () => {
  test("input screening is one-shot and is skipped when an observation cannot be traced", async () => {
    let clock = 0, screens = 0, privacyReads = 0;
    const lines: string[] = [];
    const inputPublic = () => { screens++; return true; };
    const privacyCurrent = () => { privacyReads++; return true; };
    const stopped = new ControlWriteTelemetry({ emit: () => {}, now: () => clock });
    stopped.stop();
    expect(stopped.observe("external", privacyCurrent, () => "stopped result", inputPublic)).toBe("stopped result");
    expect([screens, privacyReads]).toEqual([0, 0]);

    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock, maxActiveRequests: 1 });
    let release!: () => void;
    const pending = telemetry.run({ kind: "hub_review" }, privacyCurrent, () => new Promise<void>(resolve => { release = resolve; }));
    const beforeFull = privacyReads;
    expect(telemetry.observe("external", privacyCurrent, () => "full result", inputPublic)).toBe("full result");
    expect([screens, privacyReads]).toEqual([0, beforeFull]);
    release(); await pending;

    telemetry.run({ kind: "hub_task_done" }, privacyCurrent, () => {
      telemetry.observe("external", () => false, () => {});
      expect(telemetry.observe("external", privacyCurrent, () => "private result", inputPublic)).toBe("private result");
    });
    expect(screens).toBe(0);

    telemetry.observe("external", privacyCurrent, () => { clock += 1600; return "public result"; }, inputPublic);
    expect(screens).toBe(1);
    expect(lines.map(record).some(row => row.type === "control_write_slow")).toBe(true);
    telemetry.start();
    try {
      clock += 500; telemetry.sample();
      expect(screens).toBe(1); // Late privacy checks retain only the live guard, never the input screen.
      expect(privacyReads).toBeGreaterThan(beforeFull);
    } finally { telemetry.stop(); }
  });

  for (const sweep of ["probe", "admission"] as const) test(`${sweep} expires unanswered diagnostics without cancelling their eventual result`, async () => {
    let clock = 0;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock, maxActiveRequests: 2 });
    telemetry.sample(); // Set the delayed probe's expected tick before the recorded synchronous interval.
    let resolve!: (value: string) => void, reject!: (error: Error) => void;
    const eventualError = new Error("eventual operation failure");
    const pendingValue = telemetry.run({ kind: "hub_task_propose", task: 17 }, () => true, () => {
      controlWriteSpan("board-write", () => { clock += 200; });
      return controlWriteSpan("memory", () => new Promise<string>(done => { resolve = done; }));
    });
    const pendingError = telemetry.run({ kind: "hub_review", task: 18 }, () => true,
      () => controlWriteSpan("external", () => new Promise<void>((_, fail) => { reject = fail; })));
    const rejected = pendingError.catch(error => error); // Observe rejection before any teardown or completion.
    expect(telemetry.status()).toMatchObject({ active: 2, activeSpans: 2, expiredRequests: 0 });
    clock += CONTROL_WRITE_REQUEST_MAX_AGE_MS;
    if (sweep === "probe") telemetry.sample();
    expect(telemetry.run({ kind: "hub_task_accept" }, () => true, () => "new result")).toBe("new result");
    expect(telemetry.status()).toMatchObject({ active: 0, activeSpans: 0, expiredRequests: 2, droppedActive: 0, droppedSpans: 0, droppedRecent: 0, completedRequests: 1 });
    telemetry.start();
    try {
      clock += 500; telemetry.sample();
      expect(lines.map(record).flatMap(row => row.spans ?? []).some((span: any) => span.task === 17 || span.task === 18)).toBe(false);
      const priorLines = lines.length;
      resolve("original operation result"); reject(eventualError);
      expect(await pendingValue).toBe("original operation result");
      expect(await rejected).toBe(eventualError);
      expect(lines).toHaveLength(priorLines);
      expect(telemetry.status()).toMatchObject({ expiredRequests: 2, completedRequests: 1, slowRequests: 0 });
    } finally { telemetry.stop(); }
  });

  test("extracts only a closed request kind and safe task number", () => {
    expect(controlWriteMetadata({ t: "task", op: "hub_task_propose", rid: 9, peer: "claude", requestId: "secret-id", args: { id: 7, title: "PRIVATE title" } }))
      .toEqual({ kind: "hub_task_propose", task: 7 });
    expect(controlWriteMetadata({ t: "task", op: "hub_task_assign", args: { id: 8, peer: "codex" } })).toEqual({ kind: "hub_task_assign", task: 8 });
    expect(controlWriteMetadata({ t: "delivery_complete", deliveryId: "secret-delivery", generation: 5 })).toEqual({ kind: "hub_delivery_done" });
    expect(controlWriteMetadata({ t: "task", op: "hub_task_done", args: { id: "7", summary: "PRIVATE summary" } })).toEqual({ kind: "hub_task_done" });
    expect(controlWriteMetadata({ t: "task", op: "hub_checkpoint", args: { id: 7 } })).toBeUndefined();
    expect(controlWriteMetadata({ t: "task", op: "task_assign", args: { id: Number.MAX_SAFE_INTEGER + 1 } })).toEqual({ kind: "task_assign" });
    const hostile = Object.defineProperty({ t: "task" }, "op", { get() { throw new Error("must not read accessor"); } });
    expect(controlWriteMetadata(hostile)).toBeUndefined();
    for (const op of ["toString", "constructor", "__proto__"]) expect(controlWriteMetadata({ t: "task", op })).toBeUndefined();
  });

  test("records nested synchronous and asynchronous phases without changing the result", async () => {
    let clock = 0;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    const result = await telemetry.run({ kind: "hub_task_done", task: 12 }, () => true, async () => {
      const value = await controlWriteSpan("external", async () => {
        clock += 300;
        await Promise.resolve();
        clock += 200;
        return "saved";
      });
      controlWriteSpan("board-write", () => { clock += 600; });
      return value;
    });
    expect(result).toBe("saved");
    const slow = lines.map(record).find(row => row.type === "control_write_slow");
    expect(slow).toMatchObject({ kind: "hub_task_done", task: 12, outcome: "returned", durationMs: 1100 });
    expect(slow?.phases).toEqual([{ phase: "external", durationMs: 500 }, { phase: "board-write", durationMs: 600 }]);
    expect(lines.join("\n")).not.toContain("saved");
    expect(lines.join("\n")).not.toContain("PRIVATE");
  });

  test("a delayed probe names a completed synchronous span and keeps loop and slow buckets separate", () => {
    let clock = 0;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    telemetry.start();
    try {
      telemetry.run({ kind: "task_assign", task: 4 }, () => true, () => controlWriteSpan("board-write", () => { clock += 1600; }));
      telemetry.sample();
      const rows = lines.map(record);
      const slow = rows.find(row => row.type === "control_write_slow");
      const delay = rows.find(row => row.type === "control_write_loop_delay");
      expect(slow).toMatchObject({ kind: "task_assign", task: 4, durationMs: 1600 });
      expect(delay).toMatchObject({ attribution: "sync_overlap_observed" });
      expect(delay?.spans).toEqual([{ kind: "task_assign", task: 4, phase: "board-write", durationMs: 1600 }]);
      expect(lines.every(line => Buffer.byteLength(line) <= CONTROL_WRITE_MAX_LINE_BYTES)).toBe(true);
    } finally { telemetry.stop(); }
  });

  test("privacy is rechecked for completed spans before a delayed loop sample", () => {
    let clock = 0, visible = true;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    telemetry.start();
    try {
      telemetry.run({ kind: "hub_task_done", task: 7 }, () => visible, () => controlWriteSpan("board-write", () => { clock += 1600; }));
      expect(lines.map(record).some(row => row.type === "control_write_slow")).toBe(true);
      visible = false;
      telemetry.sample();
      expect(lines.map(record).some(row => row.type === "control_write_loop_delay")).toBe(false);
    } finally { telemetry.stop(); }
  });

  test("an open asynchronous wait is reported without claiming it blocked the loop", async () => {
    let clock = 0, resume!: () => void;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    telemetry.start();
    try {
      const pending = telemetry.run({ kind: "hub_review", task: 14 }, () => true, () => controlWriteSpan("external", () => new Promise<void>(resolve => { resume = resolve; })));
      clock = 500; telemetry.sample();
      const delay = lines.map(record).find(row => row.type === "control_write_loop_delay");
      expect(delay).toMatchObject({ attribution: "open_async_wait", spans: [{ kind: "hub_review", task: 14, phase: "external", open: true }] });
      resume(); await pending;
    } finally { telemetry.stop(); }
  });

  test("background observations use a closed background kind, while request observations keep the request kind", () => {
    let clock = 0;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    telemetry.observe("memory", () => true, () => { clock += 1100; });
    telemetry.run({ kind: "hub_task_done", task: 9 }, () => true, () => telemetry.observe("status-hook", () => true, () => { clock += 1100; }));
    const rows = lines.map(record).filter(row => row.type === "control_write_slow");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "background", phases: [{ phase: "memory", durationMs: 1100 }] });
    expect(rows[1]).toMatchObject({ kind: "hub_task_done", task: 9, phases: [{ phase: "status-hook", durationMs: 1100 }] });
  });

  test("a continuation after the reply is reclassified as background", async () => {
    let clock = 0;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    telemetry.run({ kind: "hub_review", task: 13 }, () => true, () => {
      queueMicrotask(() => telemetry.observe("status-hook", () => true, () => { clock += 1100; }));
      return "replied";
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const row = lines.map(record).find(value => value.type === "control_write_slow");
    expect(row).toMatchObject({ kind: "background", phases: [{ phase: "status-hook", durationMs: 1100 }] });
    expect(row?.task).toBeUndefined();
  });

  test("privacy is rechecked before emission and a failing sink cannot fail the write", () => {
    let clock = 0, privacyCurrent = true;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    const result = telemetry.run({ kind: "hub_review", task: 3 }, () => privacyCurrent, () => { privacyCurrent = false; clock += 1100; return "ok"; });
    expect(result).toBe("ok");
    expect(lines).toHaveLength(0);
    const hostileMetadata = Object.defineProperty({}, "kind", { get() { throw new Error("must not read metadata accessor"); } });
    expect(telemetry.run(hostileMetadata as unknown as { kind: "hub_review" }, () => true, () => "still runs")).toBe("still runs");
    const textBearing = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    expect(textBearing.run({ kind: "hub_task_propose" }, () => true, () => textBearing.observe("external", () => false, () => { clock += 1100; return "saved"; }))).toBe("saved");
    expect(lines).toHaveLength(0);
    privacyCurrent = true;
    const throwing = new ControlWriteTelemetry({ emit: () => { throw new Error("sink failure"); }, now: () => clock });
    expect(throwing.run({ kind: "hub_review", task: 3 }, () => true, () => { clock += 1100; return 42; })).toBe(42);
    expect(throwing.status().droppedLogs).toBe(1);
  });

  test("bounds active requests, active registrations and recent intervals", async () => {
    let release!: () => void;
    let clock = 0;
    const telemetry = new ControlWriteTelemetry({ emit: () => {}, now: () => clock, maxActiveRequests: 1, maxRecentSpans: 1 });
    const pending = telemetry.run({ kind: "hub_task_propose" }, () => true, () => new Promise<void>(resolve => { release = resolve; }));
    expect(telemetry.run({ kind: "hub_review" }, () => true, () => "untraced")).toBe("untraced");
    release(); await pending;
    telemetry.run({ kind: "hub_task_accept" }, () => true, () => {
      controlWriteSpan("board-write", () => { clock++; });
      controlWriteSpan("status-hook", () => { clock++; });
    });
    expect(telemetry.status()).toMatchObject({ active: 0, droppedActive: 1, recentSpans: 1, droppedRecent: 1 });

    const activeCap = new ControlWriteTelemetry({ emit: () => {}, now: () => clock, maxActiveSpans: 1 });
    activeCap.run({ kind: "hub_task_done" }, () => true, () => controlWriteSpan("board-write", () => controlWriteSpan("status-hook", () => {})));
    expect(activeCap.status()).toMatchObject({ activeSpans: 0, droppedSpans: 1, recentSpans: 2 });
  });

  test("more than 32 completed phases do not blind the delayed probe", () => {
    let clock = 0;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    telemetry.start();
    try {
      telemetry.run({ kind: "hub_task_propose" }, () => true, () => {
        for (let index = 0; index < 40; index++) controlWriteSpan("memory", () => {});
        controlWriteSpan("board-write", () => { clock += 1600; });
      });
      telemetry.sample();
      const rows = lines.map(record);
      expect(rows.find(row => row.type === "control_write_slow")?.phases).toContainEqual({ phase: "board-write", durationMs: 1600 });
      expect((rows.find(row => row.type === "control_write_loop_delay")?.spans as unknown[]).some((span: any) => span.phase === "board-write")).toBe(true);
      expect(telemetry.status().droppedSpans).toBe(0);
    } finally { telemetry.stop(); }
  });

  test("a span dropped at the active-registration cap still records its completed block", async () => {
    let clock = 0, release!: () => void;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock, maxActiveSpans: 1 });
    telemetry.start();
    try {
      const pending = telemetry.run({ kind: "hub_review", task: 6 }, () => true, async () => {
        const outer = controlWriteSpan("external", () => new Promise<void>(resolve => { release = resolve; }));
        await Promise.resolve();
        await controlWriteSpan("board-write", () => { clock += 1600; return Promise.resolve(); });
        release(); await outer;
      });
      await pending;
      telemetry.sample();
      const rows = lines.map(record);
      expect(telemetry.status().droppedSpans).toBe(1);
      expect(rows.find(row => row.type === "control_write_slow")?.phases).toContainEqual({ phase: "board-write", durationMs: 1600 });
      expect((rows.find(row => row.type === "control_write_loop_delay")?.spans as unknown[]).some((span: any) => span.phase === "board-write")).toBe(true);
    } finally { telemetry.stop(); }
  });

  test("rate caps allow one loop record beside a slow write and cap combined output at 60 per minute", async () => {
    let clock = 0;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    const releases: (() => void)[] = [];
    const burst = [0, 1].map(() => telemetry.run({ kind: "hub_task_propose" }, () => true, () => new Promise<void>(resolve => { releases.push(resolve); })));
    clock = 1100;
    for (const release of releases) release();
    await Promise.all(burst);
    expect(lines.map(record).filter(row => row.type === "control_write_slow")).toHaveLength(1);
    telemetry.start();
    try {
      clock = 1450;
      telemetry.sample();
      expect(lines.map(record).some(row => row.type === "control_write_loop_delay")).toBe(true);
    } finally { telemetry.stop(); }

    let minuteClock = 0;
    const minuteLines: string[] = [];
    const limited = new ControlWriteTelemetry({ emit: line => minuteLines.push(line), now: () => minuteClock, rateLimitMs: 0 });
    limited.start();
    try {
      const settles: (() => void)[] = [];
      const pending = Array.from({ length: 60 }, () => limited.run({ kind: "hub_task_propose" }, () => true, () => new Promise<void>(resolve => { settles.push(resolve); })));
      minuteClock = 1001;
      limited.sample(); // One loop-delay line and 60 slow writes share the same rolling-minute cap.
      for (const settle of settles) settle();
      await Promise.all(pending);
      expect(minuteLines.map(record).filter(row => row.type === "control_write_loop_delay")).toHaveLength(1);
      expect(minuteLines).toHaveLength(60);
      expect(limited.status().droppedLogs).toBe(1);
    } finally { limited.stop(); }
  });

  test("a stopped probe cannot be revived and does not interfere with later work", () => {
    let clock = 0;
    const lines: string[] = [];
    const telemetry = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    telemetry.start(); telemetry.stop(); telemetry.start();
    clock = 1600; telemetry.sample();
    expect(telemetry.run({ kind: "hub_review" }, () => true, () => "still works")).toBe("still works");
    expect(lines).toHaveLength(0);
    expect(telemetry.status()).toMatchObject({ active: 0, blockedLoopSamples: 0, completedRequests: 0 });
    telemetry.stop();
  });

  test("a regressing or non-finite clock fails closed and never serializes a non-finite duration", () => {
    let clock = 100;
    const lines: string[] = [];
    const regressing = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    regressing.run({ kind: "hub_review" }, () => true, () => { clock = 99; });
    expect(regressing.status().clockFailures).toBe(1);

    clock = 0;
    const nonFinite = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    nonFinite.run({ kind: "hub_review" }, () => true, () => { clock = Number.POSITIVE_INFINITY; });
    expect(nonFinite.status().clockFailures).toBe(1);

    clock = 0;
    const huge = new ControlWriteTelemetry({ emit: line => lines.push(line), now: () => clock });
    huge.run({ kind: "hub_task_done" }, () => true, () => { clock = 1e308; });
    const row = lines.map(record).find(value => value.type === "control_write_slow");
    expect(row?.durationMs).toBe(86_400_000);
    expect(Number.isFinite(row?.durationMs)).toBe(true);
  });
});

