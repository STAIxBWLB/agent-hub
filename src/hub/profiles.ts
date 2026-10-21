import dev from "../../templates/profiles/dev.json";
import research from "../../templates/profiles/research.json";
import writing from "../../templates/profiles/writing.json";
import general from "../../templates/profiles/general.json";
import { ALL_PLAN_KEYS, CLASSES, type TaskClass } from "./board.ts";
import { catalogAssignments } from "./roles.ts";
import { sanitize } from "./envelope.ts";
export const PROFILE_NAMES = ["dev", "research", "writing", "general"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];
export interface ProjectProfile {
  name: string; classes: Record<string, string>; plan_keys: string[]; role_text: Record<string, string>;
  catalog_roles: Record<string, string[]>; agents: string; example_checks: string[];
  review_checklist?: string[];
}
const PROFILES: Record<ProfileName, ProjectProfile> = { dev, research, writing, general };
export function profileName(raw: unknown): ProfileName {
  if (raw === undefined) return "dev";
  if (typeof raw !== "string" || !PROFILE_NAMES.includes(raw as ProfileName)) throw new Error(`profile must be one of ${PROFILE_NAMES.join(", ")}`);
  return raw as ProfileName;
}
export const projectProfile = (raw?: unknown): ProjectProfile => PROFILES[profileName(raw)];
export type ProfileSelection = ProfileName | ProjectProfile;
export const profileData = (profile: ProfileSelection = "dev"): ProjectProfile => typeof profile === "string" ? projectProfile(profile) : profile;
export function profileClass(raw: string, profile: ProfileSelection = "dev"): TaskClass {
  const data = profileData(profile);
  const base = typeof raw === "string" ? (Object.hasOwn(data.classes, raw) ? data.classes[raw] : Object.hasOwn(dev.classes, raw) ? (dev.classes as Record<string, string>)[raw] : undefined) : undefined;
  if (!base) throw new Error(`class must be one of ${Object.keys(data.classes).join(", ")} (profile ${data.name}; existing base classes also accepted)`);
  return base as TaskClass;
}
export const profileTaskLabel = (task: { class: string; profile?: string; profileClass?: string }) => task.profileClass ? `${task.profileClass} (base ${task.class}, ${task.profile})` : task.class;
export const PROFILE_CLASS_NAMES = [...new Set(Object.values(PROFILES).flatMap(p => Object.keys(p.classes)))];

/** Pure project data resolution. No mutation of shipped profiles or executable check defaults. */
export function resolveProfile(raw?: unknown, overrides?: unknown): ProjectProfile {
  const original = projectProfile(raw);
  if (overrides === undefined) return original;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("profile_overrides must be an object");
  const data = overrides as Record<string, unknown>, allowed = new Set(["classes", "plan_keys", "role_text", "catalog_roles", "agents", "example_checks", "review_checklist"]);
  if (Object.keys(data).some(key => !allowed.has(key))) throw new Error("unknown profile override field");
  if (!Object.keys(data).length) return original;
  const result: ProjectProfile = { ...original, classes: { ...original.classes }, plan_keys: [...original.plan_keys], role_text: { ...original.role_text }, catalog_roles: Object.fromEntries(Object.entries(original.catalog_roles).map(([peer, ids]) => [peer, [...ids]])), example_checks: [...original.example_checks], ...(original.review_checklist ? { review_checklist: [...original.review_checklist] } : {}) };
  const text = (value: unknown, cap: number): string => { if (typeof value !== "string" || value.length > cap) throw new Error("profile text is missing or oversized"); return sanitize(value); };
  if (data.classes !== undefined) {
    if (!data.classes || typeof data.classes !== "object" || Array.isArray(data.classes) || Object.keys(data.classes).length > 32) throw new Error("profile classes must be a bounded base-class map");
    for (const [name, base] of Object.entries(data.classes)) {
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(name) || typeof base !== "string" || !CLASSES.includes(base as TaskClass) || CLASSES.includes(name as TaskClass) && name !== base) throw new Error("profile class must retain an existing base-class meaning");
      result.classes[name] = base;
    }
  }
  if (data.plan_keys !== undefined) {
    if (!Array.isArray(data.plan_keys) || !data.plan_keys.length || data.plan_keys.length > ALL_PLAN_KEYS.length || new Set(data.plan_keys).size !== data.plan_keys.length || data.plan_keys.some(key => !ALL_PLAN_KEYS.includes(key))) throw new Error("profile plan_keys must select distinct supported fields");
    result.plan_keys = [...data.plan_keys];
  }
  if (data.role_text !== undefined) {
    if (!data.role_text || typeof data.role_text !== "object" || Array.isArray(data.role_text) || Object.keys(data.role_text).length > 8) throw new Error("profile role_text must be bounded guidance");
    for (const [role, value] of Object.entries(data.role_text)) {
      if (!["planner", "implementer", "verifier", "reviewer", "conductor"].includes(role)) throw new Error("profile role_text must name an existing flow role");
      result.role_text[role] = text(value, 2000);
    }
  }
  if (data.catalog_roles !== undefined) result.catalog_roles = { ...result.catalog_roles, ...catalogAssignments(data.catalog_roles) };
  if (data.agents !== undefined) result.agents = text(data.agents, 16000);
  if (data.example_checks !== undefined) {
    if (!Array.isArray(data.example_checks) || data.example_checks.length > 16) throw new Error("profile example_checks must be a bounded display list");
    result.example_checks = data.example_checks.map(value => text(value, 2000));
  }
  if (data.review_checklist !== undefined) {
    if (!Array.isArray(data.review_checklist) || !data.review_checklist.length || data.review_checklist.length > 16 || data.review_checklist.some(value => typeof value !== "string" || !value.trim() || value.length > 500)) throw new Error("profile review_checklist must be bounded checklist lines");
    result.review_checklist = data.review_checklist.map(value => sanitize(value.trim()));
  }
  return result;
}

/** Maps merge across shared/local layers; selections and display text replace as a unit. */
export function mergeProfileOverrides(a: unknown, b: unknown): Record<string, unknown> | undefined {
  if (a === undefined && b === undefined) return undefined;
  const left = (a ?? {}) as Record<string, unknown>, right = (b ?? {}) as Record<string, unknown>;
  return { ...left, ...right, ...Object.fromEntries(["classes", "role_text", "catalog_roles"].filter(key => left[key] !== undefined && right[key] !== undefined).map(key => [key, { ...(left[key] as object), ...(right[key] as object) }])) };
}
