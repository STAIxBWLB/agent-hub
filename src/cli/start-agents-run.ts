import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient } from "../hub/control-client.ts";
import { readAutonomyDefaults, writeMachineStartAgents } from "../hub/autonomy-defaults.ts";
import { configRefusal } from "../hub/config-trust.ts";
import { START_AGENTS_DEFAULT, parseStartAgents } from "../hub/start-agents.ts";
import { MAX_COMMAND_MS } from "./terminal-recovery.ts";

/**
 * #608 (agent-hub#1040): the default agent set `ahub up` starts. Every start goes through the console `peer_start`, so it is
 * `hubStart`'s start (the peer's own start mode, the terminal provider, `already` for an attached peer, the manual command for
 * a refusal) and never a headless fallback. Nothing here reaches the daemon except that one message per listed peer.
 */
export interface StartRequester { request(message: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, any>> }

/** One printable line per agent. A refusal carries the hub's own reason, which already names the manual command. */
export function startLine(id: string, reply: Record<string, any>): string {
  if (reply.ok === true) {
    if (reply.already === true) return `${id}: already attached`;
    return `${id}: started${reply.mode ? ` ${reply.mode}` : ""}${reply.opened ? ` (${reply.opened})` : ""}${reply.mode === "tui" ? ", it attaches when its TUI is ready" : ""}`;
  }
  return `${id}: not started: ${String(reply.error ?? "the hub refused")}`;
}

/** Asks for every listed peer at once and returns the lines in list order. A refusal or a failed request never stops the others. */
export async function startDefaultAgents(client: StartRequester, agents: readonly string[]): Promise<string[]> {
  return Promise.all(agents.map(async id => {
    try { return startLine(id, await client.request({ t: "peer_start", peer: id }, MAX_COMMAND_MS + 5_000)); }
    catch (error) { return `${id}: not started: ${(error as Error).message}`; }
  }));
}

/** The list `ahub up` starts: the project's machine-local value, else this machine's `ahub setup` choice, else claude and codex. */
export function effectiveStartAgents(projectRoot: string, projectValue: readonly string[], home: string, roots: readonly string[] = []): { agents: string[]; source: "project" | "machine" | "default"; notice?: string } {
  let set = false;
  try {
    const file = join(projectRoot, ".agenthub", "config.local.json");
    if (existsSync(file)) { const doc = JSON.parse(readFileSync(file, "utf8")); set = Array.isArray(doc?.start?.agents); }
  } catch { set = false; }
  if (set) return { agents: [...projectValue], source: "project" };
  const machine = readAutonomyDefaults(home, roots);
  if (machine.startAgents) return { agents: [...machine.startAgents], source: "machine" };
  return { agents: [...START_AGENTS_DEFAULT], source: "default", ...(machine.notice ? { notice: machine.notice } : {}) };
}

/** The dashboard manager's and `ahub up`'s common path: a console connection to the running hub, then the set. */
export async function startProjectAgents(project: { root: string; stateDir: string }, agents: readonly string[], connect?: () => Promise<ControlClient>): Promise<string[]> {
  if (!agents.length) return [];
  let client: ControlClient;
  try { client = await (connect ?? (() => ControlClient.connect(project.stateDir, { role: "console", projectRoot: project.root }, 5_000)))(); }
  catch (error) { return agents.map(id => `${id}: not started: the hub did not answer (${(error as Error).message})`); }
  try { return await startDefaultAgents(client, agents); }
  finally { client.close(); }
}

export interface SetupStartPorts {
  home: string;
  roots: readonly string[];
  /** `--agents <a,b>`, already split from argv, or undefined. */
  flag?: string;
  yes: boolean;
  ask?: (prompt: string) => Promise<string | null>;
  print: (line: string) => void;
}
const show = (agents: readonly string[]) => agents.length ? agents.join(", ") : "none";

/**
 * `ahub setup`'s one question (#608): which agents `ahub up` starts. `--agents` answers it, `--yes` takes this machine's current
 * choice (or claude and codex), a terminal is asked once (an answer already on this machine is shown, not asked again), and a
 * run with no terminal and neither flag keeps the default and says so. Writes only `start.agents` of `~/.agenthub/defaults.json`.
 * Returns the refusal text for a bad `--agents`, else undefined.
 */
export async function setupStartAgents(ports: SetupStartPorts): Promise<string | undefined> {
  const held = readAutonomyDefaults(ports.home, ports.roots);
  const current = held.startAgents ?? [...START_AGENTS_DEFAULT];
  const save = (agents: string[]): void => {
    try { writeMachineStartAgents(ports.home, agents, held.fingerprint, ports.roots); ports.print(`Agents ahub up starts: ${show(agents)} (saved in this machine's defaults; a new project inherits it at ahub init).`); }
    catch { ports.print("Agents ahub up starts: not saved, because this machine's defaults.json is unsafe or changed; the default stays (claude, codex)."); }
  };
  if (ports.flag !== undefined) {
    let agents: string[];
    try { agents = parseStartAgents(ports.flag); } catch (error) { return (error as Error).message; }
    save(agents); return undefined;
  }
  if (ports.yes) { if (held.startAgents) ports.print(`Agents ahub up starts: ${show(current)} (kept).`); else save(current); return undefined; }
  if (held.startAgents) { ports.print(`Agents ahub up starts: ${show(current)} (change it with ahub setup --agents <a,b> or ahub settings set start.agents <a,b>).`); return undefined; }
  if (!ports.ask) { ports.print(`Agents ahub up starts: ${show(current)} (the default; no terminal to ask in, so pass --agents <a,b> to choose).`); return undefined; }
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await ports.ask(`Agents to start with ahub up [${show(current)}] (comma list, "none" for no agent): `);
    if (answer === null || !answer.trim()) { save(current); return undefined; }
    try { save(parseStartAgents(answer)); return undefined; } catch (error) { ports.print((error as Error).message); }
  }
  ports.print(`Agents ahub up starts: ${show(current)} (no valid answer; the default stays).`);
  return undefined;
}

