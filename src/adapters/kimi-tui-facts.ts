import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import { realPath } from "../hub/project.ts";
import type { NativeFactsInput, NativeFactsPort, NativeFactsTranscript } from "./registry-types.ts";

const EVENTS = ["TurnStarted", "Stop", "StopFailure", "Interrupt", "SessionEnd", "TaskStarted", "Notification"] as const;
const SESSION = /^session_[A-Za-z0-9_-]{1,120}$/;
const AGENT = /^[A-Za-z0-9._-]{1,64}$/;
const TASK = /^[A-Za-z0-9._:-]{1,128}$/;
const INDEX_CAP = 16 * 1024 * 1024;
const WIRE_CAP = 8 * 1024 * 1024;
const TASK_CAP = 64 * 1024;
const MAX_AGENTS = 256;
const MAX_TASKS = 256;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };

export function decodeKimiTuiHook(event: string, value: unknown): NativeFactsInput | undefined {
  if (!(EVENTS as readonly string[]).includes(event) || !record(value) || value.hook_event_name !== event || value.client_type !== "kimi_code_cli"
    || typeof value.session_id !== "string" || !SESSION.test(value.session_id) || typeof value.cwd !== "string" || !isAbsolute(value.cwd) || value.cwd.length > 4096) return;
  if ((event === "TurnStarted" || event === "Interrupt") && !integer(value.turn_id)) return;
  if (event === "TaskStarted" && (typeof value.task_id !== "string" || !TASK.test(value.task_id))) return;
  const home = process.env.KIMI_CODE_HOME ?? join(process.env.HOME ?? homedir(), ".kimi-code");
  const transcriptPath = value.agentHubTranscriptPath ?? join(home, "session_index.jsonl");
  if (typeof transcriptPath !== "string" || !isAbsolute(transcriptPath) || transcriptPath.length > 4096) return;
  const phase = ({ TurnStarted: "start", Stop: "stop", StopFailure: "stop", Interrupt: "stop", SessionEnd: "session", TaskStarted: "pre", Notification: "post" } as const)[event as typeof EVENTS[number]];
  return { event: event as NativeFactsInput["event"], phase, sessionId: value.session_id, transcriptPath, workspacePaths: [value.cwd], tool: "", input: {} };
}

export function encodeKimiTuiHook(): undefined { return undefined; }

function readBytes(path: string, cap: number, tail = false): Buffer {
  const link = lstatSync(path);
  if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1) throw new Error("not a regular file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (!tail && stat.size > cap)) throw new Error("invalid file");
    const length = Math.min(stat.size, cap), start = tail ? stat.size - length : 0;
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, start + offset);
      if (count <= 0) throw new Error("short read");
      offset += count;
    }
    return bytes;
  } finally { closeSync(fd); }
}

function sessionDirectory(index: string, session: string): string {
  const home = dirname(index), sessions = realPath(join(home, "sessions"));
  let listed: string | undefined;
  for (const line of readBytes(index, INDEX_CAP).toString("utf8").split("\n")) {
    if (!line.includes(session)) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (record(row) && row.sessionId === session && typeof row.sessionDir === "string") {
      if (listed) throw new Error("duplicate session");
      listed = row.sessionDir;
    }
  }
  if (!listed) throw new Error("session not indexed");
  const directory = realPath(listed);
  if (!inside(sessions, directory)) throw new Error("session outside home");
  return directory;
}

function taskInventory(agents: string): number {
  let active = 0;
  const names = readdirSync(agents, { withFileTypes: true });
  if (names.length > MAX_AGENTS) throw new Error("too many agents");
  for (const entry of names) {
    if (!AGENT.test(entry.name)) continue;
    if (!entry.isDirectory()) continue;
    const tasks = join(agents, entry.name, "tasks");
    const dir = lstatSync(tasks, { throwIfNoEntry: false });
    if (!dir) continue;
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("invalid task directory");
    const files = readdirSync(tasks).filter(name => name.endsWith(".json")).sort();
    if (files.length > MAX_TASKS) throw new Error("too many tasks");
    for (const name of files) {
      if (!TASK.test(name.slice(0, -5))) throw new Error("invalid task name");
      const row: unknown = JSON.parse(readBytes(join(tasks, name), TASK_CAP).toString("utf8"));
      if (!record(row) || row.taskId !== name.slice(0, -5) || typeof row.status !== "string") throw new Error("invalid task");
      if (row.status === "running" && row.endedAt === null) { active++; continue; }
      const terminal = ["completed", "failed", "cancelled"].includes(row.status) && integer(row.endedAt);
      if (!terminal) throw new Error("unknown task state");
    }
  }
  return active;
}

