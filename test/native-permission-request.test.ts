import { expect, test } from "bun:test";
import { buildNativePermissionProbe, NATIVE_PERMISSION_PROBE_MAX_BYTES, NATIVE_PERMISSION_PROBE_MAX_PER_LAUNCH, validateNativePermissionRequest } from "../src/hub/native-permission-request.ts";

const valid = () => ({ tool_name: "Bash", input: { command: "fixture" }, tool_use_id: "native-call-17" });

test("native permission validator accepts exactly the three native own-data fields and original boundaries", () => {
  expect(validateNativePermissionRequest(valid())).toBe(true);
  expect(validateNativePermissionRequest(Object.assign(Object.create(null), valid()))).toBe(true);
  expect(validateNativePermissionRequest({ tool_name: "a".repeat(128), input: {}, tool_use_id: "i".repeat(256) })).toBe(true);
  expect(validateNativePermissionRequest({ ...valid(), tool_name: "mcp__server/tool.name:part-1" })).toBe(true);
  // The native input remains opaque, including nested accessor values; this validator grants nothing.
  expect(validateNativePermissionRequest({ ...valid(), input: Object.defineProperty({}, "secret", { get() { throw new Error("must not read input"); } }) })).toBe(true);
});

test("native permission validator rejects missing, inherited, extra and symbol fields", () => {
  for (const key of ["tool_name", "input", "tool_use_id"] as const) {
    const value: Partial<ReturnType<typeof valid>> = valid(); delete value[key];
    expect(validateNativePermissionRequest(value)).toBe(false);
    expect(validateNativePermissionRequest(Object.assign(Object.create({ [key]: valid()[key] }), value))).toBe(false);
  }
  expect(validateNativePermissionRequest({ ...valid(), extra: true })).toBe(false);
  expect(validateNativePermissionRequest({ ...valid(), [Symbol("extra")]: true })).toBe(false);
  expect(validateNativePermissionRequest(Object.assign(Object.create({ extra: true }), valid()))).toBe(false);
});

test("native permission validator rejects malformed native arguments without coercion", () => {
  for (const value of [undefined, null, false, "request", [], () => valid()]) expect(validateNativePermissionRequest(value)).toBe(false);
  for (const tool_name of ["", "a".repeat(129), "1Bash", "Bash\n", " Bash", "Bash ", "spoof\nBash", {}, null]) {
    expect(validateNativePermissionRequest({ ...valid(), tool_name })).toBe(false);
  }
  for (const input of [undefined, null, [], "command", 1, () => ({})]) expect(validateNativePermissionRequest({ ...valid(), input })).toBe(false);
  for (const tool_use_id of [undefined, null, "", "i".repeat(257), 123, {}]) expect(validateNativePermissionRequest({ ...valid(), tool_use_id })).toBe(false);
});

test("native permission validator never invokes top-level getters or reflects hostile exception text", () => {
  let reads = 0;
  for (const key of ["tool_name", "input", "tool_use_id"]) {
    const value = Object.defineProperty(valid(), key, { get() { reads++; throw new Error("PRIVATE_CANARY"); } });
    expect(validateNativePermissionRequest(value)).toBe(false);
  }
  expect(reads).toBe(0);
  for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]) {
    const hostile = new Proxy(valid(), { [trap]() { throw new Error("PRIVATE_CANARY"); } });
    expect(validateNativePermissionRequest(hostile)).toBe(false);
  }
  const revoked = Proxy.revocable(valid(), {}); revoked.revoke();
  expect(validateNativePermissionRequest(revoked.proxy)).toBe(false);
});

test("native permission probe copies temporary finite JSON data within its exact byte ceiling", () => {
  expect(NATIVE_PERMISSION_PROBE_MAX_BYTES).toBe(4096); expect(NATIVE_PERMISSION_PROBE_MAX_PER_LAUNCH).toBe(4);
  const request = { ...valid(), tool_use_id: "", input: { command: "temporary canary", rows: [true, null, 3] } };
  const probe = buildNativePermissionProbe(request);
  expect(JSON.parse(JSON.stringify(probe))).toEqual({ t: "permission_failure_probe", request });
  request.input.command = "changed after build";
  expect(JSON.stringify(probe)).toContain("temporary canary");
  expect(JSON.stringify(probe)).not.toContain("changed after build");
  const boundary = { ...valid(), tool_use_id: "", padding: "" };
  const overhead = new TextEncoder().encode(JSON.stringify({ t: "permission_failure_probe", request: boundary })).byteLength;
  boundary.padding = "a".repeat(NATIVE_PERMISSION_PROBE_MAX_BYTES - overhead);
  const exact = buildNativePermissionProbe(boundary);
  expect(exact).toBeDefined();
  expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(NATIVE_PERMISSION_PROBE_MAX_BYTES);
  boundary.padding += "a"; expect(buildNativePermissionProbe(boundary)).toBeUndefined();
  expect(buildNativePermissionProbe({ body: "한".repeat(2000) })).toBeUndefined();
});

test("native permission probe refuses cycles, depth, node excess and non-JSON values", () => {
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  let deep: unknown = null; for (let i = 0; i < 10; i++) deep = { child: deep };
  for (const input of [cycle, deep, Array.from({ length: 256 }, () => 1), undefined, NaN, Infinity, 1n, () => true, new Date(), { value: undefined }, { value: Symbol("private") }]) {
    expect(buildNativePermissionProbe(input)).toBeUndefined();
  }
  expect(buildNativePermissionProbe(new Array(2))).toBeUndefined();
  expect(buildNativePermissionProbe(Object.assign([], { extra: true }))).toBeUndefined();
});

test("native permission probe skips proxies, getters and toJSON without invoking hostile code", () => {
  let reads = 0;
  const getter = Object.defineProperty({}, "body", { enumerable: true, get() { reads++; throw new Error("PRIVATE_CANARY"); } });
  const proxy = new Proxy({}, {
    getPrototypeOf() { reads++; throw new Error("PRIVATE_CANARY"); },
    ownKeys() { reads++; throw new Error("PRIVATE_CANARY"); },
    get() { reads++; throw new Error("PRIVATE_CANARY"); },
  });
  const toJSON = { toJSON() { reads++; throw new Error("PRIVATE_CANARY"); } };
  for (const input of [getter, proxy, toJSON, { nested: getter }, { nested: proxy }]) expect(buildNativePermissionProbe(input)).toBeUndefined();
  expect(reads).toBe(0);
  const key = JSON.parse('{"__proto__":{"polluted":true},"constructor":"literal"}');
  const safe = buildNativePermissionProbe(key);
  expect(JSON.parse(JSON.stringify(safe))).toEqual({ t: "permission_failure_probe", request: key });
  expect(Object.getPrototypeOf(safe?.request as object)).toBeNull();
});
