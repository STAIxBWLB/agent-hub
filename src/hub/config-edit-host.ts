import { configBackups, parseConfigEditRequest, viewRevisions, planConfigEdit, writeConfigEdit, type CandidateCheck, type ConfigEditPlan } from "./config-edit.ts";
import { configTier, maskTier3, TIER2_INSTANCE_FIELDS, TIER3_INSTANCE_FIELDS, TIER3_PREFIXES, type ConfigEditFile } from "./config-tier.ts";
import type { HubEvent } from "./events.ts";
import { types } from "node:util";
import { sdlcConfig } from "./sdlc.ts";
import { USER } from "./envelope.ts";
import { VERSION } from "../version.ts";

/**
 * #689: the daemon's side of structural config edits. Everything the daemon decides is here, with its ports injected, so the
 * daemon itself carries only a few lines of wiring: who may edit (authority), the typed confirmation for tier 3, the hold during
 * recovery or shutdown, the audit event and the scoped reload that applies or marks each key.
 */
export type EditAuthority = "ordinary" | "settings" | "terminal";
export interface ConfigEditHost {
  cwd: string;
  stateDir: string;
  /** The loaders' verdict on a candidate file; throws the loader's reason. */
  check: CandidateCheck;
  /** A reason edits are held now (recovery or shutdown), or undefined. */
  held: () => string | undefined;
  /** Publishes one changed key through the daemon's only reload path, scoped to it. */
  reload: (authority: EditAuthority, key: string) => Promise<Record<string, unknown>>;
  /** Legacy callbacks may return void; the instructed path requires true as its durable result acknowledgement. */
  event: (event: Extract<HubEvent, { type: "config_edit" }>) => unknown;
  notify: (text: string) => void;
  /** Called after a write so status.json and the console snapshot show what is now pending. */
  changed: () => void;
  /** What waits for a restart now, from the reload's own bookkeeping (instance declarations are restart-bound). */
  pending: () => { key: string; reason: string }[];
  /** The running hub's value at a config path, for the form. */
  effective: (path: readonly string[]) => unknown;
  /** The lifecycle the running hub holds, to say what a changed sdlc.toml waits for. */
  runningSdlc: () => { mode: string; requiredChecks: readonly string[] };
  /** The lifecycle the file would give at the next start, or the loader's reason. */
  fileSdlc: () => { mode: string; requiredChecks: readonly string[] } | string;
  /** The declared instances of the running hub: id to its tier 2 fields. */
  declared: () => Record<string, Record<string, unknown>>;
  /** config.local.json as the file holds it now, parsed once per call (`{}` when it is missing or unreadable). Never sent anywhere: it is read for what is set, never shown. */
  localConfig: () => Record<string, unknown>;
  /** Host-owned current unique conductor, excluding private input. Not a request field. */
  conductor?: () => string | undefined;
  /** Durable intent must exist before this narrow conductor write. Values never enter it. */
  recordSdlcInstruction?: (by: string, paths: string[]) => boolean;
}
export interface ConfigEditView {
  revisions: Record<ConfigEditFile, string>;
  instances: { id: string; fields: Record<string, unknown>; tier3: string[] }[];
  /** The instance ids config.local.json holds now, including ones the running hub has not started with yet: the forms change those leaf by leaf. */
  known: string[];
  blocks: { path: string; value: unknown }[];
  sdlc: { mode: string; requiredChecks: readonly string[]; pending: boolean; problem?: string };
  /** Tier 3 keys with the console command that changes them; the dashboard shows exactly this, read-only. */
  tier3: { key: string; set: boolean; command: string }[];
  backups: { name: string; file: ConfigEditFile; at: number; bytes: number }[];
  fields: { instance: readonly string[]; tier3Instance: readonly string[] };
}
const REASON_BYTES = 400;
const BLOCKS: readonly (readonly string[])[] = [["review", "adaptive"], ["review", "min_reviews"], ["review", "pool"], ["review", "rerotate"], ["review", "same_family"], ["snapshots", "keep"], ["approvals", "timeout_s"], ["context", "gate"]];

export const CONFIG_EDIT_OPS = ["config_edit_get", "config_edit_preview", "config_edit_apply"] as const;

