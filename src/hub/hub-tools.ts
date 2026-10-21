import { SDLC_STAGES } from "./sdlc.ts";
import { projectProfile, profileData, PROFILE_CLASS_NAMES, type ProfileName, type ProfileSelection } from "./profiles.ts";
import { catalogSection, type CatalogRole } from "./roles.ts";
import { CONDUCTOR_START_PEERS, defaultPeerRoles } from "../adapters/registry.ts";
// The hub's task tools, defined once: the MCP server (Claude plugin, Kimi, Codex) and the local worker both read this.
import { NOTE_KINDS } from "./envelope.ts";

/** Shared communication rule for channel and tool-only sessions. */
export const ACTIONABLE_MESSAGE_INSTRUCTION = "Do not use [FYI] for PR ready, done, submitted, ruling needed, blocker, or changed contract or path messages: each requires action from the recipient. Use [FYI] only for progress or information that needs no action. hub_task_done and hub_review already notify the assigned recipients; no duplicate hub_send chat is needed.";

const str = { type: "string" } as const;
const id = { type: "integer", description: "task id" } as const;
const refs = {
  type: "object",
  description: "where the work lives",
  properties: { repo: { type: "string", description: "owner/name repository slug or checkout path; set for work in another repository" }, branch: str, commit: str, paths: { type: "array", items: str } },
  additionalProperties: false,
} as const;
const list = (description: string) => ({ type: "array", items: str, description }) as const;
const reviewFindings = {
  type: "array", maxItems: 64,
  description: "Head-bound findings; omitted ids stay open. accepted is person-only and requires rationale. Nit count is capped by sdlc.max_nits (default 5).",
  items: { type: "object", properties: {
    id: { type: "string", minLength: 1, maxLength: 96, pattern: "^[A-Za-z0-9._:-]+$" },
    pass: { type: "string", enum: ["bugs", "security", "compliance"] },
    severity: { type: "string", enum: ["important", "nit"] },
    path: { type: "string", minLength: 1, maxLength: 512 },
    disposition: { type: "string", enum: ["open", "fixed", "false_positive", "accepted"] },
    rationale: { type: "string", minLength: 1, maxLength: 2048 },
  }, required: ["id", "pass", "severity", "disposition"], additionalProperties: false },
} as const;
const costPlanProperties = {
  review: { type: "object", properties: { scope: { type: "string", enum: ["none", "delta", "full"] }, reviewers: { type: "integer", minimum: 0, maximum: 8 } }, required: ["scope", "reviewers"], additionalProperties: false },
  ci: { type: "string", enum: ["focused", "full", "reuse"] },
} as const;
const plan = {
  type: "object",
  description: "what you will change, before you start. Owners of open tasks on the same files or symbols see it, and get a notice when your task is done.",
  properties: {
    paths: list("files you will edit or create"),
    symbols: list("functions, types or other names you will change, as they appear in code (e.g. Bus.publish)"),
    signatures: list("new or changed signatures, as you will write them"),
    insertion_points: list("where new code goes (file and the function or line it follows)"),
  },
  additionalProperties: false,
} as const;

// Accept may target a task from an older project profile; Tasks normalizes by the stored task profile.
const acceptPlan = { ...plan, properties: { ...plan.properties, sections: list("document heading anchors, such as report.md#methods"), sources: list("citation ids, DOI or source URL ids"), claims: list("short claim ids to verify") } } as const;

export interface HubTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
}

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): HubTool => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});

export const BOUNDED_TASK_TOOLS = new Set(["hub_task_spec", "hub_check_start", "hub_check_result", "hub_check_cancel"]);

