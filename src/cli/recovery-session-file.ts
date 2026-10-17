import { statSync } from "node:fs";

/** Only an absent path is positive missing evidence. Unreadable or non-file evidence stays unknown. */
export function recordedFileState(file: string): "found" | "missing" | "unknown" {
  try { return statSync(file).isFile() ? "found" : "unknown"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown"; }
}
