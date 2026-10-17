import { SDLC_STAGES } from "./sdlc.ts";
import { projectProfile, profileData, PROFILE_CLASS_NAMES, type ProfileName, type ProfileSelection } from "./profiles.ts";
import { catalogSection, type CatalogRole } from "./roles.ts";
import { SUPPORTED_PEERS, defaultPeerRoles } from "./peer-catalog.ts";
// The hub's task tools, defined once: the MCP server (Claude plugin, Kimi, Codex) and the local worker both read this.
import { NOTE_KINDS } from "./envelope.ts";

const str = { type: "string" } as const;
const id = { type: "integer", description: "task id" } as const;
const refs = {
  type: "object",
  description: "where the work lives",
  properties: { branch: str, commit: str, paths: { type: "array", items: str } },
  additionalProperties: false,
} as const;
const list = (description: string) => ({ type: "array", items: str, description }) as const;
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
  tool("hub_backlog_list", "Read public backlog cards with planning revisions. Configured planners only; PII remains a stub.", {}),
  tool("hub_backlog_plan", "Plan an unpinned backlog item outside frozen releases with the revision you read and a bounded reason. A person's rank is retained. Actual dates cannot be set.", { id, revision: { type: "integer", minimum: 0 }, reason: { type: "string", maxLength: 1000 }, fields: { type: "object", properties: { rank: { type: ["integer", "null"], minimum: 0 }, priority: { type: ["integer", "null"], minimum: 0, maximum: 3 }, release: { type: ["integer", "null"], minimum: 1 }, plannedStart: { type: ["integer", "null"], minimum: 1 }, due: { type: ["integer", "null"], minimum: 1 }, deps: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "integer", minimum: 1 } }, reserved: { type: ["string", "null"], minLength: 1, maxLength: 32 } }, additionalProperties: false } }, ["id", "revision", "reason", "fields"]),
  tool("hub_backlog_pull", "Reserve a WIP slot and pull ready unpinned backlog work into To Do at its current revision. Preserves person order/reservations and frozen scope; pending unowned work can be undone with hub_backlog_undo.", { id, revision: { type: "integer", minimum: 0 }, reason: { type: "string", minLength: 1, maxLength: 1000 } }, ["id", "revision", "reason"]),
  tool("hub_backlog_split", "Split unstarted backlog work into two to eight staged parts. The original card retains integration/acceptance and depends on the children. Use after for existing prerequisite ids and afterParts for earlier zero-based part indexes. Latest unused unchanged children can be undone with hub_backlog_undo.", { id, revision: { type: "integer", minimum: 0 }, reason: { type: "string", minLength: 1, maxLength: 1000 }, parts: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 300 }, detail: { type: "string", maxLength: 8000 }, class: str, refs, plan, after: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "integer", minimum: 1 } }, afterParts: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "integer", minimum: 0 } } }, required: ["title"], additionalProperties: false } } }, ["id", "revision", "reason", "parts"]),
  tool("hub_backlog_undo", "Undo your latest planning change at its current revision. Refuses intervening changes and another actor's edit.", { id, revision: { type: "integer", minimum: 1 } }, ["id", "revision"]),
  tool("hub_release_list", "Read public release scope and planned/actual dates for phased planning. Configured planners only.", {}),

  tool("hub_task_propose", "Put a piece of work on the shared task board. The hub assigns an owner by class (routing.toml) unless you name one. Classes: plan, implement, bulk_edit, test, review, summarize, triage. Name the class when you know it; without one the hub tries to pick it. Name yourself as owner to claim work nobody assigned you: it starts in progress. Put the paths the work touches in refs, and when you claim work, a plan; the hub says when they overlap another open task.", { title: str, class: { type: "string", enum: ["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"] }, detail: str, role: { type: "string", description: "catalog role id for this task class; guidance only, no routing or authority change" }, refs, plan, owner: { type: "string", description: "peer id; yours to claim the work, omit to let the hub route it. With after, the owner is reserved: offered the task first once it is ready" }, after: { type: "array", items: { type: "integer" }, description: "ids of tasks that must be approved first; until then this one waits, offered to nobody, and cannot be claimed" }, backlog: { type: "boolean", description: "stage unoffered work; owner is only a reservation, even when naming yourself" }, urgent: { type: "boolean", description: "hand it over even when its owner is paused for quota only briefly" }, goal: { type: "string", description: "id of this project's long-term task (ahub goal list) the work is part of" } }, ["title"]),
  tool("hub_task_accept", "Take a task that was assigned to you, with your plan for it.", { id, plan: acceptPlan }, ["id"]),
  tool("hub_task_decline", "Pass on a task assigned to you; the hub offers it to the next peer.", { id, reason: str }, ["id"]),
  tool("hub_task_done", "Mark your task finished. It goes to its reviewer with your summary and refs. When the project configures a check for its class, the hub runs it first and the result comes as a task message: a failed check keeps the task with you.", { id, summary: { type: "string", description: "what changed, why, and the check you ran with its result" }, refs }, ["id", "summary"]),
  tool("hub_sdlc_record", "Record artifact ids or claimed local checks on your task. This grants no authority or external-check evidence. Only its owner/reviewer or the person may record; only its reviewer/person may name a reviewed head or phase checklist. Phase evidence refs are content hashes, not external verification.", { id, receipt: { type: "object", properties: { stage: { type: "string", enum: ["spec", "plan", "implement", "review", "verify", "merge", "release"] }, repo: str, issue: id, pr: id, localHead: str, localResult: { type: "string", enum: ["passed", "failed", "unknown"] }, reviewedHead: str, phase: { type: "object", properties: { id: str, head: str, tasks: { type: "array", maxItems: 64, items: { type: "object", properties: { id, after: { type: "array", maxItems: 16, items: id } }, required: ["id", "after"], additionalProperties: false } }, criteria: { type: "array", maxItems: 32, items: { type: "object", properties: { id: str, required: { type: "boolean" }, result: { type: "string", enum: ["verified", "failed", "unverified"] }, refs: { type: "array", maxItems: 8, items: str } }, required: ["id", "required", "result", "refs"], additionalProperties: false } } }, required: ["id", "tasks", "criteria"], additionalProperties: false } }, additionalProperties: false } }, ["id", "receipt"]),
  tool("hub_task_list", "The task board. PII tasks show as [pii].", { state: { type: "string", enum: ["proposed", "in_progress", "in_review", "approved", "changes_requested"] }, ready: { type: "boolean", description: "only proposed tasks with nothing left to wait for" } }),
  tool("hub_review", "Give your verdict on a task you were asked to review: map the changed signatures and call sites to the task's plan or detail, read the check result (hub_task_show has it, with the done summary), and list what is unmet. Two changes_requested in a row move the task to another peer.", { id, head: { type: "string", description: "full SHA actually reviewed; enforce binds approval to the current PR head" }, verdict: { type: "string", enum: ["approved", "changes_requested"] }, note: str, unmet: { type: "array", items: str, description: "each requirement of the plan or detail that the change does not meet" } }, ["id", "verdict"]),
  tool("hub_checkpoint", "Answer a checkpoint request from the hub (quota or context window pressure): what you were doing, what is half done, what whoever continues must know. Write the same to .agenthub/checkpoint.md first if you can.", { summary: str, request_id: { type: "string", description: "The request id supplied by a context checkpoint request; required for context checkpoints" } }, ["summary"]),
  tool("hub_memory_search", "Search daemon-scoped visible memory, fails first. Query <=200 UTF-8 bytes; default 8, max 20 lines; whole output <=4 KB. Incomplete excerpts are marked. No project argument.", { query: { type: "string", maxLength: 200, description: "At most 200 UTF-8 bytes, enforced by the daemon" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]),
  tool("hub_memory_show", "Read up to 8 visible memory ids or unique prefixes (6..64 UTF-8 bytes each). Original ids redirect; unavailable ids share one refusal. Whole output <=8 KB.", { ids: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 6, maxLength: 64, description: "6 to 64 UTF-8 bytes" } } }, ["ids"]),
  tool("hub_memory_graph", "Read screened memory neighbourhoods, fails first. Up to 8 starts (<=200 UTF-8 bytes each), 1 or 2 hops; default 60/max 120 nodes, max 240 edges, whole output <=6 KB. No project argument.", { starts: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 200, description: "At most 200 UTF-8 bytes" } }, hops: { type: "integer", enum: [1, 2] }, limit: { type: "integer", minimum: 1, maximum: 120 } }, ["starts"]),
  tool("hub_memory_correct", "Propose a correction to a visible memory entry. This creates a machine-local candidate only; a person accepts or rejects it with amem review. It never edits a note. id is an exact id or unique visible prefix; text and reason must each fit 4000 UTF-8 bytes.", { id: str, text: str, reason: str }, ["id", "text", "reason"]),
  tool("hub_remember", "Save a decision, finding, contract or fail to the memory all agents share (the hub's memory and claude-mem); the other agents also get it with their next message. A fail is an approach you tried that does not work, and why: the most useful note, it stops the others spending their quota on it. Do not retry what a fail note rules out without new evidence. Conclusions worth recalling, not chatter. For kind fail, optional approach, symptom, cause, evidence and retry_when strings compose fixed labeled text; text may be omitted when structured fields are supplied. The complete text must fit 4000 UTF-8 bytes and is refused, never truncated, when oversized. A note on an open task is short-term until the task is approved, when its decisions, contracts and fails become long-term; horizon long keeps it now, scope shared lets the person's other projects find it.", { text: str, approach: str, symptom: str, cause: str, evidence: str, retry_when: str, title: str, kind: { type: "string", enum: [...NOTE_KINDS] }, task: id, horizon: { type: "string", enum: ["short", "long"] }, scope: { type: "string", enum: ["project", "shared"] } }),
];