export const TASK_TOOLS: HubTool[] = [
  tool("hub_task_spec", "Read complete assigned GitHub issue contracts through the bounded hub boundary. Owner/reviewer only; no repository or URL input. Refuses withheld or oversized specs.", { id }, ["id"]),
  tool("hub_check_start", "Run an exact-head isolated Linux check for your in-progress task. Trusted opt-in runner only; no host shell or credentials. Tests require one to 32 test/*.test.ts paths. Receipt is Linux evidence.", { id, check: { type: "string", enum: ["test", "typecheck"] }, files: { type: "array", minItems: 1, maxItems: 32, items: str } }, ["id", "check"]),
  tool("hub_check_result", "Read your current task-bound isolated check receipt. Stale ownership/generation refuses; output is policy screened.", { run: str }, ["run"]),
  tool("hub_check_cancel", "Cancel your task-bound isolated check; only its owner or the person may cancel.", { run: str }, ["run"]),
  tool("hub_delivery_retry", "Request one redelivery of your own needs_review delivery. An earlier attempt may have effects: inspect those effects before acting. Refuses another peer's row or any lineage already explicitly retried; a repeated uncertain row needs the person. Never completes/discards a delivery or changes task state.", { delivery_id: { type: "string", minLength: 1, maxLength: 256 } }, ["delivery_id"]),
  tool("hub_backlog_list", "Read public backlog cards with planning revisions. Configured planners only; PII remains a stub.", {}),
  tool("hub_backlog_plan", "Plan an unpinned backlog item outside frozen releases with the revision you read and a bounded reason. A person's rank is retained. Actual dates cannot be set.", { id, revision: { type: "integer", minimum: 0 }, reason: { type: "string", maxLength: 1000 }, fields: { type: "object", properties: { rank: { type: ["integer", "null"], minimum: 0 }, priority: { type: ["integer", "null"], minimum: 0, maximum: 3 }, release: { type: ["integer", "null"], minimum: 1 }, plannedStart: { type: ["integer", "null"], minimum: 1 }, due: { type: ["integer", "null"], minimum: 1 }, deps: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "integer", minimum: 1 } }, reserved: { type: ["string", "null"], minLength: 1, maxLength: 32 } }, additionalProperties: false } }, ["id", "revision", "reason", "fields"]),
  tool("hub_backlog_pull", "Reserve a WIP slot and pull ready unpinned backlog work into To Do at its current revision. Preserves person order/reservations and frozen scope; pending unowned work can be undone with hub_backlog_undo.", { id, revision: { type: "integer", minimum: 0 }, reason: { type: "string", minLength: 1, maxLength: 1000 } }, ["id", "revision", "reason"]),
  tool("hub_backlog_split", "Split unstarted backlog work into two to eight staged parts. The original card retains integration/acceptance and depends on the children. Use after for existing prerequisite ids and afterParts for earlier zero-based part indexes. Latest unused unchanged children can be undone with hub_backlog_undo.", { id, revision: { type: "integer", minimum: 0 }, reason: { type: "string", minLength: 1, maxLength: 1000 }, parts: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 300 }, detail: { type: "string", maxLength: 8000 }, class: str, refs, plan, after: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "integer", minimum: 1 } }, afterParts: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "integer", minimum: 0 } } }, required: ["title"], additionalProperties: false } } }, ["id", "revision", "reason", "parts"]),
  tool("hub_backlog_undo", "Undo your latest planning change at its current revision. Refuses intervening changes and another actor's edit.", { id, revision: { type: "integer", minimum: 1 } }, ["id", "revision"]),
  tool("hub_release_new", "Create a future release planning row. Planner/person only; no activation, publish or release authorization.", { name: { type: "string", minLength: 1, maxLength: 64 }, goal: { type: "string", minLength: 1, maxLength: 1000 }, order: { type: "integer", minimum: 0 } }, ["name", "goal", "order"]),
  tool("hub_release_report", "Read a planned release's task readiness and recorded metrics. Planner/person only. A due date never waives unfinished scope.", { id }, ["id"]),
  tool("hub_release_assign", "Assign or move only a task's release, retaining its execution state and owner. Planner/person only; requires a reason and current planning revision. Frozen scope refuses.", { id, revision: { type: "integer", minimum: 0 }, release: { type: ["integer", "null"], minimum: 1 }, reason: { type: "string", minLength: 1, maxLength: 1000 } }, ["id", "revision", "release", "reason"]),
  tool("hub_release_configure", "Configure/activate a release train or record a hotfix cause. Planner/person only. At most one train is active/frozen; planning rows are future trains.", { id, revision: { type: "integer", minimum: 0 }, state: { type: "string", enum: ["active"] }, cut: { type: "integer", minimum: 1 }, hotfix: { type: "object", properties: { cause: { type: "string", enum: ["loss", "security_privacy", "upgrade_start_blocked", "core_flow_no_workaround"] }, reason: { type: "string", minLength: 1, maxLength: 1000 } }, required: ["cause", "reason"], additionalProperties: false } }, ["id", "revision"]),
  tool("hub_release_cut", "Freeze an active release's approved scope after host resource admission and fresh peer quota checks. Unknown evidence defers; no publish, tag, upgrade or authorization.", { id, revision: { type: "integer", minimum: 0 } }, ["id", "revision"]),
  tool("hub_release_list", "Read public release scope and planned/actual dates for phased planning. Configured planners only.", {}),

  tool("hub_task_propose", "Put a piece of work on the shared task board. The hub assigns an owner by class (routing.toml) unless you name one. Classes: plan, implement, bulk_edit, test, review, summarize, triage. Name the class when you know it; without one the hub tries to pick it. Name yourself as owner to claim work nobody assigned you: it starts in progress. Put the paths the work touches in refs, set refs.repo for work in another repository, and when you claim work, a plan; the hub says when they overlap another open task.", { title: str, class: { type: "string", enum: ["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"] }, detail: str, role: { type: "string", description: "catalog role id for this task class; guidance only, no routing or authority change" }, refs, plan, owner: { type: "string", description: "peer id; yours to claim the work, omit to let the hub route it. With after, the owner is reserved: offered the task first once it is ready" }, after: { type: "array", items: { type: "integer" }, description: "ids of tasks that must be approved first; until then this one waits, offered to nobody, and cannot be claimed" }, backlog: { type: "boolean", description: "stage unoffered work; owner is only a reservation, even when naming yourself" }, urgent: { type: "boolean", description: "hand it over even when its owner is paused for quota only briefly" }, goal: { type: "string", description: "id of this project's long-term task (ahub goal list) the work is part of" } }, ["title"]),
  tool("hub_task_accept", "Take a task that was assigned to you, with your plan for it. Set refs.repo for work in another repository; acceptance may correct only that repository metadata.", { id, plan: acceptPlan, refs: { ...refs, properties: { repo: refs.properties.repo } } }, ["id"]),
  tool("hub_task_cancel", "Cancel unaccepted proposed/backlog work you proposed as its configured planner; accepted work is person-only. Keeps history and does not stop a native turn or delete files.", { id, reason: str, superseded_by: str, revision: { type: "integer", minimum: 0 } }, ["id", "reason"]),
  tool("hub_task_decline", "Pass on a task assigned to you; the hub offers it to the next peer. A plain decline is a lasting refusal: you are never offered this task again. Pass capacity: true when you only have no room right now: you are skipped for this move only, and a later reroute or planner pull may offer it to you again.", { id, reason: str, capacity: { type: "boolean" } }, ["id"]),
  tool("hub_task_done", "Mark your task finished. It goes to its reviewer with your summary and refs; no duplicate hub_send chat is needed. When the project configures a check for its class, the hub runs it first and the result comes as a task message: a failed check keeps the task with you.", { id, summary: { type: "string", description: "what changed, why, and the check you ran with its result" }, refs }, ["id", "summary"]),
  tool("hub_sdlc_record", "Record artifact ids or claimed local checks on your task. This grants no authority or external-check evidence. Only its owner/reviewer or the person may record; only its reviewer/person may name a reviewed head or phase checklist. Phase evidence refs are content hashes, not external verification.", { id, receipt: { type: "object", properties: { stage: { type: "string", enum: ["spec", "plan", "implement", "review", "verify", "merge", "release"] }, repo: str, issue: id, pr: id, localHead: str, localResult: { type: "string", enum: ["passed", "failed", "unknown"] }, reviewedHead: str, phase: { type: "object", properties: { id: str, head: str, tasks: { type: "array", maxItems: 64, items: { type: "object", properties: { id, after: { type: "array", maxItems: 16, items: id } }, required: ["id", "after"], additionalProperties: false } }, criteria: { type: "array", maxItems: 32, items: { type: "object", properties: { id: str, required: { type: "boolean" }, result: { type: "string", enum: ["verified", "failed", "unverified"] }, refs: { type: "array", maxItems: 8, items: str } }, required: ["id", "required", "result", "refs"], additionalProperties: false } } }, required: ["id", "tasks", "criteria"], additionalProperties: false } }, additionalProperties: false } }, ["id", "receipt"]),
  tool("hub_task_list", "The task board. PII tasks show as [pii].", { state: { type: "string", enum: ["proposed", "in_progress", "in_review", "approved", "changes_requested", "cancelled"] }, ready: { type: "boolean", description: "only proposed tasks with nothing left to wait for" } }),
  tool("hub_review", "Give your verdict on a task you were asked to review: map the changed signatures and call sites to the task's plan or detail, read the check result (hub_task_show has it, with the done summary), and list what is unmet. The verdict notifies the task owner; no duplicate hub_send chat is needed. Consecutive changes_requested verdicts (three by default, `tasks.escalate_after`) move the task to another peer.", { id, head: { type: "string", description: "full SHA actually reviewed; enforce binds approval to the current PR head" }, findings: reviewFindings, verdict: { type: "string", enum: ["approved", "changes_requested"] }, note: str, unmet: { type: "array", items: str, description: "each requirement of the plan or detail that the change does not meet" }, coverage: { type: "object", description: "the review brief's reviewable paths you read (reviewed) and any you did not (skipped, each with a reason); in enforce an approval must account for every one", properties: { reviewed: { type: "array", items: str }, skipped: { type: "array", items: { type: "object", properties: { path: str, reason: str }, required: ["path", "reason"] } } } } }, ["id", "verdict"]),
  tool("hub_checkpoint", "Answer a checkpoint request from the hub (quota or context window pressure): what you were doing, what is half done, what whoever continues must know. Write the same to .agenthub/checkpoint.md first if you can.", { summary: str, request_id: { type: "string", description: "The request id supplied by a context checkpoint request; required for context checkpoints" } }, ["summary"]),
  tool("hub_memory_search", "Search daemon-scoped visible memory, fails first. Query <=200 UTF-8 bytes; default 8, max 20 lines; whole output <=4 KB. Incomplete excerpts are marked. No project argument.", { query: { type: "string", maxLength: 200, description: "At most 200 UTF-8 bytes, enforced by the daemon" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]),
  tool("hub_memory_show", "Read up to 8 visible memory ids or unique prefixes (6..64 UTF-8 bytes each). Original ids redirect; unavailable ids share one refusal. Whole output <=8 KB.", { ids: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 6, maxLength: 64, description: "6 to 64 UTF-8 bytes" } } }, ["ids"]),
  tool("hub_memory_graph", "Read screened memory neighbourhoods, fails first. Up to 8 starts (<=200 UTF-8 bytes each), 1 or 2 hops; default 60/max 120 nodes, max 240 edges, whole output <=6 KB. No project argument.", { starts: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 200, description: "At most 200 UTF-8 bytes" } }, hops: { type: "integer", enum: [1, 2] }, limit: { type: "integer", minimum: 1, maximum: 120 } }, ["starts"]),
  tool("hub_memory_correct", "Propose a correction to a visible memory entry. This creates a machine-local candidate only; a person accepts or rejects it with amem review. It never edits a note. id is an exact id or unique visible prefix; text and reason must each fit 4000 UTF-8 bytes.", { id: str, text: str, reason: str }, ["id", "text", "reason"]),
  tool("hub_remember", "Save a decision, finding, contract or fail to the memory all agents share (the hub's memory and claude-mem); the other agents also get it with their next message. A fail is an approach you tried that does not work, and why: the most useful note, it stops the others spending their quota on it. Do not retry what a fail note rules out without new evidence. Conclusions worth recalling, not chatter. For kind fail, optional approach, symptom, cause, evidence and retry_when strings compose fixed labeled text; text may be omitted when structured fields are supplied. The complete text must fit 4000 UTF-8 bytes and is refused, never truncated, when oversized. A note on an open task is short-term until the task is approved, when its decisions, contracts and fails become long-term; horizon long keeps it now, scope shared lets the person's other projects find it.", { text: str, approach: str, symptom: str, cause: str, evidence: str, retry_when: str, title: str, kind: { type: "string", enum: [...NOTE_KINDS] }, task: id, horizon: { type: "string", enum: ["short", "long"] }, scope: { type: "string", enum: ["project", "shared"] } }),
];

