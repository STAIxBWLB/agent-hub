import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hubGitSync } from "../hub/git.ts";

export const KIMI_MCP_FILE = ".kimi-code/mcp.json";
type Document = Record<string, unknown> & { mcpServers?: Record<string, unknown> };

/** No writes: the daemon uses this check before an ACP launch to avoid a second hub connection. */
export function kimiMcpDocument(cwd: string): Document {
  const directory = join(cwd, ".kimi-code"), file = join(cwd, KIMI_MCP_FILE);
  const dir = lstatSync(directory, { throwIfNoEntry: false });
  if (dir && (!dir.isDirectory() || dir.isSymbolicLink())) throw new Error(".kimi-code must be a project directory, not a link");
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return {};
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(".kimi-code/mcp.json must be a regular file, not a link");
  let document: unknown;
  try { document = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error(".kimi-code/mcp.json is not valid JSON; correct it before launching Kimi"); }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error(".kimi-code/mcp.json must be an object");
  const servers = (document as Document).mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) throw new Error(".kimi-code/mcp.json mcpServers must be an object");
  return document as Document;
}

export function hasKimiHubMcp(cwd: string): boolean {
  return Object.hasOwn(kimiMcpDocument(cwd).mcpServers ?? {}, "agent-hub");
}

/** Only the person's launcher applies this plan; a preview inspects it without writing or displaying foreign data. */
export function kimiMcpPlan(cwd: string, stateDir: string, bundle: string, mode: "tui" | "headless") {
  const current = kimiMcpDocument(cwd);
  const servers = { ...current.mcpServers };
  if (mode === "tui") servers["agent-hub"] = { command: "bun", args: ["run", bundle], env: { AGENTHUB_PEER_ID: "kimi", AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd } };
  else delete servers["agent-hub"];
  const next = { ...current, ...(current.mcpServers !== undefined || mode === "tui" ? { mcpServers: servers } : {}) };
  const tracked = hubGitSync(["ls-files", "--error-unmatch", "--", KIMI_MCP_FILE], { cwd, encoding: "utf8", timeout: 3000 }).status === 0;
  return { file: join(cwd, KIMI_MCP_FILE), action: mode === "tui" ? "merge agent-hub entry" : "remove agent-hub entry", tracked,
    changed: JSON.stringify(current) !== JSON.stringify(next), next };
}

export function configureKimiMcp(cwd: string, stateDir: string, bundle: string, mode: "tui" | "headless"): { changed: boolean; tracked: boolean } {
  const plan = kimiMcpPlan(cwd, stateDir, bundle, mode);
  if (!plan.changed) return { changed: false, tracked: plan.tracked };
  mkdirSync(join(cwd, ".kimi-code"), { recursive: true });
  const temporary = `${plan.file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(plan.next, null, 2)}\n`); } finally { closeSync(fd); }
    renameSync(temporary, plan.file);
  } finally { try { unlinkSync(temporary); } catch { /* rename consumed our temporary file */ } }
  return { changed: true, tracked: plan.tracked };
}
