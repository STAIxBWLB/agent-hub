export type SpecsReview = "off" | "report" | "require";

export interface SpecsConfig {
  enabled: boolean;
  review: SpecsReview;
  roots: string[];
  stamps_file: string;
}

export const DEFAULT_SPECS_CONFIG: Readonly<SpecsConfig> = Object.freeze({
  enabled: true,
  review: "report",
  roots: [],
  stamps_file: "",
});

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function safeRelative(value: unknown): value is string {
  if (typeof value !== "string" || !value.length || value.length > 1024 || value.startsWith("/") || value.startsWith("-") || /^[A-Za-z]:/.test(value) || value.includes("\\") || value.includes(":") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  return !!normalized && !normalized.split("/").some(part => part === ".." || part === "." || part === "");
}

function invalid(message: string, nextSteps: string): never { throw new Error(`${message}; ${nextSteps}`); }

/** Filesystem-free parser shared by config loading and the specs engine. */
export function parseSpecsConfig(value: unknown): SpecsConfig {
  if (value === undefined) return { ...DEFAULT_SPECS_CONFIG, roots: [] };
  if (!object(value)) invalid("specs must be an object", "use an object with enabled, review, roots and stamps_file fields");
  if (Object.keys(value).some(key => !["enabled", "review", "roots", "stamps_file"].includes(key))) invalid("specs has an unknown field", "use only enabled, review, roots and stamps_file");
  const enabled = value.enabled === undefined ? DEFAULT_SPECS_CONFIG.enabled : value.enabled;
  const review = value.review === undefined ? DEFAULT_SPECS_CONFIG.review : value.review;
  const roots = value.roots === undefined ? DEFAULT_SPECS_CONFIG.roots : value.roots;
  const stampsFile = value.stamps_file === undefined ? DEFAULT_SPECS_CONFIG.stamps_file : value.stamps_file;
  if (typeof enabled !== "boolean") invalid("specs.enabled must be a boolean", "set it to true or false");
  if (review !== "off" && review !== "report" && review !== "require") invalid("specs.review is invalid", "choose off, report or require");
  if (!Array.isArray(roots) || roots.length > 1024 || roots.some(root => !safeRelative(root))) invalid("specs.roots is invalid", "use at most 1024 repository-relative directories without dot segments");
  if (stampsFile !== "" && !safeRelative(stampsFile)) invalid("specs.stamps_file is invalid", "use an empty value or one repository-relative path without dot segments");
  return { enabled, review, roots: [...roots] as string[], stamps_file: stampsFile as string };
}