export const PLANNER_REVIEW_TOOLS: HubTool[] = [
  tool("hub_planner_groom", "Read a bounded planner grooming digest of dependencies, repository-scoped overlaps, WIP and blockers. No board change; unavailable evidence stays unknown.", {}),
  tool("hub_plan_review", "Record a planner review against the task planning revision and host-read issue edit time. Configured planner or person only; never accepts caller issue timestamps.", { id, revision: { type: "integer", minimum: 0 }, reason: { ...str, maxLength: 1000 }, ...costPlanProperties }, ["id", "revision", "reason"]),
  tool("hub_sdlc_costs", "Read bounded review and CI cost metrics for linked merged PRs. Planner/person only; metadata only, no board writes. S7 owns automatic band proposals.", { repo: str }),
  tool("hub_backlog_return_untouched", "Return accepted but untouched work to the backlog with its history and planning retained. Refuses execution/branch/commit evidence; planner or person only.", { id, revision: { type: "integer", minimum: 0 }, reason: { ...str, maxLength: 1000 } }, ["id", "revision", "reason"]),
];
TASK_TOOLS.push(...PLANNER_REVIEW_TOOLS);
export const TASK_TOOL_NAMES = new Set(TASK_TOOLS.map((t) => t.name));

/** Separately published: serving a schema grants no authority, only the daemon's explicit role does. */
export const CONDUCTOR_TOOLS: HubTool[] = [
  tool("hub_status", "Inspect public team state, holds, quota windows, task counts and pending approval peer/tool/age. Only the configured conductor may use this tool.", {}),
  tool("hub_task_show", "Read a task's public view and history, its done summary and check result included. PII tasks remain stubs. Only the conductor and the task's current owner and reviewer may use this tool.", { id }, ["id"]),
  tool("hub_task_assign", "Name an owner (default role) or reviewer. Only the conductor may name a reviewer through this tool. A proposer may redirect an unaccepted proposed task's owner; a task that still waits reserves that owner. Pull-only peers receive work when named while attached or when they claim it; a peer that cannot take the task is refused with the reason, and the task is unchanged. With an explicit capabilities list, the conductor needs assign capability for either role, the proposer only to give ownership to another peer.", { id, peer: str, role: { type: "string", enum: ["owner", "reviewer"] } }, ["id", "peer"]),
  tool("hub_task_escalate", "Escalate a task through the normal task flow, as the conductor. Requires assign capability when explicitly listed.", { id }, ["id"]),
  tool("hub_peer_start", "Start local, kimi, qwen, jcode, pi, claude or codex in the start mode a person set for it; you cannot choose the mode. A headless peer starts at once. A TUI peer (claude, and pi and codex by default) opens in a terminal with a fixed command; when the hub cannot open a terminal the call fails with the command for the person to run.", { peer: { type: "string", enum: CONDUCTOR_START_PEERS } }, ["peer"]),
  tool("hub_peer_hold", "Hold a peer's deliveries as the conductor. This hold is separate from the person's hold and budget pauses.", { peer: str }, ["peer"]),
  tool("hub_peer_release", "Release only the conductor hold you placed. Never lifts a person's hold or a budget pause.", { peer: str }, ["peer"]),
];
export const CONDUCTOR_TOOL_NAMES = new Set(CONDUCTOR_TOOLS.map((t) => t.name));

