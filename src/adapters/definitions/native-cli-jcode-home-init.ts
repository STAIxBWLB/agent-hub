import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assessVersion, COMPAT, configuredCommands, isCompatId, type CompatId } from "../compat.ts";
import { applyJcodeHome, hubJcodeHomePath, jcodeLoginCommand, jcodeOwnHome, planJcodeHome, sameJcodeHome, type JcodeHomePlan } from "./native-cli-jcode-home.ts";
import { jcodeExtraMcpServers, splitJcodeMcpServers } from "./native-cli-jcode-mcp.ts";
import { agentVersions } from "../../cli/agents.ts";
import { editJsonText } from "../../cli/init-settings.ts";
import { applySkillPlan, applySkillUndo, skillHostStates, skillInstallPlan, skillUndoPlan, type SkillEntry, type SkillHostState } from "../../cli/skills-install.ts";
import { configRefusal } from "../../hub/config-trust.ts";
import { idFor } from "../../hub/registry.ts";
import { projectRoot } from "../../hub/project.ts";
import { startModeOf } from "../../hub/start-mode.ts";
import type { HubConfig } from "../../hub/daemon.ts";
import { shellQuote } from "../../cli/shell-quote.ts";

/** Whether init should offer the hub-owned home: jcode is installed or rostered, and `jcode_home` is unset or the person's own. */
export function jcodeHomeApplicable(config: Pick<HubConfig, "jcode_home" | "roster" | "jcode_cmd">, env: NodeJS.ProcessEnv, installed: boolean, user = homedir()): boolean {
  if (!installed && config.roster.jcode !== true) return false;
  return sameJcodeHome(config.jcode_home, jcodeOwnHome(env, user));
}

export interface JcodeHomeInit { applicable: boolean; plan?: JcodeHomePlan; lines: string[] }

/** What `ahub init` would do for the hub-owned jcode home. Reads only; never writes the person's home. */
export function planJcodeHomeInit(input: { cwd: string; stateDir: string; bundle: string; hubHome: string; config: HubConfig; env: NodeJS.ProcessEnv; installed: boolean; user?: string }): JcodeHomeInit {
  const { cwd, stateDir, bundle, hubHome, config, env, installed } = input, user = input.user ?? homedir();
  const own = jcodeOwnHome(env, user);
  const configured = !sameJcodeHome(config.jcode_home, own);
  // A project that already names a separate home keeps it: init checks that home for drift and creates nothing.
  if (!configured && !jcodeHomeApplicable(config, env, installed, user)) return { applicable: false, lines: [] };
  const home = configured ? config.jcode_home : hubJcodeHomePath(hubHome, idFor(projectRoot(cwd)));
  const plan = planJcodeHome({ home, own, cwd, stateDir, bundle, allow: config.jcode_mcp_allow ?? [] });
  const lines: string[] = [];
  if (plan.exists) {
    lines.push(`jcode home ${home}: ${plan.drift.length ? "drift" : "up to date"}`);
    for (const drift of plan.drift) lines.push(`  ${drift}`);
  } else {
    lines.push(`create ${home}: hub-owned jcode home (mcp.json with agent-hub-jcode${Object.keys(plan.servers).length > 1 ? ` and ${Object.keys(plan.servers).filter(name => name !== "agent-hub-jcode").join(", ")}` : ""}; no sessions, history or login copied)`);
    if (plan.absentAllowed.length) lines.push(`  jcode_mcp_allow names ${plan.absentAllowed.join(", ")}, which ${join(own, "mcp.json")} does not define: nothing to copy`);
    lines.push(`  modify .agenthub/config.local.json: jcode_home -> ${home}`);
    lines.push(`  person step after init, to log in there: ${jcodeLoginCommand(home)}`);
  }
  return { applicable: true, plan, lines };
}

