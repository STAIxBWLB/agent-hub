import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { realPath } from "../hub/project.ts";
import { canonicalInstruction, instructionHash } from "../hub/instruction-receipt.ts";

const MAX_HOOK_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type InstructionHookMessage =
  | { t: "instruction_hook"; op: "pending"; session: string; promptId: string; transcript: string; home: string; cwd: string; hash: string }
  | { t: "instruction_hook"; op: "stop"; session: string };

/** Never return the submitted prompt: the control link gets only its canonical hash. */
export function parseInstructionHook(stdin: string, env: NodeJS.ProcessEnv = process.env): InstructionHookMessage | undefined {
  if (Buffer.byteLength(stdin, "utf8") > MAX_HOOK_BYTES) return;
  try {
    const value: unknown = JSON.parse(stdin);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const input = value as Record<string, unknown>;
    if (typeof input.session_id !== "string" || !UUID.test(input.session_id) || env.CLAUDE_CODE_SESSION_ID !== input.session_id) return;
    if (input.hook_event_name === "Stop") return { t: "instruction_hook", op: "stop", session: input.session_id };
    if (input.hook_event_name !== "UserPromptSubmit" || typeof input.prompt_id !== "string" || !UUID.test(input.prompt_id)
      || typeof input.transcript_path !== "string" || !isAbsolute(input.transcript_path) || typeof input.cwd !== "string" || !isAbsolute(input.cwd)) return;
    const args = canonicalInstruction(input.prompt); if (args === undefined) return;
    const cwd = realPath(input.cwd), home = realPath(env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`);
    if (cwd !== realPath(process.cwd())) return;
    return { t: "instruction_hook", op: "pending", session: input.session_id, promptId: input.prompt_id, transcript: input.transcript_path, home, cwd, hash: instructionHash(args) };
  } catch { return; }
}
