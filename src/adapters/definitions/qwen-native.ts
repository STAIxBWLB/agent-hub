import type { PermissionMode } from "../../hub/permission-mode.ts";
import type { Launch } from "../../cli/launch.ts";

export const QWEN_MODE_IDS: Readonly<Record<PermissionMode, string>> = { ask: "default", "ask-when-needed": "auto-edit", "never-ask": "yolo" };

export class QwenIdentityError extends Error {
  constructor() { super("Qwen Code 0.25.0 native identity is not verified; check the executable and its advertised ACP version"); }
}

export function qwenNativeIdentity(instance: string, production: boolean | undefined, init: unknown, kind?: string): boolean {
  const native = init as { agentInfo?: { name?: unknown; version?: unknown } } | null | undefined;
  const verified = production === true && (kind ?? instance) === "qwen" && native?.agentInfo?.name === "qwen-code" && native?.agentInfo?.version === "0.25.0";
  if (production && !verified) throw new QwenIdentityError();
  return verified;
}

/** Qwen flags follow the configured executable argv, including wrapper/script arguments. */
export function buildQwenLaunch(command: readonly string[], model?: string): Launch {
  const [cmd, ...args] = command;
  if (!cmd) throw new Error("qwen_cmd must name an executable");
  return { cmd, args: [...args, ...(model ? ["--model", model] : [])] };
}

export const qwenSessionId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
