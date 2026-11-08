import { isNativeModelToken } from "./model-token.ts";
import type { CompatId } from "./compat.ts";

/** Source-owned receipt policy. No native advertisement or project configuration can create one. */
export interface AcpModelPolicy {
  readonly admission: { readonly compatId: CompatId; readonly nativeIdentity?: never } | { readonly nativeIdentity: true; readonly compatId?: never };
  readonly agentName: string;
  readonly version: string;
  readonly setter: "set_model" | "set_config_option";
  readonly receipt: string;
  readonly idCodec?: "qwen-openai";
  readonly modelUpdate?: "current_model_update" | "config_option_update" | "qwen/notify/session/model-update";
}
export interface AcpModelAdvertisement {
  readonly current: string;
  readonly available: readonly string[];
  readonly wire: Readonly<Record<string, string>>;
}
const ACP_MODEL_OPTIONS_MAX = 256;
/** Person ids retain the native-word grammar; only an exact receipt-owned wire codec may wrap one. */
export function acpLogicalModelId(policy: AcpModelPolicy, wire: unknown): string | undefined {
  if (policy.idCodec === "qwen-openai") {
    const suffix = "(openai)";
    if (typeof wire !== "string" || wire.length > 128 + suffix.length || !wire.endsWith(suffix)) return;
    const logical = wire.slice(0, -suffix.length);
    return isNativeModelToken(logical) ? logical : undefined;
  }
  return isNativeModelToken(wire) ? wire : undefined;
}
/** Only the receipt-backed ACP shapes are recognized; labels never stand in for model ids. */
export function acpModelAdvertisement(policy: AcpModelPolicy, session: unknown): AcpModelAdvertisement | undefined {
  if (!session || typeof session !== "object" || Array.isArray(session)) return;
  const value = session as Record<string, any>;
  let current: unknown, options: unknown;
  if (policy.setter === "set_model") {
    current = value.models?.currentModelId;
    options = value.models?.availableModels;
  } else {
    if (!Array.isArray(value.configOptions) || value.configOptions.length > ACP_MODEL_OPTIONS_MAX) return;
    const models = value.configOptions.filter((option: any) => option?.id === "model");
    if (models.length !== 1 || models[0]?.type !== "select") return;
    current = models[0].currentValue;
    options = models[0].options;
  }
  const logicalCurrent = acpLogicalModelId(policy, current);
  if (!logicalCurrent || !Array.isArray(options) || options.length === 0 || options.length > ACP_MODEL_OPTIONS_MAX) return;
  const ids: string[] = [], wire: Record<string, string> = Object.create(null);
  for (const option of options) {
    const id = policy.setter === "set_model" ? option?.modelId : option?.value;
    const logical = acpLogicalModelId(policy, id);
    if (!logical || ids.includes(logical)) return;
    ids.push(logical); wire[logical] = id;
  }
  if (!ids.includes(logicalCurrent)) return;
  return Object.freeze({ current: logicalCurrent, available: Object.freeze(ids), wire: Object.freeze(wire) });
}
