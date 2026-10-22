import { assessVersion } from "../compat.ts";
import type { PermissionMode } from "../../hub/permission-mode.ts";
import type { Launch } from "../../cli/launch.ts";

export const QWEN_MODE_IDS: Readonly<Record<PermissionMode, string>> = { ask: "default", "ask-when-needed": "auto-edit", "never-ask": "yolo" };

export class QwenIdentityError extends Error {
  constructor(reason?: string) { super(reason ? `Qwen Code native identity is not verified: ${reason}` : "Qwen Code native identity is not verified; check the executable and its advertised ACP version"); }
}

export function qwenNativeIdentity(instance: string, production: boolean | undefined, init: unknown, kind?: string): boolean {
  const native = init as { agentInfo?: { name?: unknown; version?: unknown } } | null | undefined;
  const identity = production === true && (kind ?? instance) === "qwen" && native?.agentInfo?.name === "qwen-code";
  // #691: a version refusal carries the compat reason (observed and verified versions, the trust command).
  const version = identity ? assessVersion("qwen", native?.agentInfo?.version) : undefined;
  if (production && !version?.ok) throw new QwenIdentityError(version && !version.ok ? version.reason : undefined);
  const verified = !!version?.ok;
  return verified;
}

/** Qwen flags follow the configured executable argv, including wrapper/script arguments. */
export function buildQwenLaunch(command: readonly string[], model?: string): Launch {
  const [cmd, ...args] = command;
  if (!cmd) throw new Error("qwen_cmd must name an executable");
  return { cmd, args: [...args, ...(model ? ["--model", model] : [])] };
}

export const qwenSessionId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