/**
 * `ahub init` of a new project (#608): copies this machine's chosen set into the project's `.agenthub/config.local.json`, as the
 * autonomy preset is inherited. Only when `ahub setup` chose one, never over a value the project already has, and never into a
 * file git tracks. Person-only by its caller; returns the lines to print.
 */
export function inheritMachineStart(projectRoot: string, home: string, roots: readonly string[]): string[] {
  const machine = readAutonomyDefaults(home, roots);
  if (machine.notice) return [machine.notice];
  if (!machine.startAgents) return [];
  const file = join(projectRoot, ".agenthub", "config.local.json");
  let doc: Record<string, unknown> = {};
  try {
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ["start.agents not copied: .agenthub/config.local.json is not a JSON object"];
      doc = parsed as Record<string, unknown>;
    }
  } catch { return ["start.agents not copied: .agenthub/config.local.json could not be read"]; }
  const start = doc.start;
  if (start !== undefined && (typeof start !== "object" || start === null || Array.isArray(start))) return ["start.agents not copied: start in .agenthub/config.local.json is not an object"];
  if (start && (start as Record<string, unknown>).agents !== undefined) return [];
  const why = configRefusal(projectRoot, "config.local.json");
  if (why) return [`start.agents not copied: ${why}`];
  const text = `${JSON.stringify({ ...doc, start: { ...(start as object | undefined), agents: machine.startAgents } }, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  try { writeFileSync(temporary, text, { mode: 0o600, flag: "wx" }); renameSync(temporary, file); }
  catch (error) { try { unlinkSync(temporary); } catch { /* nothing was written */ } return [`start.agents not copied: ${(error as NodeJS.ErrnoException).code ?? "write failed"}`]; }
  return [`Inherited the machine's agent set for ahub up: ${show(machine.startAgents)}.`];
}
