// Cross-project task handoff (#604, agent-hub#1030). Pure: values in, values out, no clock, no file system, no socket. The daemon, the registry and the control client are
// passed in as data or as small ports, so every refusal here is testable without a second daemon and the policy cannot drift from what the daemon enforces.
import { createHash } from "node:crypto";
import { CLASSES, type TaskClass } from "./board.ts";

/**
 * What crosses projects, and nothing else: no memory, evidence, turn content or task history (#1030 design 5). The per-field limits alone allow about 13 KB, so `bodyBytes` is the real
 * ceiling on the whole request: a body that fills several fields is refused whole, and no partial task is built from it.
 */
export const HANDOFF_LIMITS = Object.freeze({ title: 300, detail: 4000, paths: 16, path: 512, issue: 2_000_000_000, bodyBytes: 8 * 1024, duplicateOk: 300 });
export const HANDOFF_FIELDS = Object.freeze(["project", "title", "class", "detail", "paths", "issue", "task", "duplicate_ok", "handoffKey"] as const);
/** #731 (agent-hub#1203): the origin's idempotency key for one handoff request, a lowercase UUID v4 (what `randomUUID` writes). */
export const HANDOFF_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type HandoffRefusalCode =
  | "invalid" | "too_large" | "unregistered" | "same_project" | "not_running" | "older_target" | "pii_turn" | "pii_task" | "no_authority" | "duplicate" | "outcome_unknown";

/** A refusal always names its reason, and for the person-fixable ones the action. The code is for tests and logs, the message for the caller. */
export class HandoffRefusal extends Error {
  constructor(readonly code: HandoffRefusalCode, message: string) { super(message); this.name = "HandoffRefusal"; }
}

/** `task` is the caller's OWN task this handoff comes from, so a `[pii]` one is refused and the target can name it in the follow-back. It never crosses as text. */
export interface HandoffRequest { title: string; class: TaskClass; detail: string; paths: string[]; issue?: number; task?: number;
  /** #1175: the sender's reason for filing a second task on a spec issue that already has an open one on the target's board. Absent means the target refuses a duplicate. */
  duplicate_ok?: string;
  /** #731: the key of this request. Absent means the origin mints one when the target understands keys; it crosses inside the request body only to a target that advertises `task_handoff_key`. */
  handoffKey?: string }

const hasControl = (text: string): boolean => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);

/**
 * Callers are models, and MCP schemas are not enforced on the way in: parse closed. An unknown field, an accessor or a non-plain object is refused, never dropped,
 * because a dropped field is a request the caller thinks it made. The result is sized, so an oversized body is refused whole and no partial task is built from it.
 */