export function createConfigEditor(host: ConfigEditHost) {
  const sdlcPending = (): boolean => {
    const file = host.fileSdlc(), running = host.runningSdlc();
    return typeof file !== "string" && (file.mode !== running.mode || JSON.stringify(file.requiredChecks) !== JSON.stringify(running.requiredChecks));
  };
  /** What a changed sdlc.toml waits for: shown with the other pending restarts. */
  const sdlcRestart = (): { key: string; reason: string }[] => {
    const file = host.fileSdlc(), running = host.runningSdlc();
    if (typeof file === "string") return [];
    return [...(file.mode !== running.mode ? [{ key: "sdlc.mode", reason: "the lifecycle is read once at hub start" }] : []),
      ...(JSON.stringify(file.requiredChecks) !== JSON.stringify(running.requiredChecks) ? [{ key: "sdlc.required_checks", reason: "the lifecycle is read once at hub start" }] : [])];
  };
  const pendingRestart = (): { key: string; reason: string }[] => sdlcRestart();
  const allPending = (): string[] => [...host.pending().map(row => row.key), ...sdlcRestart().map(row => row.key)];
  function view(): ConfigEditView {
    const file = host.fileSdlc(), running = host.runningSdlc();
    let local: Record<string, unknown> = {};
    try { local = host.localConfig(); } catch { /* the revisions say the file is unavailable */ }
    const fileInstances = local.instances && typeof local.instances === "object" && !Array.isArray(local.instances) ? Object.keys(local.instances) : [];
    const isSet = (path: readonly string[]): boolean => { let node: unknown = local; for (const part of path) { if (!node || typeof node !== "object" || !Object.hasOwn(node, part)) return false; node = (node as Record<string, unknown>)[part]; } return node !== undefined; };
    const declared = host.declared();
    return {
      revisions: viewRevisions(host.cwd),
      known: fileInstances,
      instances: Object.entries(declared).map(([id, fields]) => ({ id, fields: Object.fromEntries(TIER2_INSTANCE_FIELDS.filter(field => fields[field] !== undefined).map(field => [field, fields[field]])),
        tier3: TIER3_INSTANCE_FIELDS.filter(field => fields[field] !== undefined) as string[] })),
      blocks: BLOCKS.map(path => ({ path: path.join("."), value: host.effective(path) ?? null })),
      sdlc: { mode: running.mode, requiredChecks: running.requiredChecks, pending: sdlcPending(), ...(typeof file === "string" ? { problem: file } : {}) },
      tier3: [...TIER3_PREFIXES.map(key => ({ key, set: isSet(key.split(".")), command: `ahub settings edit config.local.json set ${key} <json>` })),
        ...Object.entries(declared).flatMap(([id, fields]) => TIER3_INSTANCE_FIELDS.filter(field => fields[field] !== undefined).map(field => ({ key: `instances.${id}.${field}`, set: true, command: `ahub settings edit config.local.json set instances.${id}.${field} <json>` })))],
      backups: configBackups(host.stateDir).slice(0, 10),
      fields: { instance: TIER2_INSTANCE_FIELDS, tier3Instance: TIER3_INSTANCE_FIELDS },
    };
  }
  /** A refusal before any loader runs: an unauthorized or unclassifiable request learns nothing about the project. */
  function authorize(raw: unknown, authority: EditAuthority): { ok: true; tier3: string[] } | { ok: false; error: string } {
    if (authority === "ordinary") return { ok: false, error: "structural config edits need a settings session: open one with ahub ui --settings, or use the console" };
    const request = parseConfigEditRequest(raw);
    if (typeof request === "string") return { ok: false, error: request };
    const tier3: string[] = [];
    for (const { path, value } of request.set) {
      const tier = configTier(request.file, path, value);
      if ("refused" in tier) return { ok: false, error: tier.refused };
      if (tier.tier === 3) tier3.push(tier.key);
    }
    if (tier3.length && authority !== "terminal") return { ok: false, error: `${tier3[0]} chooses what the hub runs or where secrets go: it is never editable from the dashboard; change it in the console (ahub settings edit config.local.json set ${tier3[0]} <json>)` };
    if (tier3.length > 1) return { ok: false, error: "change one executable or secret-locating key at a time: each needs its own typed confirmation" };
    return { ok: true, tier3 };
  }
  function planned(raw: unknown, authority: EditAuthority): { ok: true; plan: Extract<ConfigEditPlan, { ok: true }> } | { ok: false; error: string; field?: string } {
    const allowed = authorize(raw, authority);
    if (!allowed.ok) return allowed;
    const held = host.held();
    if (held) return { ok: false, error: `${held} is holding config edits` };
    const plan = planConfigEdit(host.cwd, raw, host.check);
    if (!plan.ok) return plan;
    // The plan reads the file itself: if it finds a tier 3 key the request alone did not show, a dashboard still learns nothing.
    if (plan.tier === 3 && authority !== "terminal") return { ok: false, error: `${plan.tier3Keys[0]} chooses what the hub runs or where secrets go: it is never editable from the dashboard; change it in the console` };
    // The request names some tier 3 keys and the file adds others (an instance it holds a home for): one write changes exactly one, and each is typed.
    if (plan.tier3Keys.length > 1) return { ok: false, error: "change one executable or secret-locating key at a time: each needs its own typed confirmation" };
    return { ok: true, plan };
  }
  function diffText(plan: Extract<ConfigEditPlan, { ok: true }>): string[] {
    const show = (path: string, value: unknown): string => { const masked = maskTier3(path.split("."), value); return masked === undefined ? "(unset)" : JSON.stringify(masked); };
    return plan.diff.map(row => `${row.path}: ${show(row.path, row.before)} -> ${show(row.path, row.after)} (${row.applies === "restart" ? "pending restart" : "applies at next use"})`);
  }
  function preview(raw: unknown, authority: EditAuthority): Record<string, unknown> {
    const result = planned(raw, authority);
    if (!result.ok) return { ok: false, error: result.error, ...(result.field ? { field: result.field } : {}) };
    const { plan } = result;
    return { ok: true, file: plan.request.file, revision: plan.request.revision, tier: plan.tier, lines: [...diffText(plan), ...plan.notes],
      diff: plan.diff.map(row => ({ path: row.path, tier: row.tier, applies: row.applies, before: maskTier3(row.path.split("."), row.before) ?? null, after: maskTier3(row.path.split("."), row.after) ?? null })),
      ...(plan.tier === 3 ? { confirm: plan.tier3Keys[0], warning: "this runs code with the daemon's rights, or chooses where secrets are read from" } : {}) };
  }
  async function applyInternal(raw: unknown, authority: EditAuthority, confirm?: unknown, rawReason?: unknown,
    instruction?: { by: string; current: () => void }): Promise<Record<string, unknown>> {
    let reason: string | undefined;
    if (rawReason !== undefined) {
      if (typeof rawReason !== "string" || !rawReason.trim() || Buffer.byteLength(rawReason) > REASON_BYTES) return { ok: false, error: `reason must contain 1..${REASON_BYTES} UTF-8 bytes` };
      reason = rawReason.trim().replace(/[\x00-\x1f\x7f]/g, " ");
    }
    const result = planned(raw, authority);
    if (!result.ok) return { ok: false, error: result.error, ...(result.field ? { field: result.field } : {}) };
    const { plan } = result;
    if (plan.tier === 3 && confirm !== plan.tier3Keys[0]) return { ok: false, error: `${plan.tier3Keys[0]} runs code with the daemon's rights or locates secrets: type the key name to confirm; nothing was written`, confirm: plan.tier3Keys[0] };
    if (instruction) {
      try {
        instruction.current();
        const before = sdlcConfig(plan.before === null ? undefined : Bun.TOML.parse(plan.before), VERSION);
        if (plan.request.file !== "sdlc.toml" || plan.diff.some(row => !["sdlc.mode", "sdlc.required_checks"].includes(row.path)))
          throw new Error("only mode and required_checks may change through sdlc configure");
        if (before.mode === "enforce" || host.runningSdlc().mode === "enforce")
          throw new Error("enforce remains person-only; ask the person to edit .agenthub/sdlc.toml");
        instruction.current();
        let retained = false;
        try { retained = host.recordSdlcInstruction?.(instruction.by, plan.diff.map(row => row.path)) === true; } catch { /* no write without a retained intent */ }
        if (!retained)
          throw new Error("SDLC instruction audit unavailable; nothing was written");
        instruction.current();
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "SDLC configuration authority unavailable; nothing was written" }; }
    }
    let written: ReturnType<typeof writeConfigEdit>;
    try { written = writeConfigEdit(host.cwd, host.stateDir, plan); }
    catch (error) { return { ok: false, error: `${(error as Error).message}; nothing was changed` }; }
    const source = instruction && instruction.by !== USER ? "conductor" as const : authority === "terminal" ? "terminal" as const : "dashboard" as const;
    try {
      const retained = host.event({ type: "config_edit", file: plan.request.file, paths: written.paths, fileBefore: written.fileBefore, fileAfter: written.fileAfter, tier: plan.tier, by: instruction?.by ?? "person", source, ...(instruction ? { instructionClaim: "person_direct_instruction" as const } : {}), ...(written.backup ? { backup: written.backup } : {}), ...(reason ? { reason } : {}) });
      if (instruction && retained !== true) throw new Error("SDLC result audit was not retained");
    } catch (error) {
      if (!instruction) throw error;
      return { ok: false, saved: true, error: "SDLC configuration was saved after its instruction intent, but the result audit failed; inspect the config and event log before retrying" };
    }
    try { host.notify(`config edit: ${plan.request.file} ${plan.diff.map(row => row.path).join(", ")} (${source})`); } catch { /* the write stands */ }
    const settled = () => { try { host.changed(); } catch { /* the write stands; the next status write shows it */ } };
    if (plan.request.file === "sdlc.toml") { settled(); return { ok: true, saved: true, ...(written.backup ? { backup: written.backup } : {}), lines: diffText(plan), text: `sdlc.toml written; the lifecycle is read once at hub start: restart pending`, restartPending: allPending() }; }
    const failures: string[] = [];
    for (const key of leafKeys(plan)) {
      let reloaded: Record<string, unknown>;
      try { reloaded = await host.reload(authority, key); } catch { reloaded = { ok: false, error: "the change was saved but could not be published; inspect hub.log" }; }
      if (reloaded.ok !== true) failures.push(`${key}: ${String(reloaded.error ?? "not published")}`);
    }
    settled();
    if (failures.length) return { ok: false, saved: true, error: `saved, but not published: ${failures.join("; ")}; run ahub settings reload to review it`, ...(written.backup ? { backup: written.backup } : {}) };
    return { ok: true, saved: true, ...(written.backup ? { backup: written.backup } : {}), lines: diffText(plan), text: `config.local.json written: ${plan.diff.map(row => row.path).join(", ")}${plan.diff.some(row => row.applies === "restart") ? "; restart pending" : ""}`, restartPending: allPending() };
  }
  const apply = (raw: unknown, authority: EditAuthority, confirm?: unknown, reason?: unknown) => applyInternal(raw, authority, confirm, reason);
  /** #1432: cooperative own-session instruction claim, never consent inferred from a task or file. */
  async function configureSdlc(by: string, input: unknown, current: () => void): Promise<Record<string, unknown>> {
    const guard = () => {
      current();
      const conductor = host.conductor?.();
      if (by !== USER && (!by || !conductor || conductor !== by)) throw new Error("only the person or current unique conductor may configure SDLC");
      const held = host.held(); if (held) throw new Error(`${held} is holding config edits`);
    };
    try {
      guard();
      if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)
        throw new Error("sdlc configure accepts mode, required_checks and an explicit instruction claim");
      const fields = Object.getOwnPropertyDescriptors(input), values: Record<string, unknown> = Object.create(null);
      for (const [key, field] of Object.entries(fields)) {
        if (!["mode", "required_checks", "instructionClaim"].includes(key) || !Object.hasOwn(field, "value") || !field.enumerable)
          throw new Error("sdlc configure accepts only mode and required_checks; protected settings remain person-only");
        values[key] = field.value;
      }
      if (values.instructionClaim !== true) throw new Error("sdlc configure requires the person's explicit instruction in this session; relays, tasks and files do not qualify");
      if (values.mode !== undefined && values.mode !== "off" && values.mode !== "advise")
        throw new Error("sdlc.mode: this path accepts off or advise; ask the person to edit .agenthub/sdlc.toml for enforce");
      if (Object.hasOwn(values, "required_checks")) {
        const checks = values.required_checks;
        const invalidChecks = () => ({ ok: false, field: "sdlc.required_checks", error: "sdlc.required_checks: expected a list of check names" });
        if (!Array.isArray(checks) || types.isProxy(checks) || Object.getPrototypeOf(checks) !== Array.prototype || Object.getOwnPropertySymbols(checks).length) return invalidChecks();
        const fields = Object.getOwnPropertyDescriptors(checks);
        if (Object.keys(fields).length !== checks.length + 1 || Object.entries(fields).some(([key, field]) => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= checks.length || !Object.hasOwn(field, "value") || !field.enumerable))) return invalidChecks();
        try { values.required_checks = sdlcConfig({ required_checks: checks }, VERSION).requiredChecks; }
        catch (error) { return { ok: false, field: "sdlc.required_checks", error: error instanceof Error ? error.message : "sdlc.required_checks: invalid list of check names" }; }
      }
      const set = ["mode", "required_checks"].filter(key => Object.hasOwn(values, key)).map(key => ({ path: [key], value: values[key] }));
      if (!set.length) throw new Error("sdlc configure needs mode or required_checks");
      guard();
      const raw = { file: "sdlc.toml", revision: viewRevisions(host.cwd)["sdlc.toml"], set };
      const result = await applyInternal(raw, "terminal", undefined, undefined, { by, current: guard });
      return result.ok === true ? { ...result, by, instructionClaim: "person_direct_instruction" } : result;
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "SDLC configuration unavailable; nothing was written" }; }
  }
  return { view, preview, apply, configureSdlc, pendingRestart };
}

/** The leaf keys a plan changed, so each is published through its own scoped reload. */
function leafKeys(plan: Extract<ConfigEditPlan, { ok: true }>): string[] {
  const out = new Set<string>();
  const walk = (prefix: string, before: unknown, after: unknown): void => {
    if (prefix === "research.runners") { out.add(prefix); return; }
    const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
    if (object(before) || object(after)) {
      const old = object(before) ? before : {}, next = object(after) ? after : {};
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) walk(`${prefix}.${key}`, old[key], next[key]);
      return;
    }
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) out.add(prefix);
  };
  for (const row of plan.diff) walk(row.path, row.before, row.after);
  return [...out];
}
