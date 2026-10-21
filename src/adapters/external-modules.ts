import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isBuiltin } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { moduleDataObject as dataObject, moduleText as text, moduleArray as array } from "./external-metadata.ts";
import { ADAPTER_API } from "./adapter-api.ts";
import { CONFIGURED_ACP_RESERVED_COMMANDS } from "./configured-acp.ts";
import { ADAPTERS, assertDefinitionCoherence, assertNativeCapabilityScope, createProjectAdapterCatalog } from "./registry.ts";
import type { AdapterDefinition, LaunchPlan } from "./registry-types.ts";
import { configRefusal } from "../hub/config-trust.ts";
import { realPath } from "../hub/project.ts";
import { scanModuleSource } from "./external-module-scan.ts";

export interface AdapterModuleDeclaration { readonly path: string; readonly sha256: string }
interface ModuleConfigLayer { name: string; raw: Record<string, unknown> }
const MAX_MODULES = 16, MAX_MODULE_BYTES = 2 * 1024 * 1024;
const ADAPTER_IMPORT = "@staix/agent-hub/adapter";
class ExternalAdapterRefusal extends Error {}
const fail = (reason: string): never => { throw new ExternalAdapterRefusal(`external adapter: ${reason}`); };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function adapterModuleDeclarations(raw: unknown): readonly AdapterModuleDeclaration[] {
  if (raw === undefined) return Object.freeze([]);
  return Object.freeze(array(raw, MAX_MODULES).map(value => {
    const row = dataObject(value);
    if (Object.keys(row).some(key => !["path", "sha256"].includes(key))) return fail("unknown module declaration field");
    const path = text(row.path, 4096), hash = row.sha256;
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) return fail("a SHA-256 content pin is required");
    return Object.freeze({ path, sha256: hash.toLowerCase() });
  }));
}

/** This reads declarations only. It never imports code, including for reloads and CLI reads. */
export function readAdapterModuleDeclarations(cwd: string, layers: readonly ModuleConfigLayer[]) {
  const ignored: string[] = [];
  let modules: readonly AdapterModuleDeclaration[] = Object.freeze([]);
  for (const { name, raw } of layers) {
    if (raw.adapter_modules === undefined) continue;
    const refusal = name !== "config.local.json" ? "modules are machine-local config.local.json values" : configRefusal(cwd, name);
    if (refusal) { ignored.push(`adapter_modules in .agenthub/${name} ignored: ${refusal}`); continue; }
    modules = adapterModuleDeclarations(raw.adapter_modules);
  }
  return { modules, ignored };
}

const inside = (root: string, file: string) => { const part = relative(root, file); return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
function regularPath(root: string, file: string) {
  if (!inside(root, file)) return fail("module must be inside the project root");
  let at = root;
  const parts = relative(root, file).split(sep);
  for (let index = 0; index < parts.length; index++) {
    at = join(at, parts[index]!);
    const stat = lstatSync(at);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return fail("symlinked or nonregular module path refused");
  }
  return lstatSync(file);
}
function captureBundle(cwd: string, declaration: AdapterModuleDeclaration): Buffer {
  const root = realPath(cwd), file = resolve(root, declaration.path);
  const observed = regularPath(root, file);
  if ((observed.mode & 0o002) !== 0) return fail("world-writable module refused");
  if (observed.size > MAX_MODULE_BYTES) return fail("module exceeds the size bound");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== observed.dev || before.ino !== observed.ino || (before.mode & 0o002) !== 0) return fail("module changed before capture");
    const buffer = Buffer.alloc(MAX_MODULE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, length); if (!n) break; length += n; }
    if (length > MAX_MODULE_BYTES) return fail("module exceeds the size bound");
    const after = fstatSync(fd), current = regularPath(root, file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino || !inside(root, realPath(file))) return fail("module changed during capture");
    const bytes = buffer.subarray(0, length);
    if (digest(bytes) !== declaration.sha256) return fail("content hash mismatch");
    return bytes;
  } finally { closeSync(fd); }
}

