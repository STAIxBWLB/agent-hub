import type { PermissionMode } from "../../hub/permission-mode.ts";

/** Shared native mode ids stay independent of the registry's factories. */
export const KIMI_MODE_IDS: Readonly<Record<PermissionMode, string>> = { ask: "default", "ask-when-needed": "yolo", "never-ask": "auto" };