export function parseHandoff(input: unknown): HandoffRequest & { project: string } {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)
    throw new HandoffRefusal("invalid", "handoff must be a plain data object");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!(HANDOFF_FIELDS as readonly string[]).includes(key)) throw new HandoffRefusal("invalid", `handoff has an unknown field: ${key.slice(0, 40)}`);
    if (!Object.hasOwn(descriptor, "value")) throw new HandoffRefusal("invalid", `handoff field ${key} is an accessor`);
  }
  const field = (name: (typeof HANDOFF_FIELDS)[number]): unknown => descriptors[name]?.value;
  const text = (value: unknown, name: string, max: number, required: boolean): string => {
    if (value === undefined || value === null || value === "") { if (required) throw new HandoffRefusal("invalid", `handoff ${name} is required`); return ""; }
    if (typeof value !== "string") throw new HandoffRefusal("invalid", `handoff ${name} must be text`);
    if (hasControl(value)) throw new HandoffRefusal("invalid", `handoff ${name} has control characters`);
    if (Buffer.byteLength(value, "utf8") > max * 4) throw new HandoffRefusal("too_large", `handoff ${name} is over ${max} characters`);
    if ([...value].length > max) throw new HandoffRefusal("too_large", `handoff ${name} is over ${max} characters`);
    return value;
  };
  const project = text(field("project"), "project", HANDOFF_LIMITS.path, true).trim();
  if (!project) throw new HandoffRefusal("invalid", "handoff project is required");
  const title = text(field("title"), "title", HANDOFF_LIMITS.title, true).replace(/\s+/g, " ").trim();
  if (!title) throw new HandoffRefusal("invalid", "handoff title is required");
  const detail = text(field("detail"), "detail", HANDOFF_LIMITS.detail, false);
  const cls = field("class") === undefined || field("class") === null || field("class") === "" ? "implement" : field("class");
  if (typeof cls !== "string" || !(CLASSES as readonly string[]).includes(cls)) throw new HandoffRefusal("invalid", `handoff class must be one of ${CLASSES.join(", ")}`);
  const rawPaths = field("paths");
  if (rawPaths !== undefined && rawPaths !== null && (!Array.isArray(rawPaths) || Object.keys(rawPaths).length !== rawPaths.length)) throw new HandoffRefusal("invalid", "handoff paths must be a dense list of text");
  if (Array.isArray(rawPaths) && rawPaths.length > HANDOFF_LIMITS.paths) throw new HandoffRefusal("too_large", `handoff has more than ${HANDOFF_LIMITS.paths} paths`);
  const paths = (Array.isArray(rawPaths) ? rawPaths : []).map(path => {
    const value = text(path, "path", HANDOFF_LIMITS.path, true).trim();
    // Paths are the target's, repository-relative: an absolute path or a parent step names a place on this machine, not a file in the target's tree.
    if (!value || value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]/).includes("..")) throw new HandoffRefusal("invalid", "handoff paths are repository-relative: no absolute path, ~ or ..");
    return value;
  });
  const rawIssue = field("issue");
  let issue: number | undefined;
  if (rawIssue !== undefined && rawIssue !== null && rawIssue !== "") {
    issue = typeof rawIssue === "string" && /^[1-9]\d{0,9}$/.test(rawIssue) ? Number(rawIssue) : rawIssue as number;
    if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1 || issue > HANDOFF_LIMITS.issue) throw new HandoffRefusal("invalid", "handoff issue must be a positive issue number in the target's repository");
  }
  const rawTask = field("task");
  let task: number | undefined;
  if (rawTask !== undefined && rawTask !== null && rawTask !== "") {
    task = typeof rawTask === "string" && /^[1-9]\d{0,9}$/.test(rawTask) ? Number(rawTask) : rawTask as number;
    if (typeof task !== "number" || !Number.isSafeInteger(task) || task < 1 || task > HANDOFF_LIMITS.issue) throw new HandoffRefusal("invalid", "handoff task must be a positive task id of this project");
  }
  const duplicateOk = text(field("duplicate_ok"), "duplicate_ok", HANDOFF_LIMITS.duplicateOk, false).replace(/\s+/g, " ").trim();
  if (field("duplicate_ok") !== undefined && field("duplicate_ok") !== null && field("duplicate_ok") !== "" && !duplicateOk) throw new HandoffRefusal("invalid", "handoff duplicate_ok needs a reason");
  const rawKey = field("handoffKey");
  if (rawKey !== undefined && rawKey !== null && rawKey !== "" && (typeof rawKey !== "string" || !HANDOFF_KEY.test(rawKey))) throw new HandoffRefusal("invalid", "handoff handoffKey must be a lowercase UUID v4");
  const handoffKey = typeof rawKey === "string" && rawKey ? rawKey : undefined;
  const request = { project, title, class: cls as TaskClass, detail, paths, ...(issue === undefined ? {} : { issue }), ...(task === undefined ? {} : { task }), ...(duplicateOk ? { duplicate_ok: duplicateOk } : {}), ...(handoffKey === undefined ? {} : { handoffKey }) };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > HANDOFF_LIMITS.bodyBytes) throw new HandoffRefusal("too_large", `handoff is over ${HANDOFF_LIMITS.bodyBytes} bytes`);
  return request;
}

/**
 * #731: what a key stands for. The target keeps this with the key, so a replay of the same key answers with the existing task, and the same key with a different request is refused, never
 * silently answered with a task the caller did not ask for. The key itself and the target are not part of it; the origin's own task id is.
 */