/** Conservative code-loading rejection, not an isolation boundary for approved daemon-privileged code. */
export function assertModuleBundle(source: string): void {
  for (const dependency of scanModuleSource(source)) {
    const allowed = dependency.path === ADAPTER_IMPORT || dependency.path !== "bun:test" && dependency.path !== "bun:ffi"
      && /^(?:node|bun):/.test(dependency.path) && (isBuiltin(dependency.path) || dependency.path === "bun:sqlite");
    if (dependency.kind !== "import-statement" || !allowed) return fail("only static builtin and public adapter imports are supported");
  }
}

/** Resolve scanned SDK imports against this running package, never project node_modules or process.cwd(). */
async function executableBundle(source: string): Promise<Uint8Array> {
  const imports = scanModuleSource(source);
  const compiled = await Bun.build({ entrypoints: ["a4-pin:entry"], target: "bun", format: "esm",
    plugins: [{ name: "host-bound-adapter-imports", setup(build) {
      build.onResolve({ filter: /^a4-pin:/ }, () => ({ path: "entry", namespace: "a4-pin" }));
      build.onLoad({ filter: /.*/, namespace: "a4-pin" }, () => ({ contents: source, loader: "js" }));
      build.onResolve({ filter: /.*/ }, args => {
        if (!imports.some(item => item.path === args.path && item.kind === "import-statement")) return fail("unscanned import refused");
        return { path: args.path === ADAPTER_IMPORT ? new URL("./public.ts", import.meta.url).href : args.path, external: true };
      });
    } }],
  });
  if (!compiled.success || compiled.outputs.length !== 1) return fail("bundle compilation refused (details withheld)");
  return new Uint8Array(await compiled.outputs[0]!.arrayBuffer());
}

