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

export const TASK_TOOLS: HubTool[] = [
  tool("hub_task_propose", "Put a piece of work on the shared task board. The hub assigns an owner by class (routing.toml) unless you name one. Classes: plan, implement, bulk_edit, test, review, summarize, triage. Name the class when you know it; without one the hub tries to pick it. Name yourself as owner to claim work nobody assigned you: it starts in progress. Put the paths the work touches in refs, and when you claim work, a plan; the hub says when they overlap another open task.", { title: str, class: { type: "string", enum: ["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"] }, detail: str, refs, plan, owner: { type: "string", description: "peer id; yours to claim the work, omit to let the hub route it. With after, the owner is reserved: offered the task first once it is ready" }, after: { type: "array", items: { type: "integer" }, description: "ids of tasks that must be approved first; until then this one waits, offered to nobody, and cannot be claimed" }, urgent: { type: "boolean", description: "hand it over even when its owner is paused for quota only briefly" } }, ["title"]),
  tool("hub_task_accept", "Take a task that was assigned to you, with your plan for it.", { id, plan }, ["id"]),
  tool("hub_task_decline", "Pass on a task assigned to you; the hub offers it to the next peer.", { id, reason: str }, ["id"]),
  tool("hub_task_done", "Mark your task finished. It goes to its reviewer with your summary and refs. When the project configures a check for its class, the hub runs it first and the result comes as a task message: a failed check keeps the task with you.", { id, summary: { type: "string", description: "what changed, why, and the check you ran with its result" }, refs }, ["id", "summary"]),
  tool("hub_task_list", "The task board. PII tasks show as [pii].", { state: { type: "string", enum: ["proposed", "in_progress", "in_review", "approved", "changes_requested"] }, ready: { type: "boolean", description: "only proposed tasks with nothing left to wait for" } }),
  tool("hub_review", "Give your verdict on a task you were asked to review: map the changed signatures and call sites to the task's plan or detail, read the check result (hub_task_show has it, with the done summary), and list what is unmet. Two changes_requested in a row move the task to another peer.", { id, verdict: { type: "string", enum: ["approved", "changes_requested"] }, note: str, unmet: { type: "array", items: str, description: "each requirement of the plan or detail that the change does not meet" } }, ["id", "verdict"]),
  tool("hub_checkpoint", "Answer a checkpoint request from the hub (quota or context window pressure): what you were doing, what is half done, what whoever continues must know. Write the same to .agenthub/checkpoint.md first if you can.", { summary: str, request_id: { type: "string", description: "The request id supplied by a context checkpoint request; required for context checkpoints" } }, ["summary"]),
  tool("hub_remember", "Save a decision, finding, contract or fail to the memory all agents share (claude-mem); the other agents also get it with their next message. A fail is an approach you tried that does not work, and why: the most useful note, it stops the others spending their quota on it. Do not retry what a fail note rules out without new evidence. Conclusions worth recalling, not chatter.", { text: str, title: str, kind: { type: "string", enum: [...NOTE_KINDS] }, task: id }, ["text"]),
];

export const TASK_TOOL_NAMES = new Set(TASK_TOOLS.map((t) => t.name));

/** Separately published: serving a schema grants no authority, only the daemon's explicit role does. */
export const CONDUCTOR_TOOLS: HubTool[] = [
  tool("hub_status", "Inspect public team state, holds, quota windows, task counts and pending approval peer/tool/age. Only the configured conductor may use this tool.", {}),
  tool("hub_task_show", "Read a task's public view and history, its done summary and check result included. PII tasks remain stubs. Only the conductor and the task's current owner and reviewer may use this tool.", { id }, ["id"]),
  tool("hub_task_assign", "Move a task to another peer, as the conductor, or redirect a task you proposed while it is proposed and nobody accepted it. A task that still waits gets the peer as its reserved owner. Handing it to another peer requires assign capability when you have an explicit capabilities list.", { id, peer: str }, ["id", "peer"]),
  tool("hub_task_escalate", "Escalate a task through the normal task flow, as the conductor. Requires assign capability when explicitly listed.", { id }, ["id"]),
  tool("hub_peer_start", "Start local, kimi or headless pi. Claude, Codex and Pi TUI requests return a command for the person to run, without launching a terminal.", { peer: { type: "string", enum: ["local", "kimi", "pi", "claude", "codex"] }, mode: { type: "string", enum: ["headless", "tui"] } }, ["peer"]),
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

export const DEFAULT_ROLES: Record<string, string[]> = { claude: ["planner", "reviewer"], codex: ["implementer"], kimi: ["implementer", "verifier"], local: ["implementer", "verifier"], pi: ["implementer", "verifier"] };

export function roleContract(peer: string, roles: Record<string, string[]> = DEFAULT_ROLES): string {
  const mine = (roles[peer] ?? []).map((r) => ROLE_TEXT[r]).filter(Boolean);
  if (!mine.length) return "";
  return [`Your roles in this project ("${peer}"):`, ...mine.map((t) => `- ${t}`), "The task board (hub_task_list) is the shared record of who does what."].join("\n");
}
