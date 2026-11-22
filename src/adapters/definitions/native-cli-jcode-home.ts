import { closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { realPath } from "../../hub/project.ts";
import { JCODE_MCP_NAME, jcodeMcpEntry, readJcodeMcpServers } from "./native-cli-jcode-mcp.ts";

/** The person's own jcode data home: `$JCODE_HOME`, else `~/.jcode` (the same default `jcode_home` starts from). */
export function jcodeOwnHome(env: NodeJS.ProcessEnv = process.env, user: string = homedir()): string {
  return env.JCODE_HOME?.trim() || join(user, ".jcode");
}
const canonical = (path: string): string => { try { return realPath(path); } catch { return resolve(path); } };
/** Whether two jcode homes are the same directory, however each is spelled (a link or a system alias resolves). */
export function sameJcodeHome(a: string, b: string): boolean { return canonical(a) === canonical(b); }
/** Where init puts a project's hub-owned jcode home (#1627): machine-local, outside the repository. */
export const hubJcodeHomePath = (hub: string, projectId: string): string => join(hub, "jcode", projectId);

const quoted = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
/** The person's step to log in inside a separate home: complete, with `JCODE_HOME` set. */
export const jcodeLoginCommand = (target: string): string => `JCODE_HOME=${quoted(target)} jcode login`;

export interface JcodeHomePlan {
  home: string;
  own: string;
  /** The home is already there: nothing is written, only `drift` is reported. */
  exists: boolean;
  /** What a new home's mcp.json holds: the hub's own entry plus the allowed servers found in the person's mcp.json. */
  servers: Record<string, unknown>;
  /** Allowed names the person's own mcp.json does not define, so there is nothing to copy. */
  absentAllowed: string[];
  /** For an existing home: what is missing, each with its fix. */
  drift: string[];
}

/**
 * Plan the hub-owned jcode home (#1627). Reads the person's own `mcp.json` (the allowed entries only) and never writes it.
 * Auth is never copied or linked: a second home needs its own login (docs/verification/2026-11-22-jcode-separate-home.md), so the plan names that person step.
 * ponytail: an allowed entry is copied whole, so an environment value in it goes with it into a 0600 file in the hub-owned home. Upgrade path: copy by reference once jcode can read an include.
 */
export function planJcodeHome(input: { home: string; own: string; cwd: string; stateDir: string; bundle: string; allow: readonly string[] }): JcodeHomePlan {
  const { home, own, cwd, stateDir, bundle, allow } = input;
  const ownServers = readJcodeMcpServers(own).servers;
  const copied = Object.fromEntries(allow.filter(name => name !== JCODE_MCP_NAME && name in ownServers).map(name => [name, structuredClone(ownServers[name])]));
  const servers: Record<string, unknown> = { [JCODE_MCP_NAME]: jcodeMcpEntry(cwd, stateDir, bundle), ...copied };
  const absentAllowed = allow.filter(name => name !== JCODE_MCP_NAME && !(name in copied));
  const exists = lstatSync(home, { throwIfNoEntry: false }) !== undefined;
  const drift: string[] = [];
  if (exists) {
    const held = readJcodeMcpServers(home);
    const file = join(home, "mcp.json");
    if (held.unreadable) drift.push(`${file} is unreadable or unsafe; fix it in your editor`);
    else if (!held.present) drift.push(`${file} is missing; fix: add the hub entry with cd ${quoted(cwd)} && ahub jcode, and the allowed servers from ${join(own, "mcp.json")}`);
    else {
      const missing = Object.keys(servers).filter(name => !(name in held.servers));
      if (missing.length) drift.push(`${file} lacks ${missing.join(", ")}; fix: add ${missing.length === 1 ? "it" : "them"} from ${join(own, "mcp.json")}${missing.includes(JCODE_MCP_NAME) ? ` (the hub entry: cd ${quoted(cwd)} && ahub jcode)` : ""}`);
    }
    if (!lstatSync(join(home, "auth.json"), { throwIfNoEntry: false })) drift.push(`no jcode login in ${home}; person step: ${jcodeLoginCommand(home)}`);
  }
  return { home, own, exists, servers, absentAllowed, drift };
}

/** Create a new hub-owned home with only its mcp.json (0700 directory, 0600 file). An existing home is never written. */
export function applyJcodeHome(plan: JcodeHomePlan): void {
  if (plan.exists) return;
  mkdirSync(plan.home, { recursive: true, mode: 0o700 });
  const file = join(plan.home, "mcp.json"), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify({ servers: plan.servers }, null, 2)}\n`); } finally { closeSync(fd); }
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
