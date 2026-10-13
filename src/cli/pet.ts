import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recoveryLock, recoveryRunner } from "../hub/recovery-store.ts";
import { processLiveness } from "../pi/process-signature.ts";
import { characterAttentionLine } from "./attention.ts";
import type { CharacterId } from "../pet/frame.ts";
import type { NeedItem, NeedsSummary } from "../ui/needs.ts";

const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Parsed status metadata is copied by allowlist; source text and extra fields are never rendered. */
export function parseNeedsSummary(raw: unknown): NeedsSummary | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const row = raw as Record<string, unknown>;
  if (!count(row.act) || !count(row.watch) || typeof row.state !== "string" || !["waiting", "blocked", "review", "working", "idle", "sleeping"].includes(row.state)) return;
  let first: NeedItem | undefined;
  if (row.first !== undefined) {
    if (!row.first || typeof row.first !== "object" || Array.isArray(row.first)) return;
    const item = row.first as Record<string, unknown>;
    if (typeof item.kind !== "string" || typeof item.level !== "string" || !["approval", "default", "storage", "recovery", "delivery", "review", "budget", "offline"].includes(item.kind) || !["act", "watch"].includes(item.level)) return;
    if (item.peer !== undefined && !id(item.peer)) return;
    if (item.id !== undefined && !id(item.id) && !(count(item.id) && item.id > 0)) return;
    if (item.until !== undefined && !count(item.until) || item.since !== undefined && !count(item.since)) return;
    first = { kind: item.kind as NeedItem["kind"], level: item.level as NeedItem["level"],
      ...(item.peer !== undefined ? { peer: item.peer as string } : {}), ...(item.id !== undefined ? { id: item.id as string | number } : {}),
      ...(item.until !== undefined ? { until: item.until as number } : {}), ...(item.since !== undefined ? { since: item.since as number } : {}) };
  }
  if ((row.act + row.watch > 0) !== !!first) return;
  if (row.act > 0 && first?.level !== "act" || row.act === 0 && first?.level === "act") return;
  if (row.act === 0 && ["waiting", "blocked", "review"].includes(row.state) || row.act > 0 && ["working", "idle", "sleeping"].includes(row.state)) return;
  if (first?.level === "watch" && !["recovery", "budget", "offline"].includes(first.kind) || first?.level === "act" && ["budget", "offline"].includes(first.kind)) return;
  if (row.state === "waiting" && !["approval", "default"].includes(first?.kind ?? "")) return;
  if (row.state === "blocked" && !["storage", "recovery", "delivery"].includes(first?.kind ?? "")) return;
  if (row.state === "review" && first?.kind !== "review") return;
  return { act: row.act, watch: row.watch, state: row.state as NeedsSummary["state"], ...(first ? { first } : {}) };
}

export interface PetView { summary?: NeedsSummary; unavailable: boolean; runnerUnknown?: boolean }
export interface PetRecoveryReader { lock(): string | undefined; runner(id: string): number | "unknown" | undefined }
const recoveryReader: PetRecoveryReader = { lock: recoveryLock, runner: recoveryRunner };

/** A recovery lock is read-only evidence; this function never resumes or changes an operation. */
export function petView(status: unknown, reader: PetRecoveryReader = recoveryReader): PetView {
  const row = status && typeof status === "object" && !Array.isArray(status) ? status as Record<string, unknown> : undefined;
  const base = parseNeedsSummary(row?.needs);
  let operation: string | undefined;
  try { operation = reader.lock(); }
  catch { return { summary: base, unavailable: true, runnerUnknown: true }; }
  if (!operation) return { summary: base, unavailable: !base };
  if (!id(operation)) return { summary: base, unavailable: true, runnerUnknown: true };
  let runner: number | "unknown" | undefined;
  try { runner = reader.runner(operation); } catch { runner = "unknown"; }
  const active = runner !== undefined;
  const item: NeedItem = { kind: "recovery", level: active ? "watch" : "act", id: operation };
  const reported = row?.recovery;
  const included = base && reported && typeof reported === "object" && (reported as Record<string, unknown>).operationId === operation && base.watch > 0 ? 1 : 0;
  const act = (base?.act ?? 0) + (active ? 0 : 1), watch = (base?.watch ?? 0) - included + (active ? 1 : 0);
  const first = base?.first;
  const precedes = !active && (!first || first.level === "watch" || !["approval", "default", "storage"].includes(first.kind));
  const selected = precedes || first?.kind === "recovery" && first.id === operation ? item : first ?? item;
  const state = !active && base?.state !== "waiting" ? "blocked" : base?.state ?? "sleeping";
  return { summary: { act, watch, state, first: selected }, unavailable: !base, ...(runner === "unknown" ? { runnerUnknown: true } : {}) };
}

export function readPet(stateDir: string, reader: PetRecoveryReader = recoveryReader, alive = processLiveness): PetView {
  let status: unknown;
  try {
    const row = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    const summary = parseNeedsSummary(row.needs);
    const expired = summary?.first?.kind === "approval" && summary.first.until !== undefined && summary.first.until <= Date.now();
    if (!expired && Number.isSafeInteger(row.pid) && row.pid > 0 && alive(row.pid, row.pidSignature) === "live") status = row;
  } catch { /* Missing, malformed or unconfirmed owner data is unavailable, never an empty live hub. */ }
  return petView(status, reader);
}

export function renderPet(view: PetView, short = false, character: CharacterId = "stai"): string {
  if (short) return view.summary?.act ? `ahub!${view.summary.act}` : "";
  if (!view.summary) return "attention unavailable";
  const value = view.summary;
  const line = characterAttentionLine({ ...value, items: value.first ? [value.first] : [] }, character, 0, false, false);
  return line + (view.unavailable ? " (status unavailable)" : "") + (view.runnerUnknown ? " (runner unknown)" : "");
}