/** Set `jcode_home` in the untracked local config, keeping every other byte. Refuses a tracked or unreadable file. */
export function writeJcodeHomeConfig(cwd: string, home: string): void {
  const file = join(cwd, ".agenthub", "config.local.json");
  const refusal = configRefusal(cwd, "config.local.json");
  if (refusal) throw new Error(`jcode_home was not written: ${refusal}; move it to an untracked .agenthub/config.local.json`);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "{}\n";
  const next = editJsonText(text, ["jcode_home"], home);
  if (next === text) return;
  const temporary = `${file}.${process.pid}.tmp`;
  try { writeFileSync(temporary, next, { mode: 0o600, flag: "wx" }); renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** Install the hub skills into one jcode home, under the marker contract; only the jcode host is touched. */
export function installSkillsInJcodeHome(source: string, home: string): SkillEntry[] {
  const paths = { home: homedir(), env: { ...process.env, JCODE_HOME: home } };
  const plan = skillInstallPlan(source, paths).filter(entry => entry.host === "jcode");
  return applySkillPlan(source, plan).filter(entry => entry.host === "jcode");
}

/** Every jcode home the hub owns besides the person's: the configured `jcode_home` and each instance's. */
export function jcodeSkillHomes(config: Pick<HubConfig, "jcode_home" | "instances">, env: NodeJS.ProcessEnv, user = homedir()): string[] {
  const own = jcodeOwnHome(env, user), homes = new Set<string>();
  if (!sameJcodeHome(config.jcode_home, own)) homes.add(config.jcode_home);
  for (const declaration of Object.values(config.instances ?? {})) if (declaration.kind === "jcode" && declaration.jcode_home) homes.add(declaration.jcode_home);
  return [...homes];
}

/**
 * `ahub setup`'s skill step for the hub-owned jcode homes (#1627 AC1b): the same marker contract as the other hosts, only the jcode host, one home at a time.
 * A tree the person edited, a foreign tree and a link are reported and left alone, exactly as for the shell's home.
 */
export async function installHubSkillsInJcodeHomes(options: { source?: string; homes: readonly string[]; undo?: boolean; yes: boolean; ask?: (prompt: string) => Promise<string | null>; print: (line: string) => void }): Promise<void> {
  for (const home of options.homes) {
    const paths = { home: homedir(), env: { ...process.env, JCODE_HOME: home } };
    const label = `hub skills (hub-owned jcode home ${home})`;
    const asked = async (prompt: string): Promise<boolean> => {
      if (options.yes) return true;
      const answer = options.ask ? await options.ask(prompt) : null;
      return typeof answer === "string" && /^y(es)?$/i.test(answer.trim());
    };
    if (options.undo) {
      const plan = skillUndoPlan(paths).filter(entry => entry.host === "jcode"), removable = plan.filter(entry => entry.action === "remove");
      if (!removable.length) { options.print(`${label}: nothing to remove`); continue; }
      if (!(await asked(`Remove ${removable.length} hub skill tree(s) from ${home}? [y/N] `))) { options.print(`${label}: nothing removed; rerun with --yes`); continue; }
      const done = applySkillUndo(plan).filter(entry => entry.host === "jcode");
      options.print(`${label}: ${done.filter(entry => entry.action === "removed").length} removed, ${done.filter(entry => entry.action === "failed").length} failed`);
      continue;
    }
    if (!options.source) continue;
    let plan: SkillEntry[];
    try { plan = skillInstallPlan(options.source, paths).filter(entry => entry.host === "jcode"); }
    catch (error) { options.print(`${label}: skipped (${(error as Error).message})`); continue; }
    const hostLevel = plan.find(entry => !entry.skill);
    if (hostLevel) { options.print(`${label}: ${hostLevel.action} (${hostLevel.detail})`); continue; }
    const writable = plan.filter(entry => entry.action === "install" || entry.action === "replace");
    if (!writable.length) { options.print(`${label}: up to date${plan.some(entry => ["modified", "foreign", "linked", "failed"].includes(entry.action)) ? "; some trees are left untouched" : ""}`); continue; }
    if (!(await asked(`Install hub skills into ${home}? [y/N] `))) { options.print(`${label}: nothing written; rerun with --yes`); continue; }
    const done = applySkillPlan(options.source, plan);
    options.print(`${label}: ${done.filter(entry => entry.action === "install").length} installed, ${done.filter(entry => entry.action === "replace").length} replaced, ${done.filter(entry => entry.action === "failed").length} failed`);
  }
}

/** The doctor's read of the hub skills in the hub-owned homes, one state per home, nothing written. */
export function jcodeHomeSkillStates(homes: readonly string[], expected: readonly string[]): (SkillHostState & { home: string })[] {
  return homes.map(home => ({ home, ...skillHostStates({ home: homedir(), env: { ...process.env, JCODE_HOME: home } }, expected).find(state => state.host === "jcode")! }));
}

export interface RosterFinding { text: string; fix?: string }
/** The preflight `ahub roster add` prints for every kind (#1627 B): CLI path and version, start mode, and the kind's own checks, each with a complete fix. */
export function rosterPreflight(peer: string, kind: string, cwd: string, config: HubConfig, env: NodeJS.ProcessEnv, user = homedir()): RosterFinding[] {
  const out: RosterFinding[] = [];
  const cd = `cd ${shellQuote(cwd)}`;
  if (isCompatId(kind)) {
    const id: CompatId = kind;
    const row = agentVersions(configuredCommands(config)).find(candidate => candidate.id === id);
    if (!row?.executable) out.push({ text: `${COMPAT[id].label} CLI: not found on PATH`, fix: `install ${COMPAT[id].label}, or set its command in .agenthub/config.local.json` });
    else {
      const verdict = row.verdict;
      out.push(verdict.ok && verdict.state === "verified" ? { text: `${COMPAT[id].label} CLI: ${row.executable}, version verified` }
        : verdict.ok ? { text: `${COMPAT[id].label} CLI: ${row.executable}, ${verdict.note ?? verdict.state}` }
        : { text: `${COMPAT[id].label} CLI: ${row.executable}, version not accepted (${verdict.reason})`, fix: `ahub agents` });
    }
  } else out.push({ text: `${kind}: no CLI version gate` });
  let mode = "n/a";
  try { mode = startModeOf(config.peers, peer) ?? "n/a"; } catch { /* a peer without a start mode */ }
  out.push({ text: `start mode: ${mode}` });
  if (kind === "jcode") {
    const instance = config.instances?.[peer];
    const home = instance?.jcode_home ?? config.jcode_home, own = jcodeOwnHome(env, user);
    if (sameJcodeHome(home, own)) out.push({ text: `jcode home ${home} is your own: every MCP server and config change you make there reaches the hub-owned jcode`, fix: `${cd} && ahub init` });
    else out.push({ text: `jcode home ${home} is separate from your own (${own})` });
    const found = jcodeExtraMcpServers(cwd, home);
    const { allowed, refused } = splitJcodeMcpServers(found.servers, instance?.jcode_mcp_allow ?? config.jcode_mcp_allow ?? []);
    if (allowed.length) out.push({ text: `MCP servers allowed by you: ${allowed.join(", ")}` });
    if (refused.length) out.push({ text: `MCP servers that would load and are not allowed: ${refused.join(", ")}`, fix: `remove them from ${join(home, "mcp.json")}, or allow them by adding "jcode_mcp_allow": [${refused.map(name => JSON.stringify(name)).join(", ")}] to ${join(cwd, ".agenthub", "config.local.json")}` });
    if (found.unreadable.length) out.push({ text: `unreadable or unsafe MCP files: ${found.unreadable.join(", ")}`, fix: "fix them in your editor" });
  }
  return out;
}

export const rosterPreflightLines = (peer: string, findings: readonly RosterFinding[]): string[] =>
  [`preflight for ${peer}:`, ...findings.flatMap(finding => [`  ${finding.text}`, ...(finding.fix ? [`    fix: ${finding.fix}`] : [])])];

/** Whether a symlink or non-directory sits where init would create the home. */
export const jcodeHomeBlocked = (home: string): boolean => { const info = lstatSync(home, { throwIfNoEntry: false }); return !!info && (info.isSymbolicLink() || !info.isDirectory()); };
export { applyJcodeHome };
