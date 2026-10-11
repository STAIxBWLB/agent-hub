import dev from "../../templates/profiles/dev.json";
import research from "../../templates/profiles/research.json";
import writing from "../../templates/profiles/writing.json";
import general from "../../templates/profiles/general.json";
import type { TaskClass } from "./board.ts";
export const PROFILE_NAMES = ["dev", "research", "writing", "general"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];
export interface ProjectProfile {
  name: string; classes: Record<string, string>; plan_keys: string[]; role_text: Record<string, string>;
  catalog_roles: Record<string, string[]>; agents: string; example_checks: string[];
}
const PROFILES: Record<ProfileName, ProjectProfile> = { dev, research, writing, general };
export function profileName(raw: unknown): ProfileName {
  if (raw === undefined) return "dev";
  if (typeof raw !== "string" || !PROFILE_NAMES.includes(raw as ProfileName)) throw new Error(`profile must be one of ${PROFILE_NAMES.join(", ")}`);
  return raw as ProfileName;
}
export const projectProfile = (raw?: unknown): ProjectProfile => PROFILES[profileName(raw)];
export function profileClass(raw: string, profile: ProfileName = "dev"): TaskClass {
  const data = projectProfile(profile);
  const base = typeof raw === "string" ? (Object.hasOwn(data.classes, raw) ? data.classes[raw] : Object.hasOwn(dev.classes, raw) ? (dev.classes as Record<string, string>)[raw] : undefined) : undefined;
  if (!base) throw new Error(`class must be one of ${Object.keys(data.classes).join(", ")} (profile ${profile}; existing base classes also accepted)`);
  return base as TaskClass;
}
export const profileTaskLabel = (task: { class: string; profile?: string; profileClass?: string }) => task.profileClass ? `${task.profileClass} (base ${task.class}, ${task.profile})` : task.class;
export const PROFILE_CLASS_NAMES = [...new Set(Object.values(PROFILES).flatMap(p => Object.keys(p.classes)))];