interface Prompt { turn: number; id: string; origin: string }
interface End { turn: number; reason: "completed" | "failed" | "cancelled" }
const empty = (): NativeFactsTranscript => ({ factIds: [] });

export function readKimiTuiTranscript(session: string, index: string): NativeFactsTranscript {
  if (!SESSION.test(session) || basename(index) !== "session_index.jsonl" || !isAbsolute(index)) return empty();
  try {
    const directory = sessionDirectory(index, session);
    const wire = join(directory, "agents", "main", "wire.jsonl");
    if (!inside(directory, realPath(wire))) return empty();
    const bytes = readBytes(wire, WIRE_CAP, true);
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 10) return empty();
    const lines = bytes.toString("utf8").split("\n");
    if (bytes.length === WIRE_CAP && !lines[0]?.startsWith('{"type":"metadata"')) lines.shift();
    const prompts = new Map<number, Prompt>();
    const ends = new Map<number, End>();
    const promptEnds = new Map<string, "completed" | "failed" | "cancelled">();
    const promptEndTurnIds = new Map<number, string>();
    let started: Prompt | undefined;
    for (const line of lines) {
      if (!line || !/"(?:turn\.prompt|turn\.ended|prompt\.completed|prompt\.aborted)"/.test(line)) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { return empty(); }
      if (!record(row)) return empty();
      if (row.type === "turn.prompt" && integer(row.turnId) && record(row.origin) && typeof row.origin.kind === "string") {
        const turn = row.turnId, id = typeof row.promptId === "string" ? row.promptId : typeof row.origin.notificationId === "string" ? row.origin.notificationId : `turn-${turn}`;
        const prompt = { turn, id, origin: row.origin.kind };
        prompts.set(turn, prompt); started = prompt;
      } else if (row.type === "turn.ended" && integer(row.turnId) && ["completed", "failed", "cancelled"].includes(String(row.reason))) {
        const turn = row.turnId;
        ends.set(turn, { turn, reason: row.reason as End["reason"] });
      } else if (row.type === "prompt.completed" && typeof row.promptId === "string" && ["completed", "failed"].includes(String(row.reason))) {
        promptEnds.set(row.promptId, row.reason as "completed" | "failed");
        if (integer(row.turnId)) promptEndTurnIds.set(row.turnId, row.promptId);
      } else if (row.type === "prompt.aborted" && typeof row.promptId === "string") {
        promptEnds.set(row.promptId, "cancelled");
        if (integer(row.turnId)) promptEndTurnIds.set(row.turnId, row.promptId);
      } else if (row.type === "turn.prompt" || row.type === "turn.ended") return empty();
    }
    let completion: NativeFactsTranscript["completion"];
    for (const [turn, end] of ends) {
      const prompt = prompts.get(turn), promptReason = prompt ? promptEnds.get(prompt.id) : undefined, turnPromptId = promptEndTurnIds.get(turn);
      if (!prompt || promptReason !== undefined && promptReason !== end.reason || turnPromptId !== undefined && turnPromptId !== prompt.id) continue;
      completion = { id: createHash("sha256").update(`${session}:${turn}:${prompt.id}:${end.reason}`).digest("hex"), index: turn, reason: end.reason };
    }
    return {
      factIds: [],
      ...(completion ? { completion } : {}),
      ...(started ? { started: { id: createHash("sha256").update(`${session}:${started.turn}:${started.id}`).digest("hex"), index: started.turn, origin: started.origin } } : {}),
      background: taskInventory(join(directory, "agents")),
    };
  } catch { return empty(); }
}

export const KIMI_TUI_FACTS_HOOK: NativeFactsPort = { decode: decodeKimiTuiHook, encode: encodeKimiTuiHook, read: readKimiTuiTranscript };