export function handoffRequestDigest(request: Pick<HandoffRequest, "title" | "class" | "detail" | "paths" | "issue" | "duplicate_ok">, originTask?: number): string {
  return createHash("sha256").update(JSON.stringify([request.title, request.class, request.detail, request.paths, request.issue ?? null, request.duplicate_ok ?? null, originTask ?? null])).digest("hex");
}

/**
 * #731 (H1): whether a control reply says the request may have reached the target without an answer coming back: the client's own timeout, or a connection that closed while the request was out.
 * A refusal the target wrote, and a request that was never sent, are definite and are not this. Reads the client's fixed wording (`control-client.ts`), never the target's text.
 */
export function handoffOutcomeUnknown(reply: { ok?: unknown; error?: unknown }): boolean {
  return reply.ok !== true && typeof reply.error === "string" && /^(no answer from the hub within \d+ s|hub connection closed)/.test(reply.error);
}

export interface RegisteredProject { id: string; root: string; stateDir: string }
export interface TargetDescriptor { features?: readonly string[]; instanceId?: string; projectId?: string; cwd?: string }

/**
 * The target is named by canonical root or id and must be registered. The caller's own project and an unregistered name are refused here, before anything is read from a
 * state directory. `canonical` resolves a typed path the way the registry does (`realPath`, never `realpathSync`), so a symlinked temporary root matches its registration.
 */
export function resolveTarget(name: string, projects: readonly RegisteredProject[], self: { id: string; root: string }, canonical: (path: string) => string): RegisteredProject {
  const typed = name.trim();
  let resolved: string | undefined;
  try { resolved = typed.startsWith("/") || typed.startsWith("~") || typed.startsWith(".") ? canonical(typed) : undefined; } catch { resolved = undefined; }
  const match = projects.find(project => project.id === typed || (resolved !== undefined && project.root === resolved));
  if (!match) throw new HandoffRefusal("unregistered", "that project is not in this machine's agent-hub registry; run `ahub projects` to see the registered ones, or `ahub up` in that project once");
  if (match.id === self.id || match.root === self.root) throw new HandoffRefusal("same_project", "that is this project: a task for this project goes through hub_task_propose");
  return match;
}

/** What the target's own status descriptor says. A daemon that is not running, or does not know the handoff, is refused with the person's action. */
export function checkTarget(project: RegisteredProject, descriptor: TargetDescriptor | undefined): void {
  if (!descriptor) throw new HandoffRefusal("not_running", `the hub of ${project.id} is not running; run \`ahub up\` in ${project.root}, then hand the task off again (handoffs are not queued)`);
  if (descriptor.projectId !== undefined && descriptor.projectId !== project.id) throw new HandoffRefusal("not_running", `the hub answering for ${project.root} belongs to another project; run \`ahub up\` in ${project.root}`);
  if (!descriptor.features?.includes("task_handoff")) throw new HandoffRefusal("older_target", `the hub of ${project.id} is too old to take a handoff (no task_handoff feature): upgrade the target hub with \`ahub upgrade\` in ${project.root}`);
}

/** The states a target reports back, in the order a task can reach them. `declined` is the owner passing; the task then returns to the target's routing, so it is information, not an end. */
export const HANDOFF_EVENTS = Object.freeze(["accepted", "in_review", "approved", "declined", "cancelled"] as const);
export type HandoffEvent = (typeof HANDOFF_EVENTS)[number];

/** Map a target's task history entry to the event the origin is told about, or undefined for every other entry. Reads only the event name and the task state, never a note. */
export function handoffEventFor(entryEvent: string, state: string): HandoffEvent | undefined {
  // The names are what `Tasks` writes (observed: accept writes "accepted", a done leaves the task in_review, the verdict writes "approved", a decline "declined", a cancel "cancelled").
  if (entryEvent === "accepted" && state === "in_progress") return "accepted";
  if (entryEvent === "declined") return "declined";
  if (entryEvent === "cancelled" && state === "cancelled") return "cancelled";
  if (entryEvent === "done" && state === "in_review") return "in_review";
  if (entryEvent === "approved" && state === "approved") return "approved";
  // A class with no reviewer: the done itself approves (`in_progress -> approved`), so the origin hears "approved" for that entry, not "in review".
  if (entryEvent === "done" && state === "approved") return "approved";
  return undefined;
}

