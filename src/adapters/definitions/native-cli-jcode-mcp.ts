import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hubGitSync } from "../../hub/git.ts";

export const JCODE_MCP_FILE = ".jcode/mcp.json", JCODE_MCP_NAME = "agent-hub-jcode";
type Document = Record<string, unknown>;
const object = (value: unknown): value is Document => !!value && typeof value === "object" && !Array.isArray(value);

function document(file: string): Document {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return {};
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error("Jcode MCP configuration must be a bounded regular file, not a link");
  let value: unknown; try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("Jcode MCP configuration is invalid JSON"); }
  if (!object(value)) throw new Error("Jcode MCP configuration must be an object");
  if (value.servers !== undefined && value.mcpServers !== undefined) throw new Error("Jcode MCP configuration has ambiguous server maps");
  for (const key of ["servers", "mcpServers"]) if (value[key] !== undefined && !object(value[key])) throw new Error("Jcode MCP server map must be an object");
  return value;
}
const map = (doc: Document): Document => (doc.mcpServers ?? doc.servers ?? {}) as Document;
const owned = (entry: unknown, cwd: string): entry is Document => object(entry) && object(entry.env) && entry.env.AGENTHUB_MODE === "tools" && entry.env.AGENTHUB_PEER_ID === "jcode" && entry.env.AGENTHUB_PROJECT_DIR === cwd;

export function jcodeMcpEntry(cwd: string, stateDir: string, bundle: string) {
  return { command: "bun", args: ["run", bundle], shared: false, env: { AGENTHUB_MODE: "tools", AGENTHUB_DELIVERY_ONLY: "true", AGENTHUB_PEER_ID: "jcode", AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd } };
}
/** The native loader reads later project files last. Never shadow a foreign definition. */
function inspect(cwd: string): Document {
  const directory = lstatSync(join(cwd, ".jcode"), { throwIfNoEntry: false });
  if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) throw new Error(".jcode must be a project directory, not a link");
  for (const relative of [".mcp.json", ".claude/mcp.json"]) {
    const parent = relative.startsWith(".claude/") ? lstatSync(join(cwd, ".claude"), { throwIfNoEntry: false }) : undefined;
    if (parent?.isSymbolicLink()) throw new Error("Jcode MCP override layer is a link; inspect it before launching");
    if (Object.hasOwn(map(document(join(cwd, relative))), JCODE_MCP_NAME)) throw new Error("a later project MCP layer overrides agent-hub-jcode; resolve it in your editor");
  }
  return document(join(cwd, JCODE_MCP_FILE));
}
export function jcodeMcpReady(cwd: string, stateDir: string, bundle: string): boolean {
  const entry = map(inspect(cwd))[JCODE_MCP_NAME];
  return JSON.stringify(entry) === JSON.stringify(jcodeMcpEntry(cwd, stateDir, bundle));
}
/** Only the console launcher calls this; daemon starts use jcodeMcpReady read-only. */
export function configureJcodeMcp(cwd: string, stateDir: string, bundle: string, remove = false): { changed: boolean; tracked: boolean } {
  const current = inspect(cwd), servers = { ...map(current) }, existing = servers[JCODE_MCP_NAME];
  if (existing !== undefined && !owned(existing, cwd)) throw new Error("agent-hub-jcode is a foreign MCP entry; it was not changed");
  if (remove) delete servers[JCODE_MCP_NAME]; else servers[JCODE_MCP_NAME] = jcodeMcpEntry(cwd, stateDir, bundle);
  const key = current.servers !== undefined ? "servers" : "mcpServers";
  const next = { ...current, ...(current[key] !== undefined || !remove ? { [key]: servers } : {}) };
  const tracked = hubGitSync(["ls-files", "--error-unmatch", "--", JCODE_MCP_FILE], { cwd, encoding: "utf8", timeout: 3000 }).status === 0;
  if (JSON.stringify(next) === JSON.stringify(current)) return { changed: false, tracked };
  mkdirSync(join(cwd, ".jcode"), { recursive: true });
  const file = join(cwd, JCODE_MCP_FILE), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); } finally { closeSync(fd); }
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return { changed: true, tracked };
}
