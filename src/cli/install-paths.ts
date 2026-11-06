import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realPath } from "../hub/project.ts";

export interface InstallPathOptions {
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  globalFlag?: "-g" | "--global";
}
const packageRoot = resolve(import.meta.dir, "../..");
// Contract: #1245 limits lexical symlink inspection to eight hops; unknown paths use the resolved fallback.
const MAX_LINK_HOPS = 8;
const samePath = (left: string, right: string): boolean => {
  try { return realPath(left) === realPath(right); } catch { return false; }
};

/** Follow only the leaf links, preserving lexical parent aliases such as current/. */
function lexicalTarget(entry: string): string | undefined {
  let link = resolve(entry);
  const seen = new Set<string>();
  try {
    for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
      if (seen.has(link)) return;
      seen.add(link);
      if (!lstatSync(link).isSymbolicLink()) return link;
      if (hops === MAX_LINK_HOPS) return;
      link = resolve(dirname(link), readlinkSync(link));
    }
  } catch { /* Missing, unreadable and cyclic aliases are not evidence of this install. */ }
}

/** Bun resolves argv[1], Bun.main and import.meta.dir, through both bun <link> and a shebang (native probe, #1245). */
export function stablePackageRoot(root: string, options: { invocation?: string } = {}): string {
  const invocation = options.invocation ?? Bun.which("ahub", { PATH: process.env.PATH });
  if (invocation) {
    const target = lexicalTarget(invocation);
    if (target?.endsWith(`${sep}src${sep}cli${sep}main.js`)) {
      const candidate = dirname(dirname(dirname(target)));
      if (samePath(candidate, root)) return candidate;
    }
  }
  return root;
}

export function stableBunRuntime(options: { runtime?: string; pathRuntime?: string } = {}): string {
  const runtime = options.runtime ?? process.execPath, candidate = options.pathRuntime ?? Bun.which("bun", { PATH: process.env.PATH });
  return candidate && lexicalTarget(candidate) && samePath(candidate, runtime) ? candidate : runtime;
}

/** Advice only; a staged daemon upgrade does not update the person's global CLI installation. */
export function globalCliUpdateStep(version?: string, options: InstallPathOptions = {}): string {
  const root = options.packageRoot ?? packageRoot, env = options.env ?? process.env;
  const global = join(env.BUN_INSTALL || join(options.home ?? homedir(), ".bun"), "install/global/node_modules");
  let bunGlobal = false;
  try {
    const within = relative(realPath(global), realPath(root));
    bunGlobal = within !== "" && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within);
  } catch { /* An unproven Bun prefix must not suggest updating a different CLI. */ }
  if (bunGlobal) return `run \`bun add ${options.globalFlag ?? "-g"} @staix/agent-hub${version ? `@${version}` : ""}\``;
  return `update the global CLI${version ? ` to ${version}` : ""} the way it was installed (running from ${root})`;
}
