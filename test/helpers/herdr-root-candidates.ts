/**
 * Specification by example for H1 (#1199), not shipped code: how the focused pane's machine and cwd become candidate ahub project roots.
 * It is pure. It never touches a filesystem, never resolves a path, and never runs ahub: the registered projects are an input, read by the caller with
 * exec(on: machine). A remote cwd is therefore never resolved or tested on this Mac. The cwd is a navigation hint, never project authority.
 */
import type { FakeHerdrModHost } from "./herdr-mod-host.ts";

export interface HerdrRegisteredProject { id: string; root: string }
export type HerdrRootCandidates =
  | { kind: "no_context" }
  | { kind: "machine_unavailable"; machine: string | null }
  | { kind: "unknown_machine"; machine: string }
  | { kind: "no_cwd"; machine: string | null; choices: HerdrRegisteredProject[] }
  | { kind: "duplicate"; machine: string | null; root: string }
  | { kind: "none"; machine: string | null; cwd: string; choices: HerdrRegisteredProject[] }
  | { kind: "single"; machine: string | null; cwd: string; project: HerdrRegisteredProject }
  | { kind: "ambiguous"; machine: string | null; cwd: string; candidates: HerdrRegisteredProject[]; highlighted: HerdrRegisteredProject };

/** Equal, or an ancestor at a path-segment boundary. `/work/a` does not contain `/work/ab`. */
export function containsAtBoundary(root: string, cwd: string): boolean {
  if (!root || !cwd || !root.startsWith("/") || !cwd.startsWith("/")) return false;
  const r = root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
  return cwd === r || r === "/" || cwd.startsWith(`${r}/`);
}

export function herdrRootCandidates(host: FakeHerdrModHost, registered: readonly HerdrRegisteredProject[]): HerdrRootCandidates {
  const focus = host.focused();
  if (!focus) return { kind: "no_context" };
  const space = host.spaces().find(s => s.id === focus.space);
  if (!space) return { kind: "no_context" };
  const machine = space.machine;
  const known = host.machines().find(m => m.name === machine);
  if (!known) return machine === null ? { kind: "machine_unavailable", machine } : { kind: "unknown_machine", machine };
  if (known.layout !== "ready") return { kind: "machine_unavailable", machine };
  const roots = new Map<string, number>();
  for (const project of registered) roots.set(project.root, (roots.get(project.root) ?? 0) + 1);
  const duplicate = [...roots].find(([, count]) => count > 1);
  if (duplicate) return { kind: "duplicate", machine, root: duplicate[0] };
  const choices = registered.map(p => ({ ...p }));
  if (!focus.cwd) return { kind: "no_cwd", machine, choices };
  const hits = registered.filter(p => containsAtBoundary(p.root, focus.cwd!)).sort((a, b) => b.root.length - a.root.length);
  if (hits.length === 0) return { kind: "none", machine, cwd: focus.cwd, choices };
  if (hits.length === 1) return { kind: "single", machine, cwd: focus.cwd, project: { ...hits[0]! } };
  return { kind: "ambiguous", machine, cwd: focus.cwd, candidates: hits.map(p => ({ ...p })), highlighted: { ...hits[0]! } };
}

/** The bounded read of a machine's registrations: fixed argv, no shell, cwd unset so nothing on that machine is assumed. */
export async function readRegisteredProjects(host: FakeHerdrModHost, machine: string | null): Promise<HerdrRegisteredProject[] | { error: string }> {
  let result;
  try { result = await host.exec("ahub", ["projects", "--json"], machine === null ? {} : { on: machine }); }
  catch (error) { return { error: (error as { code?: string }).code ?? "exec_failed" }; }
  if (result.code !== 0) return { error: "nonzero_exit" };
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { return { error: "not_json" }; }
  if (!Array.isArray(value)) return { error: "not_a_list" };
  const out: HerdrRegisteredProject[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || typeof (row as any).id !== "string" || typeof (row as any).root !== "string" || !(row as any).root.startsWith("/")) return { error: "bad_row" };
    out.push({ id: (row as any).id, root: (row as any).root });
  }
  return out;
}
