import { runAgyEntry } from "../agy/entry.ts";
import type { BuiltinCliEntry } from "./native-cli-entry-types.ts";
import { runClaudeEntry } from "./native-cli-entry-claude.ts";
import { runCodexEntry } from "./native-cli-entry-codex.ts";
import { runJcodeEntry } from "./native-cli-entry-jcode.ts";
import { runQwenEntry } from "./native-cli-entry-qwen.ts";
import { runKimiEntry } from "./native-cli-entry-kimi.ts";
import { runPiEntry } from "./native-cli-entry-pi.ts";
import { runLocalEntry } from "./native-cli-entry-local.ts";

// Fixed trusted builtins only. No project configuration, caller payload or external module can register an entry.
export const builtinCliEntries: readonly BuiltinCliEntry[] = Object.freeze([
  { command: "agy", lifecycleAdmission: true, execute: runAgyEntry },
  { command: "claude", lifecycleAdmission: true, execute: runClaudeEntry },
  { command: "codex", lifecycleAdmission: true, execute: runCodexEntry },
  { command: "jcode", lifecycleAdmission: true, execute: runJcodeEntry },
  { command: "qwen", lifecycleAdmission: true, execute: runQwenEntry },
  { command: "kimi", lifecycleAdmission: true, execute: runKimiEntry },
  { command: "pi", lifecycleAdmission: false, execute: runPiEntry },
  { command: "local", lifecycleAdmission: false, execute: runLocalEntry },
]);
