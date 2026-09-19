import { readFileSync } from "node:fs";
import { join } from "node:path";

type Table = Record<string, unknown>;

export interface Routing {
  local: { route?: string; fixed_model: string };
  targets: Record<string, Table & { id: string }>;
  routes: Record<string, Table & { type: string }>;
}

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "routing.toml");

/** `.agenthub/routing.toml`, or the shipped default when the project has none. Throws on a file that does not parse or lacks a fixed model. */
export function loadRouting(cwd: string): Routing {
  let text: string;
  try {
    text = readFileSync(join(cwd, ".agenthub", "routing.toml"), "utf8");
  } catch {
    text = readFileSync(TEMPLATE, "utf8");
  }
  const raw = Bun.TOML.parse(text) as Partial<Routing>;
  if (!raw.local?.fixed_model) throw new Error("routing.toml: [local] fixed_model is required (the path that works without Switchyard)");
  return { local: raw.local, targets: raw.targets ?? {}, routes: raw.routes ?? {} };
}
