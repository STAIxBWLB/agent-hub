import { safeModelLabel } from "../omniroute/usage.ts";
import { ACP_MODEL_OPTIONS_MAX, acpLogicalModelId, type AcpModelPolicy } from "./acp-model-policy.ts";

/**
 * #1402 T3: the model id an ACP agent says its session is on, whatever the override policy. Read-only and shape-checked: the three places ACP agents put it are `models.currentModelId` (`session/new`,
 * `session/load`), the `model` select of `configOptions` (`currentValue`) and a model-update payload. A receipt policy that owns an id codec (Qwen's `id(openai)` wire ids) strips it exactly as the
 * override path does; otherwise the id is the wire id through `safeModelLabel`. A value `safeModelLabel` refuses, the placeholder `unknown`, or an absent field names no model, so nothing is guessed.
 */
function label(value: unknown, policy: AcpModelPolicy | undefined): string | undefined {
  const id = policy?.idCodec ? acpLogicalModelId(policy, value) : safeModelLabel(value);
  const safe = safeModelLabel(id);
  return safe !== undefined && safe.toLowerCase() !== "unknown" ? safe : undefined;
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** The model in a `session/new` or `session/load` result (or a `configOptions`-only holder). */
export function sessionModelId(session: unknown, policy?: AcpModelPolicy): string | undefined {
  const holder = record(session);
  if (!holder) return undefined;
  const fromModels = label(record(holder.models)?.currentModelId, policy);
  if (fromModels !== undefined) return fromModels;
  return configModelId(holder.configOptions, policy);
}
function configModelId(options: unknown, policy: AcpModelPolicy | undefined): string | undefined {
  if (!Array.isArray(options) || options.length > ACP_MODEL_OPTIONS_MAX) return undefined;
  const models = options.filter(option => record(option)?.id === "model");
  if (models.length !== 1) return undefined;
  const option = record(models[0])!;
  return option.type === "select" ? label(option.currentValue, policy) : undefined;
}
/** The model in a model-update notification: `current_model_update` and the Qwen notice carry `currentModelId`, `config_option_update` carries the options. */
export function updatedModelId(update: unknown, policy?: AcpModelPolicy): string | undefined {
  const value = record(update);
  if (!value) return undefined;
  return value.configOptions !== undefined ? configModelId(value.configOptions, policy) : label(value.currentModelId, policy);
}