/** Authenticated status metadata only; malformed values never add a tool target. */
function projectPeerIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 256 || value.some(id => typeof id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(id) || ["user", "hub", "digest"].includes(id)) || new Set(value).size !== value.length) return undefined;
  return [...value] as string[];
}

/** A project-local schema projection; released builtin arrays and all other tools keep their identity. */
export function projectConductorTools(startPeers?: unknown): HubTool[] {
  const peers = startPeers === undefined ? undefined : projectPeerIds(startPeers);
  if (peers === undefined) return CONDUCTOR_TOOLS;
  return CONDUCTOR_TOOLS.map(tool => tool.name !== "hub_peer_start" ? tool : {
    ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
      peer: { ...(tool.inputSchema.properties.peer as Record<string, unknown>), enum: [...new Set([...CONDUCTOR_START_PEERS, ...peers])] },
    } },
  });
}

export interface ProjectToolContext { startPeers?: string[]; readOnly?: boolean }
/** Ordinary projects retain their exact prior publication context; configured metadata is body-free and bounded. */
export function configuredToolContext(status: unknown, peer: string): ProjectToolContext {
  if (!status || typeof status !== "object" || Array.isArray(status)) return {};
  const raw = status as Record<string, unknown>, configured = projectPeerIds(raw.configuredAdapters);
  if (!configured?.length) return {};
  const startPeers = projectPeerIds(raw.startablePeers), readOnlyPeers = projectPeerIds(raw.readOnlyPeers);
  // With an incomplete configured-project reading, publish only R2 reads until authenticated status is complete.
  if (!startPeers || !readOnlyPeers) return { readOnly: true };
  return { startPeers, readOnly: readOnlyPeers.includes(peer) };
}

