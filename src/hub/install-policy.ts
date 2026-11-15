/** #793b: root/workspace install hooks depend on source outside dependency cache keys. */
export const INSTALL_LIFECYCLE = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"] as const;
export class InstallPolicyError extends Error {
  constructor(readonly reason: "invalid manifest" | "lifecycle script") { super(reason); this.name = "InstallPolicyError"; }
}
/** Preserve the original #793b scripts predicate independently of a caller's JSON/object policy. */
export function installScriptsRefused(scripts: unknown): boolean {
  return scripts !== undefined && (!scripts || typeof scripts !== "object" || Array.isArray(scripts) || INSTALL_LIFECYCLE.some(name => Object.hasOwn(scripts, name)));
}
export function validateInstallManifest(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InstallPolicyError("invalid manifest");
  const scripts = (value as Record<string, unknown>).scripts;
  if (scripts === undefined) return;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) throw new InstallPolicyError("invalid manifest");
  if (installScriptsRefused(scripts)) throw new InstallPolicyError("lifecycle script");
  if (Object.values(scripts).some(script => typeof script !== "string")) throw new InstallPolicyError("invalid manifest");
}
export function parseInstallManifest(data: Uint8Array | string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(typeof data === "string" ? data : new TextDecoder("utf-8", { fatal: true }).decode(data)); }
  catch { throw new InstallPolicyError("invalid manifest"); }
  validateInstallManifest(parsed); return parsed;
}
