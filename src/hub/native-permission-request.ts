import { types } from "node:util";

export const NATIVE_PERMISSION_PROBE_MAX_BYTES = 4096;
export const NATIVE_PERMISSION_PROBE_MAX_PER_LAUNCH = 4;
const MAX_DEPTH = 8, MAX_NODES = 256;

/** Native permission input only. Validation grants nothing and never reads accessor values. */
export function validateNativePermissionRequest(value: unknown): boolean {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || !keys.every(key => key === "tool_name" || key === "input" || key === "tool_use_id")) return false;
    const data = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    };
    const tool = data("tool_name"), input = data("input"), id = data("tool_use_id");
    return typeof tool === "string" && tool.length <= 128 && tool === tool.trim() && /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(tool)
      && input !== null && typeof input === "object" && !Array.isArray(input)
      && typeof id === "string" && id.length > 0 && id.length <= 256;
  } catch { return false; }
}

/** A temporary bounded validation input, never retained evidence or an authorization request. */
export function buildNativePermissionProbe(request: unknown): { t: "permission_failure_probe"; request: unknown } | undefined {
  try {
    let nodes = 0, bytes = 0;
    const ancestors = new Set<object>(), encoder = new TextEncoder();
    const charge = (count: number) => { bytes += count; if (bytes > NATIVE_PERMISSION_PROBE_MAX_BYTES) throw new Error(); };
    const string = (value: string) => {
      if (value.length > NATIVE_PERMISSION_PROBE_MAX_BYTES) throw new Error();
      charge(encoder.encode(JSON.stringify(value)).byteLength);
      return value;
    };
    const clone = (value: unknown, depth: number): unknown => {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error();
      if (typeof value === "string") return string(value);
      if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) {
        charge(value === null ? 4 : typeof value === "boolean" ? value ? 4 : 5 : String(value).length); return value;
      }
      if (!value || typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) throw new Error();
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error();
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_NODES || keys.some(key => typeof key !== "string")) throw new Error();
      ancestors.add(value);
      try {
        const copy: Record<string, unknown> | unknown[] = array ? Object.setPrototypeOf([], null) : Object.create(null);
        const length = array ? Object.getOwnPropertyDescriptor(value, "length")?.value : undefined;
        if (array && (!Number.isSafeInteger(length) || length < 0 || length > MAX_NODES || keys.length !== length + 1)) throw new Error();
        const names = array ? Array.from({ length }, (_, index) => String(index)) : keys as string[];
        charge(2 + Math.max(0, names.length - 1) + (array ? 0 : names.length));
        for (const key of names) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new Error();
          if (!array) string(key);
          Object.defineProperty(copy, key, { value: clone(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
        }
        return copy;
      } finally { ancestors.delete(value); }
    };
    const payload = Object.assign(Object.create(null), { t: "permission_failure_probe" as const, request: clone(request, 0) });
    return encoder.encode(JSON.stringify(payload)).byteLength <= NATIVE_PERMISSION_PROBE_MAX_BYTES ? payload : undefined;
  } catch { return; }
}