const READ_ONLY_PROJECT_TOOLS = Object.freeze(["hub_send", "hub_inbox", "hub_delivery_done", "hub_review", "hub_task_show", "hub_task_list", "hub_memory_search", "hub_memory_show", "hub_memory_graph", "hub_status"]);
/** Publication restricts exposure only; server-side authority remains mandatory for every call. */
export function projectToolList<T extends { name: string }>(tools: T[], readOnly = false): T[] {
  return readOnly ? tools.filter(tool => READ_ONLY_PROJECT_TOOLS.includes(tool.name)) : tools;
}


/** Role contracts, by role name. Shown to each peer for the roles `.agenthub/config.json` gives it. */
export const ROLE_TEXT: Record<string, string> = {
  conductor: "conductor: plan and split work into tasks with owners, watch the team with hub_status, move stalled work, and ensure every task is reviewed (review it yourself only if you also hold reviewer). Report results and open decisions to the person. Do not implement tasks you handed out. Never ask a peer to answer an approval; ask the person for human-only actions. You may release only holds you placed, never human holds or budget pauses.",
  planner: "planner: break work into tasks with hub_task_propose (one outcome each, the right class, paths in refs, and after: [ids] for work that must wait for other tasks) instead of doing everything yourself.",
  implementer: "implementer: accept tasks assigned to you, do them, and finish with hub_task_done (summary: what changed, why, and the check you ran with its result; refs). Decline what you cannot do. Before starting work nobody assigned you, claim it with hub_task_propose naming yourself as owner, with the paths in refs. With a claim or an accept, give a plan: the files, symbols and signatures you will change and where new code goes.",
  verifier: "verifier: run the checks a task names and report what passed and what did not in hub_task_done.",
  reviewer: "reviewer: when asked to review, read the change itself, then hub_review with approved or changes_requested and a note that says what to fix.",
};