function snapshot(value: unknown, depth = 0): unknown {
  if (depth > 12) return fail("definition nesting exceeds its bound");
  if (typeof value === "function" || value === null || ["undefined", "string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return Object.freeze(array(value, 128).map(item => snapshot(item, depth + 1)));
  return Object.freeze(Object.fromEntries(Object.entries(dataObject(value)).map(([key, member]) => [key, snapshot(member, depth + 1)])));
}
function only(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const fields = dataObject(value);
  if (Object.keys(fields).some(key => !keys.includes(key))) return fail("field is outside the supported external definition subset");
  return fields;
}
export function validateExternalDefinition(raw: unknown): AdapterDefinition {
  const definition = snapshot(raw) as AdapterDefinition;
  if (definition.api !== ADAPTER_API) return fail("adapter API mismatch");
  const reserved = [...ADAPTERS.map(item => item.kind), ...CONFIGURED_ACP_RESERVED_COMMANDS, "user", "hub", "digest", "constructor", "prototype", "__proto__"];
  if (typeof definition.kind !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(definition.kind) || reserved.includes(definition.kind)
    || ADAPTERS.some(builtin => definition.kind.startsWith(`${builtin.kind}-`))) return fail("kind is reserved, invalid or collides with a builtin");
  text(definition.displayName, 256);
  if (definition.family !== definition.kind || definition.trust?.onPrem !== false || definition.trust.hubSandboxed !== false
    || definition.defaultOnRoster !== false || definition.optional !== true) return fail("external kinds must retain their own family and optional off-roster cloud trust");
  if (!Array.isArray(definition.roles) || !definition.roles.length || definition.roles.some(role => !["planner", "implementer", "verifier", "reviewer"].includes(role)) || new Set(definition.roles).size !== definition.roles.length) return fail("unsupported default roles");
  if (definition.instances !== undefined) return fail("external adapter instances are unsupported in A4");
  try { assertNativeCapabilityScope(definition); } catch { return fail("fixed-builtin capability refused"); }
  only(definition, ["api", "kind", "family", "displayName", "transport", "roles", "optional", "defaultOnRoster", "trust", "start", "identity", "permission", "session", "turnEnd", "cli", "display"]);
  only(definition.trust, ["onPrem", "hubSandboxed"]);
  const start = only(definition.start, ["forms", "defaultForm", "daemonPort", "launch", "create", "preflight", "version", "conductorStartable", "hubSwitches", "ownedFlags", "exclusiveStartRefusal"]);
  if (definition.transport !== "acp" || definition.turnEnd !== "adapter" || definition.start.daemonPort !== "acp"
    || array(definition.start.forms, 1).length !== 1 || definition.start.forms[0] !== "headless" || definition.start.defaultForm !== "headless"
    || typeof definition.start.conductorStartable !== "boolean" || typeof definition.start.create !== "function" || typeof definition.start.launch !== "function") return fail("A4 requires a headless ACP transport factory and launch plan");
  for (const field of ["preflight", "version"] as const) if (start[field] !== undefined && typeof start[field] !== "function") return fail("invalid start callback");
  if (array(start.hubSwitches, 0).length || array(start.ownedFlags, 0).length) return fail("external launch switches are unsupported");
  if (start.exclusiveStartRefusal !== undefined) text(start.exclusiveStartRefusal, 2048);
  if (only(definition.identity, ["mcp"]).mcp !== "acp-session") return fail("external ACP identity must be session-bound");
  const permission = only(definition.permission, ["genericAcp", "grants", "unmanaged"]);
  if (permission.genericAcp !== undefined) {
    const policy = only(permission.genericAcp, ["modes", "readOnly"]);
    if (policy.modes !== undefined) for (const value of Object.values(only(policy.modes, ["ask", "ask-when-needed", "never-ask"]))) text(value, 256);
    if (policy.readOnly !== undefined) text(policy.readOnly, 256);
  }
  if (permission.grants !== undefined) for (const value of Object.values(only(permission.grants, ["ask", "ask-when-needed", "never-ask"]))) text(value, 2048);
  if (permission.unmanaged !== undefined) text(permission.unmanaged, 2048);
  const session = only(definition.session, ["idField", "currentId", "resumeById", "launchKind"]);
  if (session.idField !== "sessionId" || typeof session.currentId !== "function" || session.resumeById !== undefined && typeof session.resumeById !== "boolean") return fail("invalid external session contract");
  if (session.launchKind !== undefined && session.launchKind !== definition.kind) return fail("external launch kind must match its own kind");
  const cli = only(definition.cli, ["command", "startWords"]);
  if (cli.command !== definition.kind || typeof cli.startWords !== "function") return fail("external command must match its own kind");
  let words: unknown;
  try { words = definition.cli.startWords("headless"); } catch { return fail("command metadata refused (details withheld)"); }
  const commandWords = array(words, 1).map(word => text(word, 64));
  if (commandWords.length !== 1 || commandWords[0] !== definition.kind) return fail("headless command words must name only their bound kind");
  const palette = only(only(definition.display, ["palette"]).palette, ["fg", "bg"]);
  for (const color of [palette.fg, palette.bg]) if (typeof color !== "string" || !/^(?:[a-z]{1,32}|#[a-f0-9]{3,8})$/i.test(color)) return fail("invalid external display color");
  try { assertDefinitionCoherence(definition); } catch { return fail("definition contracts are incoherent"); }
  const invoke = <T>(name: string, callback: () => T): T => {
    try { return callback(); } catch { return fail(`${name} refused (details withheld)`); }
  };
  return snapshot({ ...definition,
    start: { ...definition.start,
      create: (context: Parameters<NonNullable<AdapterDefinition["start"]["create"]>>[0]) => invoke("factory", () => definition.start.create!(context)),
      launch: (context: Parameters<NonNullable<AdapterDefinition["start"]["launch"]>>[0]): LaunchPlan => invoke("launch", () => {
        const plan = only(definition.start.launch!(context), ["cmd", "args", "metadata"]);
        const cmd = text(plan.cmd, 4096), args = array(plan.args, 128).map(arg => text(arg, 4096));
        const metadata = only(plan.metadata, ["packageEntrypoint", "command", "argv", "env"]);
        text(metadata.packageEntrypoint, 4096); text(metadata.command, 16384);
        array(metadata.argv, 129).forEach(arg => text(arg, 4096));
        if (Object.keys(dataObject(metadata.env)).length) return fail("external native-home overrides are unsupported");
        return snapshot({ cmd, args, metadata }) as LaunchPlan;
      }),
      ...(definition.start.preflight ? { preflight: (context: Parameters<NonNullable<AdapterDefinition["start"]["preflight"]>>[0]) => {
        try { if (definition.start.preflight!(context) === undefined) return undefined; } catch { /* Never forward module-authored exception/refusal bodies. */ }
        return "external adapter preflight refused (details withheld)";
      } } : {}),
      ...(definition.start.version ? { version: (context: Parameters<NonNullable<AdapterDefinition["start"]["version"]>>[0]) => {
        try { if (definition.start.version!(context) === undefined) return undefined; } catch { /* Unknown is a refusal for an external native version check. */ }
        return "external adapter version refused (details withheld)";
      } } : {}),
    },
    session: { ...definition.session,
      // ponytail: A4 has no verified controlled-recovery driver; bind native session/group restoration receipts before enabling it.
      recoveryRefusal: () => "external module has no verified controlled-recovery driver; stop it explicitly and restart with its recorded native session id",
      currentId: (peer: Parameters<AdapterDefinition["session"]["currentId"]>[0]) => {
      try {
        const value = definition.session.currentId(peer);
        return typeof value === "string" && value.trim() && Buffer.byteLength(value) <= 4096 && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : undefined;
      } catch { return undefined; }
    } },
    // UI polls and CLI metadata never execute plugin code to render a headless command.
    cli: { command: definition.kind, startWords: () => [definition.kind] },
  }) as AdapterDefinition;
}

const MODULE_IMPORT_TIMEOUT_MS = 2000;
async function importVerifiedModule(executable: Uint8Array): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // ponytail: a deadline stops waiting, not privileged module side effects; cancellation needs an isolated host-port engine.
    return await Promise.race([
      import(`data:text/javascript;nonce=${randomUUID()};base64,${Buffer.from(executable).toString("base64")}`),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ExternalAdapterRefusal("external adapter: module import timed out")), MODULE_IMPORT_TIMEOUT_MS); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Only daemon startup calls this. Hash-checked bytes, not the mutable source path, reach import(). */
export interface ExternalAdapterRefusalRecord { readonly index: number; readonly reason: string }
export async function loadExternalAdapterDefinitions(cwd: string, layers: readonly ModuleConfigLayer[], onRefusal?: (refusal: ExternalAdapterRefusalRecord) => void): Promise<readonly AdapterDefinition[]> {
  const { modules } = readAdapterModuleDeclarations(cwd, layers);
  if (!modules.length) return Object.freeze([]);
  let rawAdapters: unknown;
  for (const { name, raw } of layers) if (name === "config.local.json" && !configRefusal(cwd, name) && raw.adapters !== undefined) rawAdapters = raw.adapters;
  const existingKinds = new Set(createProjectAdapterCatalog(rawAdapters).definitions.map(definition => definition.kind));
  const definitions: AdapterDefinition[] = [];
  for (const [index, declaration] of modules.entries()) {
    try {
      if (configRefusal(cwd, "config.local.json")) return fail("module configuration provenance changed");
      const local = regularPath(realPath(cwd), join(realPath(cwd), ".agenthub", "config.local.json"));
      if ((local.mode & 0o002) !== 0) return fail("world-writable module configuration refused");
      const bytes = captureBundle(cwd, declaration);
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      assertModuleBundle(source);
      const executable = await executableBundle(source);
      if (digest(bytes) !== declaration.sha256 || configRefusal(cwd, "config.local.json")) return fail("module pin or provenance changed before import");
      const imported = await importVerifiedModule(executable);
      const definition = validateExternalDefinition((imported as { definition?: unknown }).definition);
      if ([...existingKinds].some(kind => definition.kind === kind || definition.kind.startsWith(`${kind}-`))) return fail("kind collides with a configured adapter namespace");
      if (definitions.some(item => item.kind === definition.kind)) return fail("duplicate external kind");
      definitions.push(definition);
    } catch (error) {
      const refusal = error instanceof ExternalAdapterRefusal ? error : new ExternalAdapterRefusal("external adapter: module could not be verified or loaded (details withheld)");
      if (!onRefusal) throw refusal;
      onRefusal(Object.freeze({ index, reason: refusal.message }));
    }
  }
  return Object.freeze(definitions);
}

