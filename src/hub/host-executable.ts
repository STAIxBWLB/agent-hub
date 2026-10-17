import { isAbsolute, relative } from "node:path";
import { realPath } from "./project.ts";

/** A repo-writable PATH shim is not a host-owned authenticated capability. No caller-selected binary. */
export function hostExecutable(name: "gh" | "container" | "git", projectDir: string, path = process.env.PATH ?? ""): string {
  const found = Bun.which(name, { PATH: path });
  if (!found || !isAbsolute(found)) throw new Error(`${name} unavailable`);
  const target = realPath(found), inside = relative(realPath(projectDir), target);
  if (!inside || inside !== ".." && !inside.startsWith("../") && !isAbsolute(inside)) throw new Error(`${name} unavailable`);
  return target;
}
