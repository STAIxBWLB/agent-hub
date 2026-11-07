import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { NativeFactsInput, NativeFactsPort, NativeFactsReadOptions, NativeFactsTranscript } from "../registry-types.ts";

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
  // 1.4.2 names it view_file(AbsolutePath); 1.4.3+ renamed it read_file(Path, optional StartLine/EndLine/ByteOffset).
  const readPath = call?.name === "view_file" ? native?.AbsolutePath : call?.name === "read_file" ? native?.Path : undefined;
  const observedRead = typeof readPath === "string";
  // A line range or byte offset is a partial read: carry offset/limit so it never counts as a whole-file view.
  const hasStart = observedRead && Number.isSafeInteger(native?.StartLine) && (native!.StartLine as number) > 0;
  const hasEnd = observedRead && Number.isSafeInteger(native?.EndLine) && (native!.EndLine as number) > 0;
  const hasByteOffset = observedRead && Number.isSafeInteger(native?.ByteOffset) && (native!.ByteOffset as number) >= 0;
  const range = hasStart
    ? { offset: native!.StartLine as number, ...(hasEnd && (native!.EndLine as number) >= (native!.StartLine as number) ? { limit: (native!.EndLine as number) - (native!.StartLine as number) + 1 } : {}) }
    : hasEnd
      ? { offset: 1, limit: native!.EndLine as number }
      : hasByteOffset
        ? { offset: (native!.ByteOffset as number) + 1 }
        : {};
  // 1.4.2 names writes write_to_file(TargetFile, CodeContent); 1.4.3+ names them write_file(Path, Content, optional Append).
  const writePath = call?.name === "write_file" ? native?.Path : call?.name === "write_to_file" ? native?.TargetFile : undefined;
  const writeContent = call?.name === "write_file" ? native?.Content : call?.name === "write_to_file" ? native?.CodeContent : undefined;
  const observedWrite = typeof writePath === "string";
  // 1.4.2 names edits replace_file_content(TargetFile, TargetContent, ReplacementContent); 1.4.3+ names them edit_file(Path, Target, Replacement).
  const editPath = call?.name === "edit_file" ? native?.Path : call?.name === "replace_file_content" ? native?.TargetFile : undefined;
  const oldStr = call?.name === "edit_file" ? native?.Target : call?.name === "replace_file_content" ? native?.TargetContent : undefined;
  const newStr = call?.name === "edit_file" ? native?.Replacement : call?.name === "replace_file_content" ? native?.ReplacementContent : undefined;
  const observedEdit = typeof editPath === "string";
  const tool = observedRead ? "Read" : observedWrite ? "Write" : observedEdit ? "Edit" : typeof call?.name === "string" ? call.name : "";
  const input = observedRead
    ? { file_path: readPath, ...range }
    : observedWrite
      ? { file_path: writePath, ...(typeof writeContent === "string" && native?.Append !== true ? { content: writeContent } : {}) }
      : observedEdit
        ? { file_path: editPath, ...(typeof oldStr === "string" && typeof newStr === "string" ? { old_string: oldStr, new_string: newStr, replace_all: native?.AllowMultiple !== false } : {}) }
        : native ?? {};
  const phase = ({ SessionStart: "session", PreInvocation: "start", PostInvocation: "post", PreToolUse: "pre", PostToolUse: "post", Stop: "stop" } as const)[event as typeof EVENTS[number]];
  return { event: event as NativeFactsInput["event"], phase, sessionId: value.conversationId, transcriptPath: value.transcriptPath,
    workspacePaths: value.workspacePaths as string[], tool, input,
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
export function readAgyTranscript(session: string, transcript: string, options?: NativeFactsReadOptions): NativeFactsTranscript {
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
    if (options?.unchanged && stat.size === options.unchanged.size && stat.mtimeMs === options.unchanged.mtimeMs) return { factIds: [], size: stat.size, mtimeMs: stat.mtimeMs, unchanged: true };
    const hasSince = options?.sinceOffset !== undefined && options.sinceOffset >= 0 && options.sinceOffset <= stat.size;
    const resumeAt = options?.completion === false && hasSince ? options.sinceOffset! : 0;
    if (options?.completion === false && resumeAt === stat.size) return { factIds: [], size: stat.size, mtimeMs: stat.mtimeMs, scannedFrom: stat.size };
    // ponytail: completion and incremental ack lookback are capped at 4 MiB (as for Claude). A larger final row is unverified,
    // and >4 MiB appended between two readbacks advances the ack cursor to EOF; upgrade to a native forward cursor if needed.
    const cap = 4 * 1024 * 1024;
    for (let window = 64 * 1024; ; window = Math.min(cap, window * 2)) {
      const start = Math.max(resumeAt, stat.size - window), from = start > 0 ? start - 1 : 0;
      const buffer = Buffer.alloc(stat.size - from);
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = readSync(fd, buffer, bytes, buffer.length - bytes, from + bytes);
        if (!count) break;
        bytes += count;
      }
      const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
      // The preceding byte distinguishes a cut inside a row from a row beginning exactly at the window.
      if (start) lines.shift();
      let incompleteBytes = 0;
      if (lines.length === 0) {
        incompleteBytes = from + bytes - start;
      } else {
        const tail = lines[lines.length - 1]!, prev = lines.length > 1 ? lines[lines.length - 1 - 1]! : "";
        if (tail.length > 0) {
          try { JSON.parse(tail); } catch { incompleteBytes = Buffer.byteLength(tail, "utf8"); }
        } else if (prev.length > 0) {
          try { JSON.parse(prev); } catch { incompleteBytes = Buffer.byteLength(prev, "utf8") + 1; }
        }
      }
      const out: NativeFactsTranscript = { factIds: [], size: Math.max(resumeAt, from + bytes - incompleteBytes), mtimeMs: stat.mtimeMs, scannedFrom: window === cap && hasSince ? Math.min(start, options!.sinceOffset!) : start };
      for (const line of lines) {
        let row: unknown; try { row = JSON.parse(line); } catch { continue; }
        if (!record(row) || row.status !== "DONE") continue;
        if (row.source === "SYSTEM_SDK" && (row.type === "EPHEMERAL_MESSAGE" || row.type === "SYSTEM_MESSAGE") && typeof row.content === "string") {
          for (const match of row.content.matchAll(/agent-hub facts \[([a-zA-Z0-9-]{1,128})\]/g)) out.factIds.push(match[1]!);
        }
        if (row.source === "MODEL" && row.type === "PLANNER_RESPONSE" && Number.isSafeInteger(row.step_index) && (row.step_index as number) >= 0
          && Number.isSafeInteger(row.input_tokens) && (row.input_tokens as number) >= 0
          && Number.isSafeInteger(row.output_tokens) && (row.output_tokens as number) >= 0) {
          const inputTokens = row.input_tokens as number, outputTokens = row.output_tokens as number;
          const cacheReadTokens = Number.isSafeInteger(row.cache_read_tokens) && (row.cache_read_tokens as number) >= 0 ? (row.cache_read_tokens as number) : 0;
          const totalTokens = inputTokens + outputTokens + cacheReadTokens;
          if (Number.isSafeInteger(totalTokens)) {
            const at = typeof row.created_at === "string" && Number.isFinite(Date.parse(row.created_at)) ? row.created_at : undefined;
            (out.usage ??= []).push({ id: createHash("sha256").update(`${session}:usage:${row.step_index}`).digest("hex"), index: row.step_index as number, inputTokens, outputTokens, cacheReadTokens, totalTokens, ...(at ? { at } : {}) });
          }
        }
        if (options?.completion !== false && row.source === "MODEL" && row.type === "PLANNER_RESPONSE" && Number.isSafeInteger(row.step_index)
          && typeof row.content === "string" && row.content.trim().length > 0 && (!Array.isArray(row.tool_calls) || row.tool_calls.length === 0)) out.completion = { id: createHash("sha256").update(`${session}:${row.step_index}:${line}`).digest("hex"), index: row.step_index as number };
      }
      if ((out.completion && (!hasSince || start <= options!.sinceOffset!)) || start === resumeAt || window === cap) return out;
    }
  } catch { return empty; } finally { if (fd !== undefined) closeSync(fd); }
}

export const AGY_FACTS_HOOK: NativeFactsPort = { decode: decodeAgyHook, encode: encodeAgyHook, read: readAgyTranscript };
