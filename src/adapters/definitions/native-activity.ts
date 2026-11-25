import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ActivityKind } from "../../hub/peer-activity.ts";

export type ActivityTable = Readonly<Record<string, ActivityKind>>;
const CODEX_ACTIVITY: ActivityTable = Object.freeze({
  commandExecution: "shell", fileChange: "files", mcpToolCall: "network", dynamicToolCall: "unknown",
  collabAgentToolCall: "agents", webSearch: "network", imageView: "files", imageGeneration: "model",
});
const CODEX_NON_TOOLS = new Set(["userMessage", "agentMessage", "plan", "reasoning", "contextCompaction",
  "enteredReviewMode", "exitedReviewMode"]);
export const ACP_ACTIVITY: ActivityTable = Object.freeze({
  read: "files", edit: "files", delete: "files", move: "files", search: "files",
  execute: "shell", think: "model", fetch: "network", switch_mode: "agents", other: "unknown",
});
export const LOCAL_ACTIVITY: ActivityTable = Object.freeze({
  read: "files", write: "files", edit: "files", doc_read: "files", bash: "shell", git: "shell",
  web_fetch: "network", hub_send: "hub", hub_invoke: "agents", hub_remember: "memory",
  hub_memory_search: "memory", hub_memory_show: "memory", hub_memory_graph: "memory",
});

export function nativeActivity(table: ActivityTable, kind: unknown, fallback: ActivityKind = "unknown"): ActivityKind {
  return typeof kind === "string" && Object.hasOwn(table, kind) ? table[kind]! : fallback;
}

export function codexItemActivity(kind: unknown, server: unknown, servers: ReadonlyMap<string, ActivityKind>): ActivityKind | undefined {
  if (typeof kind !== "string" || CODEX_NON_TOOLS.has(kind)) return undefined;
  if (kind === "mcpToolCall" && typeof server === "string") return servers.get(server) ?? "network";
  return nativeActivity(CODEX_ACTIVITY, kind);
}

const MEMORY_SERVER_NAMES = ["agent-mem", "amem", "claude-mem", "cmem", "vmem"] as const;
const CONFIG_BYTES = 64 * 1024;

/** Only allowlisted names from bounded home and project MCP declarations leave this function. */
export function codexActivityServers(home: string, cwd: string): ReadonlyMap<string, ActivityKind> {
  const servers = new Map<string, ActivityKind>([["agent-hub", "hub"]]);
  for (const file of [join(home, "config.toml"), join(cwd, ".codex/config.toml")]) {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile()) continue;
      const bytes = Buffer.alloc(CONFIG_BYTES + 1);
      const n = readSync(fd, bytes);
      if (n > CONFIG_BYTES) continue;
      const config = Bun.TOML.parse(bytes.subarray(0, n).toString("utf8")) as { mcp_servers?: Record<string, { enabled?: boolean }> };
      for (const name of MEMORY_SERVER_NAMES) {
        const entry = config.mcp_servers?.[name];
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          if (entry.enabled === false) servers.delete(name); else servers.set(name, "memory");
        }
      }
    } catch { /* Unavailable configuration simply provides no memory label. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return servers;
}