export const DEFAULT_ROLES: Record<string, string[]> = defaultPeerRoles(true);

export function roleContract(peer: string, roles: Record<string, string[]> = DEFAULT_ROLES, catalog: CatalogRole[] = [], profile: ProfileSelection = "dev"): string {
  const data = profileData(profile);
  const mine = (roles[peer] ?? []).map((r) => data.role_text[r] ?? ROLE_TEXT[r]).filter(Boolean);
  if (!mine.length) return "";
  return [`Your roles in this project ("${peer}"):`, ...mine.map((t) => `- ${t}`), ...(data !== projectProfile("dev") ? [`Project profile ${data.name}: classes ${Object.entries(data.classes).map(([name, base]) => `${name}=${base}`).join(", ")}. Profile guidance grants no authority.`] : []), ...(catalog.length ? [catalogSection(catalog)] : []), "The task board (hub_task_list) is the shared record of who does what."].join("\n");
}

/** Profile schemas are data over the existing tools; dev retains the exact existing definitions. */
/** `criteria`: an enabled lifecycle, whose receipts take the #481 S8 checklist whatever its stage list. */
export function profileTaskTools(profile: ProfileSelection = "dev", stages?: readonly string[], criteria = false): HubTool[] {
  const customStages = stages && (stages.length !== SDLC_STAGES.length || stages.some((s, i) => s !== SDLC_STAGES[i]));
  const customProfile = !(profile === "dev" || profileData(profile) === projectProfile("dev"));
  if (!customStages && !customProfile && !criteria) return TASK_TOOLS;
  const data = profileData(profile);
  return TASK_TOOLS.map(tool => {
    const properties = { ...tool.inputSchema.properties };
    if ((customStages || criteria) && tool.name === "hub_sdlc_record") {
      const receipt = properties.receipt as { type: string; properties: Record<string, unknown>; additionalProperties: boolean };
      let fields: Record<string, unknown> = { ...receipt.properties, ...(customStages ? { stage: { type: "string", enum: [...(stages ?? SDLC_STAGES)] } } : {}) };
      // #481 S8: only an enabled lifecycle (whose daemon accepts it) advertises the criteria checklist; off and older daemons keep phase.
      if (criteria) {
        const { phase, ...current } = fields as { phase: { properties: Record<string, unknown> } } & Record<string, unknown>;
        const { tasks: _retiredImport, ...checklist } = phase.properties;
        fields = { ...current, criteria: { ...phase, properties: checklist, required: ["id", "criteria"] } };
      }
      properties.receipt = { ...receipt, properties: fields };
    }
    if (customProfile && tool.name === "hub_task_propose") properties.class = { type: "string", enum: [...new Set([...Object.keys(data.classes), ...PROFILE_CLASS_NAMES.filter(v => projectProfile("dev").classes[v])])] };
    if (customProfile && properties.plan && tool.name !== "hub_task_accept") properties.plan = { ...plan, properties: Object.fromEntries(data.plan_keys.map(key => [key, plan.properties[key as keyof typeof plan.properties] ?? list(key === "sections" ? "document heading anchors, such as report.md#methods" : key === "sources" ? "citation ids, DOI or source URL ids" : "short claim ids to verify")])) };
    if (customProfile && tool.name === "hub_backlog_split") {
      const parts = properties.parts as { items: { properties: Record<string, unknown> } };
      const selectedPlan = { ...plan, properties: Object.fromEntries(data.plan_keys.map(key => [key, plan.properties[key as keyof typeof plan.properties] ?? list(key === "sections" ? "document heading anchors, such as report.md#methods" : key === "sources" ? "citation ids, DOI or source URL ids" : "short claim ids to verify")])) };
      properties.parts = { ...parts, items: { ...parts.items, properties: { ...parts.items.properties, plan: selectedPlan } } };
    }
    if (criteria && properties.plan) {
      const current = properties.plan as { properties: Record<string, unknown> };
      properties.plan = { ...current, properties: { ...current.properties, ...costPlanProperties } };
    }
    if (criteria && tool.name === "hub_backlog_split") {
      const parts = properties.parts as { items: { properties: { plan: { properties: Record<string, unknown> } } } };
      properties.parts = { ...parts, items: { ...parts.items, properties: { ...parts.items.properties, plan: { ...parts.items.properties.plan, properties: { ...parts.items.properties.plan.properties, ...costPlanProperties } } } } };
    }
    return { ...tool, ...(customProfile && tool.name === "hub_task_propose" ? { description: tool.description + ` Selected profile ${data.name}: ${Object.keys(data.classes).join(", ")}. Routing uses their existing base classes.` } : {}), inputSchema: { ...tool.inputSchema, properties } };
  });
}
