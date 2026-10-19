import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { NativeFactsInput, NativeFactsPort, NativeFactsTranscript } from "../registry-types.ts";

const EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse", "Stop"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The pinned 1.4.2 envelope has no event name: the managed command supplies it separately. */
export function decodeAgyHook(event: string, value: unknown): NativeFactsInput | undefined {
  if (!(EVENTS as readonly string[]).includes(event) || !record(value) || typeof value.conversationId !== "string" || !UUID.test(value.conversationId)
    || typeof value.transcriptPath !== "string" || !isAbsolute(value.transcriptPath) || value.transcriptPath.length > 4096
    || !Array.isArray(value.workspacePaths) || !value.workspacePaths.length || value.workspacePaths.length > 32
    || !value.workspacePaths.every(path => typeof path === "string" && path.length <= 4096 && isAbsolute(path))) return;
  if (event === "Stop" && typeof value.fullyIdle !== "boolean") return;
  const call = record(value.toolCall) ? value.toolCall : undefined;
  if ((event === "PreToolUse" || event === "PostToolUse") && (!call || typeof call.name !== "string" || call.name.length > 128 || !record(call.args))) return;
  const native = call?.args as Record<string, unknown> | undefined;
  // Only the observed native read is classified. Unobserved edits never receive a scoped grant or effect attribution.
  const observedRead = call?.name === "view_file" && typeof native?.AbsolutePath === "string";
  const phase = ({ SessionStart: "session", PreInvocation: "start", PostInvocation: "post", PreToolUse: "pre", PostToolUse: "post", Stop: "stop" } as const)[event as typeof EVENTS[number]];
  return { event: event as NativeFactsInput["event"], phase, sessionId: value.conversationId, transcriptPath: value.transcriptPath,
    workspacePaths: value.workspacePaths as string[], tool: observedRead ? "Read" : typeof call?.name === "string" ? call.name : "", input: observedRead ? { file_path: native!.AbsolutePath } : native ?? {},
    ...(Number.isSafeInteger(value.stepIdx) && (value.stepIdx as number) >= 0 ? { toolUseId: `${value.conversationId}:${value.stepIdx}` } : {}),
    ...(Number.isSafeInteger(value.invocationNum) && (value.invocationNum as number) >= 0 ? { invocation: value.invocationNum as number } : {}),
    ...(event === "Stop" ? { fullyIdle: value.fullyIdle as boolean, terminationReason: typeof value.terminationReason === "string" ? value.terminationReason : "" } : {}) };
}

export function encodeAgyHook(event: string, text?: string): Record<string, unknown> | undefined {
  // `allow` does not override native approval. Until a prompt mapping is proven, leave all native permissions alone.
  if (text && (event === "SessionStart" || event === "PreInvocation")) return { injectSteps: [{ ephemeralMessage: text }] };
  return undefined;
}

/** Only native-generated rows under the exact session cache path count as readback/completion evidence. */
export function readAgyTranscript(session: string, transcript: string): NativeFactsTranscript {
  const empty: NativeFactsTranscript = { factIds: [] };
  if (!UUID.test(session)) return empty;
  const home = process.env.HOME ?? homedir();
  const candidates = ["antigravity-cli", "antigravity", "antigravity-ide"].map(surface => join(home, ".gemini", surface, "brain", session, ".system_generated/logs/transcript_full.jsonl"));
  if (!candidates.includes(transcript)) return empty;
  let fd: number | undefined;
  try {
    let cursor = home;
    for (const name of relative(home, transcript).split("/")) { cursor = join(cursor, name); if (lstatSync(cursor).isSymbolicLink()) return empty; }
    fd = openSync(transcript, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return empty;
    const start = Math.max(0, stat.size - 64 * 1024), buffer = Buffer.alloc(stat.size - start);
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
    if (start) lines.shift();
    const out: NativeFactsTranscript = { factIds: [] };
    for (const line of lines) {
      let row: unknown; try { row = JSON.parse(line); } catch { continue; }
      if (!record(row) || row.status !== "DONE") continue;
      if (row.source === "SYSTEM_SDK" && row.type === "EPHEMERAL_MESSAGE" && typeof row.content === "string") {
        for (const match of row.content.matchAll(/agent-hub facts \[([a-zA-Z0-9-]{1,128})\]/g)) out.factIds.push(match[1]!);
      }
      if (row.source === "MODEL" && row.type === "PLANNER_RESPONSE" && Number.isSafeInteger(row.step_index)
        && typeof row.content === "string" && row.content.trim().length > 0 && (!Array.isArray(row.tool_calls) || row.tool_calls.length === 0)) out.completion = { id: createHash("sha256").update(`${session}:${row.step_index}:${line}`).digest("hex"), index: row.step_index as number };
    }
    return out;
  } catch { return empty; } finally { if (fd !== undefined) closeSync(fd); }
}

export const AGY_FACTS_HOOK: NativeFactsPort = { decode: decodeAgyHook, encode: encodeAgyHook, read: readAgyTranscript };