export const TASK_TOOL_NAMES = new Set(TASK_TOOLS.map((t) => t.name));

/** Separately published: serving a schema grants no authority, only the daemon's explicit role does. */
export const CONDUCTOR_TOOLS: HubTool[] = [
  tool("hub_status", "Inspect public team state, holds, quota windows, task counts and pending approval peer/tool/age. Only the configured conductor may use this tool.", {}),
  tool("hub_task_show", "Read a task's public view and history, its done summary and check result included. PII tasks remain stubs. Only the conductor and the task's current owner and reviewer may use this tool.", { id }, ["id"]),
  tool("hub_task_assign", "Name an owner (default role) or reviewer. Only the conductor may name a reviewer through this tool. A proposer may redirect an unaccepted proposed task's owner; a task that still waits reserves that owner. Pull-only peers receive work when named or when they claim it. With an explicit capabilities list, the conductor needs assign capability for either role, the proposer only to give ownership to another peer.", { id, peer: str, role: { type: "string", enum: ["owner", "reviewer"] } }, ["id", "peer"]),
  tool("hub_task_escalate", "Escalate a task through the normal task flow, as the conductor. Requires assign capability when explicitly listed.", { id }, ["id"]),
  tool("hub_peer_start", "Start local, kimi, qwen, jcode, pi, claude or codex in the start mode a person set for it; you cannot choose the mode. A headless peer starts at once. A TUI peer (claude, and pi and codex by default) opens in a terminal with a fixed command; when the hub cannot open a terminal the call fails with the command for the person to run.", { peer: { type: "string", enum: ["local", "kimi", "pi", ...SUPPORTED_PEERS.filter(peer => !["local", "kimi", "pi"].includes(peer))] } }, ["peer"]),
  tool("hub_peer_hold", "Hold a peer's deliveries as the conductor. This hold is separate from the person's hold and budget pauses.", { peer: str }, ["peer"]),
  tool("hub_peer_release", "Release only the conductor hold you placed. Never lifts a person's hold or a budget pause.", { peer: str }, ["peer"]),
];
export const CONDUCTOR_TOOL_NAMES = new Set(CONDUCTOR_TOOLS.map((t) => t.name));

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
export function profileTaskTools(profile: ProfileSelection = "dev", stages?: readonly string[]): HubTool[] {
  const customStages = stages && (stages.length !== SDLC_STAGES.length || stages.some((s, i) => s !== SDLC_STAGES[i]));
  const customProfile = !(profile === "dev" || profileData(profile) === projectProfile("dev"));
  if (!customStages && !customProfile) return TASK_TOOLS;
  const data = profileData(profile);
  return TASK_TOOLS.map(tool => {
    const properties = { ...tool.inputSchema.properties };
    if (customStages && tool.name === "hub_sdlc_record") {
      const receipt = properties.receipt as { type: string; properties: Record<string, unknown>; additionalProperties: boolean };
      properties.receipt = { ...receipt, properties: { ...receipt.properties, stage: { type: "string", enum: [...(stages ?? SDLC_STAGES)] } } };
    }
    if (customProfile && tool.name === "hub_task_propose") properties.class = { type: "string", enum: [...new Set([...Object.keys(data.classes), ...PROFILE_CLASS_NAMES.filter(v => projectProfile("dev").classes[v])])] };
    if (customProfile && properties.plan && tool.name !== "hub_task_accept") properties.plan = { ...plan, properties: Object.fromEntries(data.plan_keys.map(key => [key, plan.properties[key as keyof typeof plan.properties] ?? list(key === "sections" ? "document heading anchors, such as report.md#methods" : key === "sources" ? "citation ids, DOI or source URL ids" : "short claim ids to verify")])) };
    if (customProfile && tool.name === "hub_backlog_split") {
      const parts = properties.parts as { items: { properties: Record<string, unknown> } };
      const selectedPlan = { ...plan, properties: Object.fromEntries(data.plan_keys.map(key => [key, plan.properties[key as keyof typeof plan.properties] ?? list(key === "sections" ? "document heading anchors, such as report.md#methods" : key === "sources" ? "citation ids, DOI or source URL ids" : "short claim ids to verify")])) };
      properties.parts = { ...parts, items: { ...parts.items, properties: { ...parts.items.properties, plan: selectedPlan } } };
    }
    return { ...tool, ...(customProfile && tool.name === "hub_task_propose" ? { description: tool.description + ` Selected profile ${data.name}: ${Object.keys(data.classes).join(", ")}. Routing uses their existing base classes.` } : {}), inputSchema: { ...tool.inputSchema, properties } };
  });
}
