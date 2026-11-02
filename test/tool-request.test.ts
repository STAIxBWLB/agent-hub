import { expect, test } from "bun:test";
import { newToolRequestId, ToolWriteRegistry, toolWriteOperation, toolWriteUnknownReply } from "../src/hub/tool-request.ts";

const epoch = "fixture-instance";
const start = 1_790_000_000_000;
const message = { t: "task", op: "hub_task_propose", args: { title: "synthetic task", class: "implement" } };
const request = (id: string, payload: unknown = message, scope = "tools:codex:launch-1") => ({ id, scope, payload, current: () => true });

test("a repeated request returns the first detached result without executing twice", async () => {
  const registry = new ToolWriteRegistry(epoch, { now: () => start }), id = newToolRequestId(epoch, start);
  let applied = 0;
  const work = async () => ({ ok: true, text: `task #${++applied}`, nested: { value: "first" } });
  const first = await registry.run(request(id), work);
  (first.nested as { value: string }).value = "caller mutation";
  const again = await registry.run(request(id), work);
  expect(applied).toBe(1); expect(again).toMatchObject({ ok: true, text: "task #1", nested: { value: "first" }, requestId: id });
});

test("concurrent duplicates join the one in-flight write", async () => {
  const registry = new ToolWriteRegistry(epoch, { now: () => start }), id = newToolRequestId(epoch, start);
  let release!: () => void, applied = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const work = async () => { applied++; await gate; return { ok: true, text: "first result" }; };
  const one = registry.run(request(id), work), two = registry.run(request(id), work);
  await Promise.resolve(); expect(applied).toBe(1);
  release(); expect(await one).toEqual(await two); expect(applied).toBe(1);
});

test("same id with changed authority or payload is refused, while JSON key order is immaterial", async () => {
  const registry = new ToolWriteRegistry(epoch, { now: () => start }), id = newToolRequestId(epoch, start);
  let applied = 0;
  const work = async () => ({ ok: true, text: String(++applied) });
  await registry.run(request(id), work);
  expect(await registry.run(request(id, { args: { class: "implement", title: "synthetic task" }, op: "hub_task_propose", t: "task" }), work)).toMatchObject({ ok: true, text: "1" });
  expect(await registry.run(request(id, { ...message, args: { title: "other" } }), work)).toMatchObject({ ok: false, outcome: "unknown" });
  expect(await registry.run(request(id, message, "tools:kimi:other-launch"), work)).toMatchObject({ ok: false, outcome: "unknown" });
  expect(applied).toBe(1);
});

test("old daemon ids, future ids and expired ids cannot apply, including after clock rollback", async () => {
  let now = start, applied = 0;
  const registry = new ToolWriteRegistry(epoch, { now: () => now, retentionMs: 1000 }), id = newToolRequestId(epoch, start);
  const work = async () => ({ ok: true, text: String(++applied) });
  await registry.run(request(id), work);
  now += 1000;
  expect(await registry.run(request(id), work)).toMatchObject({ outcome: "unknown" });
  now = start;
  expect(await registry.run(request(id), work)).toMatchObject({ outcome: "unknown" });
  expect(await registry.run(request(newToolRequestId("old-instance", now)), work)).toMatchObject({ outcome: "unknown" });
  expect(await registry.run(request(newToolRequestId(epoch, now + 60_000)), work)).toMatchObject({ outcome: "unknown" });
  expect(applied).toBe(1);
});

test("a full cache refuses new writes without evicting an unexpired result", async () => {
  const registry = new ToolWriteRegistry(epoch, { now: () => start, maxEntries: 1 });
  const id = newToolRequestId(epoch, start); let applied = 0;
  const work = async () => ({ ok: true, text: String(++applied) });
  await registry.run(request(id), work);
  expect(await registry.run(request(newToolRequestId(epoch, start)), work)).toMatchObject({ outcome: "unknown" });
  expect(await registry.run(request(id), work)).toMatchObject({ ok: true, text: "1" }); expect(applied).toBe(1);
});

test("an in-flight key never expires into a second write", async () => {
  let now = start, applied = 0, release!: () => void;
  const registry = new ToolWriteRegistry(epoch, { now: () => now, retentionMs: 1000 }), id = newToolRequestId(epoch, start);
  const gate = new Promise<void>(resolve => { release = resolve; });
  const work = async () => { applied++; await gate; return { ok: true }; };
  const one = registry.run(request(id), work); await Promise.resolve(); now += 2000;
  const two = registry.run(request(id), work); release();
  expect(await one).toEqual(await two); expect(applied).toBe(1);
});

test("current authority is rechecked after a blocked write and before replay", async () => {
  let current = true, release!: () => void, applied = 0;
  const registry = new ToolWriteRegistry(epoch, { now: () => start }), id = newToolRequestId(epoch, start);
  const req = { ...request(id), current: () => current };
  const gate = new Promise<void>(resolve => { release = resolve; });
  const work = async () => { applied++; await gate; return { ok: true, text: "public result" }; };
  const pending = registry.run(req, work); await Promise.resolve(); current = false; release();
  expect(await pending).toMatchObject({ outcome: "unknown" });
  expect(await registry.run(req, work)).toMatchObject({ outcome: "unknown" }); expect(applied).toBe(1);
});

test("an unexpected post-effect throw or oversized reply stays unknown without another effect", async () => {
  for (const oversized of [false, true]) {
    const registry = new ToolWriteRegistry(epoch, { now: () => start, maxReplyBytes: 100 }), id = newToolRequestId(epoch, start);
    let applied = 0;
    const work = async () => { applied++; if (!oversized) throw new Error("private failure text"); return { ok: true, text: "x".repeat(200) }; };
    const first = await registry.run(request(id), work), second = await registry.run(request(id), work);
    expect(first).toMatchObject({ outcome: "unknown", requestId: id }); expect(second).toEqual(first); expect(applied).toBe(1);
    expect(JSON.stringify(first)).not.toContain("private failure text");
  }
});

test("the replay authority callback cannot mutate the cached result", async () => {
  const registry = new ToolWriteRegistry(epoch, { now: () => start }), id = newToolRequestId(epoch, start);
  const req = { ...request(id), current: (body?: Record<string, unknown>) => { if (body) body.text = "tampered"; return true; } };
  expect(await registry.run(req, async () => ({ ok: true, text: "first" }))).toMatchObject({ text: "first" });
  expect(await registry.run(req, async () => ({ ok: true, text: "second" }))).toMatchObject({ text: "first" });
});

test("unknown write outcomes name a real settling read, with no untrusted delivery interpolation", () => {
  expect(toolWriteOperation(message)).toBe("hub_task_propose");
  expect(toolWriteOperation({ t: "task", op: "hub_invoke" })).toBeUndefined();
  expect(toolWriteOperation({ t: "task", op: "hub_task_list" })).toBeUndefined();
  expect(toolWriteUnknownReply(message).error).toContain("hub_task_list");
  expect(toolWriteUnknownReply({ t: "task", op: "hub_review", args: { id: 7 } }).error).toContain("hub_task_show {id: 7}");
  const delivery = toolWriteUnknownReply({ t: "delivery_complete", deliveryId: "forged\nheader" });
  expect(delivery.error).toContain("ahub queue show <delivery-id>"); expect(delivery.error).not.toContain("forged");
  expect(toolWriteUnknownReply({ t: "delivery_complete", deliveryId: "--deadbeef" }).error).toContain("ahub queue show <delivery-id>");
});
