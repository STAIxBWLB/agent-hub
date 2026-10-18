import { expect, test } from "bun:test";
import { crashPlan } from "../src/hub/crash.ts";

const instances = { "codex-2": { kind: "codex" }, "pi-2": { kind: "pi" }, "kimi-2": { kind: "kimi" }, "qwen-2": { kind: "qwen" } };

test("declared instances retain their native crash resume data and exact actor ids", () => {
  expect(crashPlan([{ peer: "pi-2", meta: { sessionId: "native-pi", sessionFile: "/private/instance/session.jsonl", launch: { mode: "headless", backend: "mlx", model: "mlx/fast" } } }], instances)[0]).toMatchObject({ peer: "pi-2", fresh: { backend: "mlx", model: "mlx/fast" }, resume: { sessionFile: "/private/instance/session.jsonl", mode: "headless", backend: "mlx", model: "mlx/fast" } });
  expect(crashPlan([{ peer: "kimi-2", meta: { sessionId: "native-kimi", launch: { model: "chosen" } } }], instances)[0]).toMatchObject({ peer: "kimi-2", resume: { sessionId: "native-kimi", model: "chosen" } });
  expect(crashPlan([{ peer: "qwen-2", meta: { sessionId: "native-qwen", launch: { model: "chosen" } } }], instances)[0]).toMatchObject({ peer: "qwen-2", resume: { sessionId: "native-qwen", model: "chosen" } });
});

test("extra-instance crash guidance selects that instance in each manual native command", () => {
  const records = [
    { peer: "codex-2", meta: { threadId: "thread-2" } },
    { peer: "pi-2", meta: {} },
    { peer: "kimi-2", meta: {} },
    { peer: "qwen-2", meta: {} },
  ];
  for (const row of crashPlan(records, instances)) {
    expect(row.how.startsWith(`${row.peer}:`)).toBe(true);
    const kind = instances[row.peer as keyof typeof instances].kind;
    expect(row.how).toContain(`ahub ${kind} --as ${row.peer}`);
  }
  const terminal = crashPlan([{ peer: "pi-2", meta: { sessionFile: "/private/instance/session.jsonl", launch: { mode: "tui" } } }], instances)[0]!;
  expect(terminal.how).toContain("ahub pi --as pi-2 --mode tui --session-file /private/instance/session.jsonl");
  expect(terminal.tui).toBe(true);
});

test("undeclared suffixes never acquire another instance's native recovery policy", () => {
  for (const peer of ["pi-unknown", "kimi-unknown", "qwen-unknown", "codex-unknown"]) {
    expect(crashPlan([{ peer, meta: { sessionId: "native-session", sessionFile: "/private/session", threadId: "native-thread" } }], instances)[0]).toEqual({ peer, how: `${peer}: reconnects by itself if its client is still running` });
  }
});

test("an instance map does not change the serialized legacy crash plan", () => {
  const records = [
    { peer: "codex", meta: { threadId: "native-thread" } },
    { peer: "pi", meta: { sessionFile: "/private/session", launch: { mode: "headless", backend: "mlx" } } },
    { peer: "kimi", meta: { sessionId: "native-session" } },
    { peer: "qwen", meta: { sessionId: "native-session" } },
    { peer: "claude", meta: {} },
    { peer: "local", meta: {} },
  ];
  expect(JSON.stringify(crashPlan(records, instances))).toBe(JSON.stringify(crashPlan(records)));
});
