import { sanitize } from "./envelope.ts";

/** Public approval rendering, never the arguments eventually executed by the native child.
 * Withhold the complete value if any private/secret/path policy matches, before truncation. */
export function permissionPayload(tool: unknown, input: unknown, publicText: (text: string) => boolean): { tool: string; title: string } {
  const name = typeof tool === "string" && /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(tool) && publicText(tool) ? tool : "[withheld]";
  let rendered = "[withheld]";
  try {
    const text = JSON.stringify(input);
    if (typeof text === "string" && Buffer.byteLength(text) <= 64 * 1024 && publicText(text)) rendered = sanitize(text);
  } catch { /* Unknown or unserializable arguments are never partially shown. */ }
  return { tool: name, title: Array.from(`${name} ${rendered}`).slice(0, 600).join("") };
}
