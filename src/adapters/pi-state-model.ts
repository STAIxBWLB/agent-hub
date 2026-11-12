import { safeModelLabel } from "../omniroute/usage.ts";

/**
 * #1402 T4: the model id in a Pi `get_state` reply's data (`data.model.id`, a model descriptor). Pi 1.5.2 reports the placeholder id `unknown` (provider `unknown`) when no model is selected, which names no
 * model. A value `safeModelLabel` refuses, a missing descriptor or a non-object names none, so nothing is guessed and no alias is expanded.
 */
export function stateModelId(state: unknown): string | undefined {
  const data = state && typeof state === "object" && !Array.isArray(state) ? state as Record<string, unknown> : undefined;
  const model = data?.model && typeof data.model === "object" && !Array.isArray(data.model) ? data.model as Record<string, unknown> : undefined;
  const id = safeModelLabel(model?.id);
  return id !== undefined && id.toLowerCase() !== "unknown" ? id : undefined;
}
