import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryStore, realPath, memoryGitSync, type NoteInput } from "@staix/agent-mem";

const ROOT = resolve(import.meta.dir, "..");
const FIXTURE = join(ROOT, "test/fixtures/memory-consumer");
const LEGACY_VERSION = "0.12.29";
const PROJECT = "github.com/example/amem-parity";
const REMOTE = "https://github.com/example/amem-parity.git";
const NOW = Date.parse("2026-10-16T00:00:00.000Z");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const requireEqual = (a: unknown, b: unknown, label: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`memory consumer parity failed: ${label}`);
};

/** Read-only inventory. Authored rows/machine identity are separate from disposable index/WAL files. */
export function fixtureDigests(dir = FIXTURE, authoredOnly = false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (parent: string, prefix: string) => {
    for (const entry of readdirSync(parent, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(parent, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, relative);
      else if (!authoredOnly || relative === "machine.json" || /^(log|local)\/[^/]+[.]jsonl$/.test(relative)) out[relative] = sha(readFileSync(path));
    }
  };
  walk(dir, ""); return out;
}

export type LegacyInstallation = { available: true; bin: string; root: string; version: string } | { available: false; reason: string };
/** Resolve the installed package, never a checkout inferred from a machine-specific path. No download or process. */
export function legacyInstallation(): LegacyInstallation {
  const command = Bun.which("ahub");
  if (!command) return { available: false, reason: "installed ahub is unavailable" };
  let bin: string;
  try { bin = realPath(command); } catch { return { available: false, reason: "installed ahub cannot be resolved" }; }
  for (let dir = dirname(bin); ; dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@staix/agent-hub") {
        if (pkg.version !== LEGACY_VERSION) return { available: false, reason: `installed ahub version is ${pkg.version ?? "unknown"}, requires ${LEGACY_VERSION}` };
        if (!existsSync(join(dir, "src/memory", "store.ts"))) return { available: false, reason: "installed legacy memory implementation is unavailable" };
        return { available: true, bin, root: dir, version: pkg.version };
      }
    } catch { /* not this ancestor */ }
    if (dirname(dir) === dir) break;
  }
  return { available: false, reason: "ahub command is not a resolvable installed agent-hub package" };
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AMEM_HOME"].includes(key)) delete env[key];
  env.AGENTHUB_HOME = home; return env;
}

function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const child = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  if (child.exitCode !== 0) throw new Error(`memory consumer parity command failed (exit ${child.exitCode}): ${child.stderr.toString().trim()}`);
  return child.stdout.toString();
}

function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-memory-consumer-")), cwd = join(dir, "project");
  mkdirSync(join(cwd, ".agenthub"), { recursive: true }); writeFileSync(join(cwd, ".agenthub/config.json"), "{}\n");
  for (const args of [["init", "-q", cwd], ["-C", cwd, "remote", "add", "origin", REMOTE]]) {
    const git = memoryGitSync(args, { encoding: "utf8" });
    if (git.status !== 0) throw new Error("synthetic parity git setup failed");
  }
  const copy = (name: string) => { const home = join(dir, name); cpSync(join(FIXTURE, "memory"), join(home, "memory"), { recursive: true }); return home; };
  return { dir, cwd, copy };
}

function commands(id: string): Record<string, string[]> {
  return { list: ["list", "--json"], show: ["show", id, "--json"], graph: ["graph", id, "--json"] };
}
function sourceReads(home: string, cwd: string, id: string) {
  return Object.fromEntries(Object.entries(commands(id)).map(([name, args]) => [name, run([process.execPath, join(ROOT, "src/cli/main.js"), "memory", ...args], cwd, isolatedEnv(home))]));
}
function legacyReads(legacy: Extract<LegacyInstallation, { available: true }>, home: string, cwd: string, id: string) {
  return Object.fromEntries(Object.entries(commands(id)).map(([name, args]) => [name, run([process.execPath, legacy.bin, "memory", ...args], cwd, isolatedEnv(home))]));
}
const resultDigests = (output: Record<string, string>) => Object.fromEntries(Object.entries(output).map(([name, value]) => [name, sha(value)]));

