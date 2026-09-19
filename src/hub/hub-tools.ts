// The hub's task tools, defined once: the MCP server (Claude plugin, Kimi, Codex) and the local worker both read this.
const str = { type: "string" } as const;
const id = { type: "integer", description: "task id" } as const;
const refs = {
  type: "object",
  description: "where the work lives",
  properties: { branch: str, commit: str, paths: { type: "array", items: str } },
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
  tool("hub_task_propose", "Put a piece of work on the shared task board. The hub assigns an owner by class (routing.toml) unless you name one. Classes: plan, implement, bulk_edit, test, review, summarize, triage. Name the class when you know it; without one the hub tries to pick it.", { title: str, class: { type: "string", enum: ["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"] }, detail: str, refs, owner: { type: "string", description: "peer id; omit to let the hub route it" } }, ["title"]),
  tool("hub_task_accept", "Take a task that was assigned to you.", { id }, ["id"]),
  tool("hub_task_decline", "Pass on a task assigned to you; the hub offers it to the next peer.", { id, reason: str }, ["id"]),
  tool("hub_task_done", "Mark your task finished. It goes to its reviewer with your summary and refs.", { id, summary: str, refs }, ["id", "summary"]),
  tool("hub_task_list", "The task board. PII tasks show as [pii].", { state: { type: "string", enum: ["proposed", "in_progress", "in_review", "approved", "changes_requested"] } }),
  tool("hub_review", "Give your verdict on a task you were asked to review. Two changes_requested in a row move the task to another peer.", { id, verdict: { type: "string", enum: ["approved", "changes_requested"] }, note: str }, ["id", "verdict"]),
  tool("hub_checkpoint", "Answer a checkpoint request from the hub (your quota window is nearly used up): what you were doing, what is half done, what whoever continues must know. Write the same to .agenthub/checkpoint.md first if you can.", { summary: str }, ["summary"]),
  tool("hub_remember", "Save a decision, finding or contract to the memory all agents share (claude-mem). Conclusions worth recalling next session, not chatter.", { text: str, title: str, kind: { type: "string", enum: ["decision", "finding", "contract"] }, task: id }, ["text"]),
];

export const TASK_TOOL_NAMES = new Set(TASK_TOOLS.map((t) => t.name));

/** Role contracts, by role name. Shown to each peer for the roles `.agenthub/config.json` gives it. */
export const ROLE_TEXT: Record<string, string> = {
  planner: "planner: break work into tasks with hub_task_propose (one outcome each, the right class, paths in refs) instead of doing everything yourself.",
  implementer: "implementer: accept tasks assigned to you, do them, and finish with hub_task_done (summary + refs). Decline what you cannot do.",
  verifier: "verifier: run the checks a task names and report what passed and what did not in hub_task_done.",
  reviewer: "reviewer: when asked to review, read the change itself, then hub_review with approved or changes_requested and a note that says what to fix.",
};

export const DEFAULT_ROLES: Record<string, string[]> = { claude: ["planner", "reviewer"], codex: ["implementer"], kimi: ["implementer", "verifier"], local: ["implementer", "verifier"], pi: ["implementer", "verifier"] };

export function roleContract(peer: string, roles: Record<string, string[]> = DEFAULT_ROLES): string {
  const mine = (roles[peer] ?? []).map((r) => ROLE_TEXT[r]).filter(Boolean);
  if (!mine.length) return "";
  return [`Your roles in this project ("${peer}"):`, ...mine.map((t) => `- ${t}`), "The task board (hub_task_list) is the shared record of who does what."].join("\n");
}
