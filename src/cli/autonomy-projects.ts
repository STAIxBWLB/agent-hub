import { randomUUID } from "node:crypto";
import { readAutonomyDefaults, writeAutonomyDefaults } from "../hub/autonomy-defaults.ts";
import { ControlClient } from "../hub/control-client.ts";
import { inspectProject } from "../hub/lifecycle.ts";
import { processSignature } from "../pi/process-signature.ts";
import type { Project, Registry } from "../hub/registry.ts";
import { applyOfflineAutonomy, planOfflineAutonomy } from "./autonomy-offline.ts";

export interface PreparedAutonomyProject { lines: string[]; apply(): Promise<string[]>; close(): void }
export interface AllProjectAutonomyPorts {
  home: string;
  environment: string;
  projects: readonly Project[];
  prepare(project: Project, enabled: boolean): Promise<PreparedAutonomyProject>;
  ask(prompt: string): Promise<string | null>;
  print(line: string): void;
}
/** Init is already person-only. Inheritance writes no consent and starts no daemon. */
export async function inheritMachineAutonomy(project: Project, home: string, environment: string, registry: Registry): Promise<string[]> {
  const defaults = readAutonomyDefaults(home, registry.list().map(row => row.root));
  if (defaults.notice) return [defaults.notice];
  if (!defaults.enabled) return [];
  const prepared = await prepareAutonomyProject(project, environment, true, registry);
  try { return ["Inherited the trusted machine autonomy default.", ...await prepared.apply()]; }
  finally { prepared.close(); }
}
/** Registry ownership excludes a concurrent daemon starter while an offline write runs. */
export async function prepareAutonomyProject(project: Project, environment: string, enabled: boolean, registry: Registry): Promise<PreparedAutonomyProject> {
  const inspection = await inspectProject(project);
  if (inspection.state === "running") {
    const client = await ControlClient.connect(project.stateDir, { role: "console", projectRoot: project.root, instanceId: inspection.status.instanceId });
    const request = async (action: string, confirmation?: string) => {
      const reply = await client.request({ t: "autonomy", action, environment, ...(enabled ? { confirmed: true, confirmation } : {}) }, 35_000);
      if (reply.ok !== true) throw new Error(String(reply.error ?? "project autonomy request refused"));
      return reply;
    };
    try {
      const preview = enabled ? await request("preview") : undefined;
      if (enabled && typeof preview?.confirmation !== "string") throw new Error("project autonomy preview is unavailable; upgrade this hub");
      return { lines: preview?.lines ?? ["Remove the fixed preset keys and retained consent, including manual edits to those keys."],
        apply: async () => (await request(enabled ? "on" : "off", preview?.confirmation)).lines ?? [], close: () => client.close() };
    } catch (error) { client.close(); throw error; }
  }
  if (inspection.state !== "stopped") throw new Error(inspection.error ?? `project is ${inspection.state}; autonomy was not changed`);
  const preview = planOfflineAutonomy(project, environment, enabled);
  return { lines: preview.lines, close: () => {}, apply: async () => {
    const current = registry.get(project.id);
    if (!current || current.root !== project.root || current.stateDir !== project.stateDir) throw new Error("project registration changed; autonomy was not changed");
    const claim = randomUUID();
    if (!registry.claim(project.id, claim, process.pid, processSignature(process.pid))) throw new Error("project acquired a live owner; autonomy was not changed");
    try { return applyOfflineAutonomy(project, environment, enabled, preview); }
    finally { registry.release(project.id, claim); }
  } };
}
/** All on previews precede the one confirmation; partial apply failures are named rather than hidden. */
export async function runAllProjectAutonomy(args: readonly string[], ports: AllProjectAutonomyPorts): Promise<void> {
  const [action, ...flags] = args;
  if (!["on", "off"].includes(action ?? "") || !flags.includes("--all-projects") || new Set(flags).size !== flags.length || flags.some(flag => flag !== "--all-projects" && !(action === "on" && flag === "--yes"))) throw new Error("usage: ahub autonomy on [--yes] --all-projects | off --all-projects");
  if (ports.projects.length > 256) throw new Error("at most 256 registered projects can be applied in one command");
  const enabled = action === "on", roots = ports.projects.map(project => project.root), defaults = readAutonomyDefaults(ports.home, roots);
  if (defaults.notice) ports.print(defaults.notice);
  const prepared: { project: Project; plan: PreparedAutonomyProject }[] = [], failures: string[] = [];
  try {
    for (const project of ports.projects) {
      try {
        const plan = await ports.prepare(project, enabled);
        prepared.push({ project, plan });
        ports.print(`Project ${project.root}:`);
        for (const line of plan.lines) ports.print(`  ${line}`);
      } catch (error) { failures.push(project.id); ports.print(`${project.root}: ${String((error as Error).message)}`); }
    }
    if (enabled && failures.length) throw new Error(`${failures.length} project preview(s) refused; no machine or project setting was changed`);
    ports.print(`Machine autonomy default: ${enabled ? "on" : "off"}; ${prepared.length} registered project(s).`);
    if (enabled && !flags.includes("--yes") && !["y", "yes"].includes((await ports.ask("Apply machine autonomy and every previewed project? [y/N] "))?.trim().toLowerCase() ?? "")) { ports.print("Machine and project autonomy were not changed."); return; }
    if (!enabled && defaults.fingerprint === "untrusted") ports.print("Unsafe machine defaults are already ignored; their file was left unchanged.");
    else writeAutonomyDefaults(ports.home, enabled, defaults.fingerprint, roots);
    for (const { project, plan } of prepared) {
      try { for (const line of await plan.apply()) ports.print(`${project.root}: ${line}`); }
      catch (error) { failures.push(project.id); ports.print(`${project.root}: ${String((error as Error).message)}`); }
    }
    if (failures.length) throw new Error(`Machine default is ${enabled ? "on" : "off"}; ${failures.length} project(s) were not applied. Inspect the named projects before retrying.`);
    ports.print(`Machine autonomy ${action}: applied to ${prepared.length} registered project(s).`);
  } finally { for (const { plan } of prepared) plan.close(); }
}