/** CI-safe frozen 0.12.29 CLI receipt; no installed legacy binary or account is required. */
export function checkFrozenConsumerParity() {
  const before = fixtureDigests(), temp = temporary();
  try {
    const receipt = JSON.parse(readFileSync(join(FIXTURE, "receipt.json"), "utf8")) as { version: string; commands: { show: string[] } };
    requireEqual(receipt.version, LEGACY_VERSION, "frozen legacy version");
    const id = receipt.commands.show[1]!;
    const home = temp.copy("frozen"), authored = fixtureDigests(join(home, "memory"), true);
    const output = sourceReads(home, temp.cwd, id);
    for (const [name, text] of Object.entries(output)) requireEqual(text, readFileSync(join(FIXTURE, `${name}.json`), "utf8"), `frozen ${name} bytes`);
    requireEqual(fixtureDigests(join(home, "memory"), true), authored, "frozen read phase authored files unchanged");
    requireEqual(fixtureDigests(), before, "source fixture unchanged");
    return { legacyVersion: receipt.version, cliReadParity: resultDigests(output), authoredFilesUnchanged: true, sourceFixtureUnchanged: true, derivedIndexWritesAllowed: true };
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
}

/** Local-only compatibility gate: library writes followed by actual old/new CLI reads on copied synthetic homes. */
export async function checkInstalledConsumerParity() {
  const legacy = legacyInstallation();
  if (!legacy.available) throw new Error(`memory consumer parity unavailable: ${legacy.reason}`);
  const before = fixtureDigests(), temp = temporary();
  try {
    const actualVersion = run([process.execPath, legacy.bin, "--version"], temp.cwd, isolatedEnv(temp.copy("version"))).trim();
    requireEqual(actualVersion, LEGACY_VERSION, "installed CLI version");
    const oldModule = await import(pathToFileURL(join(legacy.root, "src/memory", "store.ts")).href) as { MemoryStore: typeof MemoryStore };
    const directions: { writer: string; reader: string; id: string; cliReadParity: Record<string, string>; authoredFilesUnchanged: boolean }[] = [];
    for (const oldWrites of [false, true]) {
      const home = temp.copy(oldWrites ? "old-writes" : "new-writes");
      const Store = oldWrites ? oldModule.MemoryStore : MemoryStore;
      const store = new Store({ home, now: () => NOW });
      const note: NoteInput = { op: "note", project: PROJECT, scope: "project", tier: "long", kind: oldWrites ? "contract" : "fail", peer: "codex", title: "Synthetic consumer parity", text: oldWrites ? "The old library wrote this fixture note." : "The package wrote this fixture note.", about: ["path:src/example.ts"], source: "person" };
      let id: string;
      try { id = store.note(note); } finally { store.close(); }
      const authored = fixtureDigests(join(home, "memory"), true);
      const oldOutput = legacyReads(legacy, home, temp.cwd, id), newOutput = sourceReads(home, temp.cwd, id);
      requireEqual(newOutput, oldOutput, "installed/source list, show, graph bytes");
      const list = JSON.parse(newOutput.list!) as { id: string }[];
      if (!list.some(row => row.id === id)) throw new Error("reciprocal fixture write was not visible in CLI list");
      requireEqual((JSON.parse(newOutput.show!) as { id: string }).id, id, "reciprocal show id");
      const graph = JSON.parse(newOutput.graph!) as { nodes: { id: string }[] };
      if (!graph.nodes.some(node => node.id === `mem:${id}`)) throw new Error("reciprocal fixture write was not visible in graph");
      requireEqual(fixtureDigests(join(home, "memory"), true), authored, "reciprocal read phase authored files unchanged");
      directions.push({ writer: oldWrites ? "installed legacy MemoryStore" : "@staix/agent-mem MemoryStore", reader: oldWrites ? "new source CLI" : "installed legacy CLI", id, cliReadParity: resultDigests(newOutput), authoredFilesUnchanged: true });
    }
    requireEqual(fixtureDigests(), before, "source fixture unchanged");
    return { legacyVersion: actualVersion, fixture: "synthetic copied homes", writeSurface: "MemoryStore.note (there is no offline CLI note command)", readSurface: "installed ahub and new bun src/cli/main.js memory list/show/graph --json", directions, sourceFixtureUnchanged: true, derivedIndexWritesAllowed: true };
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify({ frozen: checkFrozenConsumerParity(), installed: await checkInstalledConsumerParity() }, null, 2)); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