const SHA = /^[0-9a-f]{40}$/;
/** One line, no free text from the target beyond a PR number and a head: `agent-hub task 123 approved: PR #7 at <sha>`. */
export function followBackLine(remoteTask: number, event: HandoffEvent, evidence: { pr?: unknown; head?: unknown } = {}): string {
  const pr = typeof evidence.pr === "number" && Number.isSafeInteger(evidence.pr) && evidence.pr > 0 ? ` PR #${evidence.pr}` : "";
  const head = typeof evidence.head === "string" && SHA.test(evidence.head) ? ` at ${evidence.head}` : "";
  return `agent-hub task ${remoteTask} ${event.replace("_", " ")}${pr || head ? `:${pr}${head}` : ""}`;
}

export interface DuplicateRow { id: number; state: string; title: string; detail?: string; refs?: { repo?: string }; external?: { repo: string; issue: number } | undefined; sdlc?: { issue?: number; repo?: string } | undefined }

/**
 * #1175: the ids of tasks already open on THIS board for the spec issue a handoff names. Pure: the caller passes the board's rows (a `[pii]` row is the caller's to leave out, so no
 * private task id is ever named to another project) and the project's own repository slug. A task counts when it is not closed and one of these names the issue: its lifecycle
 * receipt, a bare `#N` or an `owner/repo#N` of this repository in its title, or the `spec issue: #N in this repository` line a handoff keeps in its detail. A reference qualified
 * with another repository never counts, and a number that appears in a title as another kind of reference (a PR) is the one false positive: the sender's `duplicate_ok` answers it.
 */
export function duplicateIssueTasks(tasks: readonly DuplicateRow[], issue: number, repository?: string): number[] {
  const slug = (value: string | undefined): string | undefined => value !== undefined && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) ? value.toLowerCase() : undefined;
  // A project with no GitHub remote has a path, not a slug, for its repository: nothing can then be compared, so no row is foreign and no qualified reference matches.
  const own = slug(repository);
  const names = (text: string, bare: boolean): boolean => {
    for (const match of text.matchAll(/(?<![A-Za-z0-9_./-])(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)\b|#([1-9][0-9]*)\b)/g)) {
      const qualified = match[1];
      if (Number(match[2] ?? match[3]) !== issue) continue;
      if (qualified ? qualified.toLowerCase() === own : bare) return true;
    }
    return false;
  };
  return tasks.filter(task => {
    if (task.state === "approved" || task.state === "cancelled") return false;
    // The repository each identity belongs to: `sdlc.repo`, `external.repo` (an imported issue) and a slug `refs.repo` (a checkout path says nothing). One naming another repository
    // than this project's keeps its `#N` out: an issue number is only an identity together with its repository. With no own slug nothing can be compared, so the number counts and `duplicate_ok` answers.
    const foreign = (repo: string | undefined): boolean => own !== undefined && slug(repo) !== undefined && slug(repo) !== own;
    if (task.external?.issue === issue && !foreign(task.external.repo)) return true;
    if (task.sdlc?.issue !== undefined) return task.sdlc.issue === issue && !foreign(task.sdlc.repo) && !foreign(task.refs?.repo);
    if (foreign(task.external?.repo) || foreign(task.refs?.repo)) return false;
    const line = /(^|\n)spec issue: #([1-9][0-9]*) in this repository/.exec(task.detail ?? "");
    return names(task.title, true) || line !== null && Number(line[2]) === issue;
  }).map(task => task.id).sort((a, b) => a - b);
}

/** One refusal sentence that names the open tasks and both ways forward. The ids are this board's own; no title or text from a task is repeated. */
export function duplicateRefusalText(issue: number, ids: readonly number[]): string {
  const named = ids.slice(0, 6).map(id => `#${id}`).join(", ") + (ids.length > 6 ? ` and ${ids.length - 6} more` : "");
  return `spec issue #${issue} already has open ${ids.length === 1 ? "task" : "tasks"} here: ${named}. Use ${ids.length === 1 ? "it" : "them"} (ask the conductor there), or hand off again with duplicate_ok: <reason> (--duplicate-ok <reason> in the CLI) if this is genuinely separate work`;
}
