import { NEVER_EDITABLE, SETTINGS } from "./settings.ts";

/**
 * #689: which structural keys a person may edit, and from where.
 * Tier 1 is the settings registry (already editable, unchanged). Tier 2 is structural config, editable from the console and
 * from a dashboard settings session. Tier 3 chooses what the hub executes or where secrets go: console only, typed key.
 * One rule serves the editor, the dashboard's server-side refusal and reload authority, so none of them can drift.
 */
export const CONFIG_EDIT_FILES = ["config.local.json", "sdlc.toml"] as const;
export type ConfigEditFile = typeof CONFIG_EDIT_FILES[number];
export type ConfigTier = { tier: 2 } | { tier: 3; key: string } | { refused: string };

const PEER = /^[a-z][a-z0-9-]{0,31}$/;
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
/** Instance fields that choose no executable and no home. */
export const TIER2_INSTANCE_FIELDS = ["kind", "roles", "start_mode", "review_mode", "readOnly", "worktree", "permission_mode"] as const;
/** Instance fields that choose a native home, account or model: tier 3 (#685). */
export const TIER3_INSTANCE_FIELDS = ["jcode_home", "provider", "model", "provider_profile"] as const;
/** Every NEVER_EDITABLE key except `instances`, which splits by field. */
export const TIER3_PREFIXES: readonly string[] = NEVER_EDITABLE.filter(key => key !== "instances");
const TIER2_BLOCKS: Readonly<Record<string, readonly string[]>> = {
  review: ["adaptive", "min_reviews", "pool", "rerotate"],
  snapshots: ["keep"],
  approvals: ["timeout_s"],
  context: ["gate"],
};
const SDLC_KEYS = ["mode", "required_checks"] as const;
/** Registry-owned keys keep their own write path: a roster change moves tasks and stops peers, and a WIP limit applies live. */
const REGISTRY_PREFIXES = ["roster", "tasks.wip_limits", "permission_modes", "catalog_roles", "peers"] as const;
const registryKey = (key: string): boolean => SETTINGS.some(def => def.key === key || def.path.join(".") === key) || REGISTRY_PREFIXES.some(prefix => key === prefix || key.startsWith(`${prefix}.`));

const refuse = (reason: string): { refused: string } => ({ refused: `${reason}; nothing was written` });
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The tier of one edit. `value` is only read for a whole `instances.<id>` object, whose fields are classified one by one
 * (the highest tier wins, an unknown field is refused by name, never dropped).
 */
export function configTier(file: ConfigEditFile, path: readonly string[], value?: unknown, held?: unknown): ConfigTier {
  if (!path.length || path.some(part => typeof part !== "string" || !part || part.length > 64 || UNSAFE.has(part) || /[\s\x00-\x1f]/.test(part))) return refuse("invalid configuration path");
  const key = path.join(".");
  if (file === "sdlc.toml") return path.length === 1 && (SDLC_KEYS as readonly string[]).includes(path[0]!) ? { tier: 2 } : refuse(`sdlc.${key} is not editable here: only mode and required_checks are; edit .agenthub/sdlc.toml in your editor`);
  if (registryKey(key)) return { refused: `${key} is already editable with ahub settings set ${key}; nothing was written` };
  if (path[0] === "instances") {
    if (path.length === 1) return refuse("instances: name one instance (instances.<id>)");
    if (!PEER.test(path[1]!)) return refuse(`instances.${path[1]}: an instance id is lower-case letters, digits and hyphens`);
    if (path.length === 2) {
      // A whole instance that already holds a native home, account or model is tier 3 to remove or replace, whatever the new value is:
      // its values are what a browser must never see or delete (#689 review).
      if (isObject(held) && TIER3_INSTANCE_FIELDS.some(field => Object.hasOwn(held, field))) return { tier: 3, key: `instances.${path[1]}` };
      if (value === undefined || value === null) return { tier: 2 }; // removal of a whole declaration; the loaders judge what depends on it
      if (!isObject(value)) return refuse(`instances.${path[1]}: must be an object of instance fields`);
      let tier3: string | undefined;
      for (const field of Object.keys(value)) {
        if ((TIER3_INSTANCE_FIELDS as readonly string[]).includes(field)) tier3 = `instances.${path[1]}`;
        else if (!(TIER2_INSTANCE_FIELDS as readonly string[]).includes(field)) return refuse(`instances.${path[1]}.${field}: unknown instance field`);
      }
      return tier3 ? { tier: 3, key: tier3 } : { tier: 2 };
    }
    if (path.length === 3) {
      if ((TIER3_INSTANCE_FIELDS as readonly string[]).includes(path[2]!)) return { tier: 3, key };
      if ((TIER2_INSTANCE_FIELDS as readonly string[]).includes(path[2]!)) return { tier: 2 };
    }
    return refuse(`${key}: unknown instance field`);
  }
  const never = TIER3_PREFIXES.find(prefix => key === prefix || key.startsWith(`${prefix}.`));
  if (never) return { tier: 3, key };
  const fields = TIER2_BLOCKS[path[0]!];
  if (fields && path.length === 2 && fields.includes(path[1]!)) return { tier: 2 };
  return refuse(`${key} is not a structural setting`);
}

/** Whether reload authority may take this key as a confirmed structural edit: tier 2 only, never an executable or secret key. */
export function structuralLeaf(key: string): boolean {
  const path = key.split(".");
  const tier = configTier("config.local.json", path);
  return "tier" in tier && tier.tier === 2;
}

/** A value as a reply may show it: a tier 3 key is only ever `(set)`, and inside a whole instance only its tier 3 fields are. */
export function maskTier3(path: readonly string[], value: unknown): unknown {
  if (value === undefined) return undefined;
  const key = path.join(".");
  if (path[0] === "instances" && path.length === 2 && isObject(value)) return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, (TIER3_INSTANCE_FIELDS as readonly string[]).includes(field) ? "(set)" : item]));
  const tier = configTier("config.local.json", path, undefined);
  if ("tier" in tier && tier.tier === 3) return "(set)";
  if (TIER3_PREFIXES.some(prefix => key === prefix || key.startsWith(`${prefix}.`))) return "(set)";
  return value;
}
