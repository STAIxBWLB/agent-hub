import type { NativeConfigCheck, NativeConfigValidators } from "../registry-types.ts";
import type { SettingDef } from "../../hub/settings.ts";

/** Native config uses the host's checked schema vocabulary, retaining its shape/path introspection. */
export function piConfigSchema(v: NativeConfigValidators): Record<string, NativeConfigCheck> {
  return { pi: v.block({ enabled: v.bool, auto_start: v.bool, cmd: v.argv, backend: v.words(["auto", "dgx", "mlx"]), dgx_coding: v.text, dgx_fast: v.text, max_steps: v.number(1, 1_000_000, true) }) };
}
export function localConfigSchema(v: NativeConfigValidators): Record<string, NativeConfigCheck> {
  return { local: v.block({ deny: v.strings, bash_network: (value, key) => { if (value !== "direct") v.bool(value, key); }, network_allow: v.strings, max_steps: v.number(1, 1_000_000, true), read_allow: v.strings }) };
}
export function piRoutingSchema(v: NativeConfigValidators): Record<string, NativeConfigCheck> {
  return { pi: v.block({ dgx_max_context_tokens: v.number(), mlx_max_context_tokens: v.number(), efficient_wait_ms: v.number(0, 119999) }) };
}
export function localRoutingSchema(v: NativeConfigValidators): Record<string, NativeConfigCheck> {
  return { local: v.block({ route: v.text, fixed_model: v.text }) };
}
export const PI_SETTINGS: readonly SettingDef[] = [
  { key: "pi.auto_start", group: "Start", label: "Start Pi with the hub", type: "boolean", store: "config", applies: "next use", risk: "raises", floor: false, path: ["pi", "auto_start"] },
];
export const PI_RESTART_REASONS: Readonly<Record<string, string>> = {
  "pi.dgx_coding": "Published Pi relay model catalogue requires a new daemon relay",
  "pi.dgx_fast": "Published Pi relay model catalogue requires a new daemon relay",
  "routing.pi": "Pi relay context and model publication are bound to the running relay",
};
export const LOCAL_RESTART_REASONS: Readonly<Record<string, string>> = {
  "local.deny": "Existing native sessions retain their sandbox deny policy", "local.read_allow": "Existing native sessions retain their sandbox read grants",
  "local.bash_network": "Existing sandbox and egress proxy contracts require a new instance", "local.network_allow": "Existing egress proxy ownership requires a new instance",
};
export function piEffectiveConfig(raw: Record<string, unknown>, fail: (key: string, reason: string) => never): void {
  const object = (value: unknown, key: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(key, "must be an object");
    return value as Record<string, unknown>;
  };
  if (object(raw.mlx, "mlx").enabled === false && object(raw.pi, "pi").backend === "mlx") fail("pi.backend", "conflicts with disabled mlx");
}
