import { types } from "node:util";
import { AcpPeer } from "./acp.ts";
import type { AdapterDefinition } from "./registry-types.ts";
import type { PermissionMode } from "../hub/permission-mode.ts";
import { shellQuote } from "../cli/shell-quote.ts";

export interface ConfiguredAcpAdapterConfig {
  transport: "acp";
  command: string;
  args?: readonly string[];
  displayName: string;
  roles: readonly string[];
  identity?: { name: string; version: string };
  permission?: Partial<Record<PermissionMode, string>>;
  readOnly?: string;
}
const fail = (field: string, reason: string): never => { throw new Error(`${field}: ${reason}`); };
/** Core command namespace is reserved; configured kinds cannot shadow operational CLI actions. */
export const CONFIGURED_ACP_RESERVED_COMMANDS = Object.freeze(["help", "version", "completion", "projects", "ui", "manager", "setup", "init", "daemon", "up", "console", "recovery-run", "upgrade", "restart", "recovery", "models", "say", "queue", "watch", "tail", "budget", "backlog", "release", "board", "sdlc", "task", "review", "remember", "ask", "route", "pause", "resume", "stop", "permission", "roster", "settings", "permit", "pet", "status", "logs", "export", "bench", "memory", "goal", "research", "report", "facts", "check-path", "turns", "undo", "kill", "reset", "role", "doctor"]);
const MODES = ["ask", "ask-when-needed", "never-ask"];
const ROLES = ["planner", "implementer", "verifier", "reviewer", "conductor"];
function fields(raw: unknown, at: string): Record<string, PropertyDescriptor> {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Object.getOwnPropertySymbols(raw).length) return fail(at, "must be a plain own-data object");
  const result: Record<string, PropertyDescriptor> = Object.assign(Object.create(null), Object.getOwnPropertyDescriptors(raw));
  if (Object.values(result).some(d => !Object.hasOwn(d, "value") || !d.enumerable)) return fail(at, "enumerable data fields required");
  return result;
}
function text(raw: unknown, at: string, max = 4096): string {
  if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw) > max || /[\p{Cc}\p{Cf}]/u.test(raw)) return fail(at, `must be nonempty control-free text of at most ${max} bytes`);
  return raw;
}
function list(raw: unknown, at: string, max: number): string[] {
  if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype || Object.getOwnPropertySymbols(raw).length) return fail(at, "must be a string array");
  const descriptors: Record<string, PropertyDescriptor> = Object.assign(Object.create(null), Object.getOwnPropertyDescriptors(raw));
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length > max || Object.keys(descriptors).length !== length + 1) return fail(at, "array is sparse or too large");
  return Array.from({ length }, (_, index) => {
    const d = descriptors[String(index)];
    if (!d || !Object.hasOwn(d, "value") || !d.enumerable) return fail(at, "array data fields required");
    return text(d.value, `${at}.${index}`);
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

/** Pure local declaration compiler; file provenance and runtime process ownership remain host checks. */
export function configuredAcpDefinitions(raw: unknown, builtinKinds: readonly string[]): readonly AdapterDefinition[] {
  if (raw === undefined) return Object.freeze([]);
  const declarations = fields(raw, "adapters");
  if (Object.keys(declarations).length > 64) return fail("adapters", "at most 64 configured kinds supported");
  const reserved = new Set([...builtinKinds, ...CONFIGURED_ACP_RESERVED_COMMANDS, "user", "hub", "digest", "constructor", "prototype", "__proto__"]);
  return Object.freeze(Object.entries(declarations).map(([kind, descriptor]) => {
    const at = `adapters.${kind}`;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(kind) || reserved.has(kind)) return fail(at, "kind is invalid, reserved or collides with a builtin");
    const input = fields(descriptor.value, at);
    if (Object.keys(input).some(key => !["transport", "command", "args", "displayName", "roles", "identity", "permission", "readOnly"].includes(key))) return fail(at, "unknown or privileged field");
    if (input.transport?.value !== "acp") return fail(`${at}.transport`, "must be acp");
    const command = text(input.command?.value, `${at}.command`), args = input.args ? list(input.args.value, `${at}.args`, 128) : [];
    // The supported contract is a foreground owned stdio process, never an attachment/proxy selector.
    if ([command, ...args].some(arg => /^--(?:leader|attach|connect|remote)(?:-|=|$)/.test(arg))) return fail(`${at}.args`, "attach/leader selectors are unsupported; command must run foreground owned ACP stdio");
    const displayName = text(input.displayName?.value, `${at}.displayName`, 256), roles = list(input.roles?.value, `${at}.roles`, ROLES.length);
    if (!roles.length || new Set(roles).size !== roles.length || roles.some(role => !ROLES.includes(role))) return fail(`${at}.roles`, "roles must be nonempty, known and unique");
    let identity: ConfiguredAcpAdapterConfig["identity"];
    if (input.identity) {
      const value = fields(input.identity.value, `${at}.identity`);
      if (Object.keys(value).some(key => !["name", "version"].includes(key))) return fail(`${at}.identity`, "unknown identity field");
      identity = { name: text(value.name?.value, `${at}.identity.name`, 256), version: text(value.version?.value, `${at}.identity.version`, 256) };
    }
    let modes: ConfiguredAcpAdapterConfig["permission"];
    if (input.permission) {
      const value = fields(input.permission.value, `${at}.permission`);
      modes = {};
      for (const [mode, d] of Object.entries(value)) {
        if (!MODES.includes(mode)) return fail(`${at}.permission.${mode}`, "unknown hub mode");
        modes[mode as PermissionMode] = text(d.value, `${at}.permission.${mode}`, 256);
      }
    }
    const readOnly = input.readOnly ? text(input.readOnly.value, `${at}.readOnly`, 256) : undefined;
    const nativePolicy = freeze({ ...(modes ? { modes } : {}), ...(readOnly ? { readOnly } : {}) });
    const argv = freeze([command, ...args]);
    identity = identity && freeze(identity);
    const definition: AdapterDefinition = {
      api: 1, kind, family: kind, displayName, transport: "acp", roles, optional: true, defaultOnRoster: false,
      trust: { onPrem: false, hubSandboxed: false }, identity: { mcp: "acp-session" }, instances: { mode: "headless" },
      start: {
        daemonPort: "acp", forms: ["headless"], defaultForm: "headless", conductorStartable: true, hubSwitches: [], ownedFlags: [],
        preflight: request => request.form !== undefined && request.form !== "headless" ? `${kind}: configured ACP supports headless only`
          : !identity ? `${kind}: native identity is unverified; configure the observed name/version pin before starting` : undefined,
        launch: context => {
          if (context.form !== "headless") throw new Error(`${kind}: configured ACP supports headless only`);
          return { cmd: command, args: [...args], metadata: { packageEntrypoint: context.entrypoint, argv: [...argv], command: argv.map(shellQuote).join(" "), env: {} } };
        },
        create: context => {
          if (!("acp" in context.daemon)) throw new Error(`${kind}: ACP transport options required`);
          if (context.permission === "read-only" && !readOnly) throw new Error(`${kind}: read-only native mode is not configured`);
          if (!identity) throw new Error(`${kind}: native identity is unverified; configure the observed name/version pin before starting`);
          return new AcpPeer(context.instance, { ...context.daemon.acp, kind, cmd: [...argv], qwen025: false,
            expectedAgent: identity, requireLoadSessionEcho: true, requireOwnedGroup: true,
            permissionMode: context.permission === "read-only" ? "ask" : context.permission,
            nativePolicy: { ...nativePolicy, lockedReadOnly: context.permission === "read-only" }, mcpServers: context.mcpServers });
        },
        conductorStartArgs: args => args.length ? new Error("configured ACP starts accept no launch overrides") : {},
      },
      permission: { genericAcp: nativePolicy, grants: Object.fromEntries(MODES.map(mode => [mode, modes?.[mode as PermissionMode] ? `${kind}: asks native ACP to select configured ${mode} mode; native tool policy applies; NO hub sandbox` : `${kind}: no configured native mapping for ${mode}; NO hub sandbox`])), ...(!modes || !Object.keys(modes).length ? { unmanaged: `${kind}: native policy unmanaged; no configured permission map; NO hub sandbox` } : {}) },
      // ponytail: configured ACP has no verified controlled-recovery driver. Add catalog-bound restoration
      // with native session/group receipts before enabling controlled recovery; explicit/crash load stays fenced.
      session: { idField: "sessionId", currentId: peer => { const id = peer.recoveryMetadata?.().sessionId; return typeof id === "string" ? id : undefined; }, launchKind: "acp", resumeById: true, recoveryRefusal: () => "configured ACP has no verified controlled-recovery driver; stop it explicitly and restart with its recorded native session id" },
      turnEnd: "adapter", cli: { command: kind, launchConfigKeys: [`adapters.${kind}.command`, `adapters.${kind}.args`], startWords: () => [kind] },
      display: { palette: { fg: "white", bg: "black" } },
    };
    return freeze(definition);
  }));
}
