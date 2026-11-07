/** O0 contract fixture only. No native host, identity discovery, terminal focus or companion runtime. */
export interface OrcaCompanionFixtureWorkspace {
  id: string;
  kind: "worktree" | "folder";
  name: string;
  path: string;
  branch: string | null;
  hostId: string | null;
}
export type OrcaCompanionFixtureMethod = "workspace.list" | "workspace.readContext" | "workspace.open" | "shell.openExternal";
export type OrcaCompanionFixtureSurface = "worker" | "panel" | "editor";
export interface OrcaCompanionFixtureContext { branch: string; displayName: string; terminals: { id: string; title?: string }[] }
export interface OrcaCompanionFixtureCall {
  method: string;
  params: unknown;
  surface: OrcaCompanionFixtureSurface;
  capabilities: string[];
  desktop: boolean;
  userGesture: boolean;
}
export interface OrcaCompanionFixtureState { agents: string[]; worktrees: string[]; terminals: string[] }
export interface FakeOrcaCompanionHostOptions {
  /** Supplied by each test, never inferred from a documented API version. */
  offeredMethods: readonly OrcaCompanionFixtureMethod[];
  surface: OrcaCompanionFixtureSurface;
  capabilities: readonly string[];
  workspaces: readonly OrcaCompanionFixtureWorkspace[];
  context?: OrcaCompanionFixtureContext | null;
  truncated?: boolean;
  enabled?: boolean;
  desktop?: boolean;
  syntheticState?: OrcaCompanionFixtureState;
}
export type OrcaCompanionFixtureErrorCode = "unknown_method" | "not_permitted" | "capability_denied" | "invalid_params" | "consent_required"
  | "fixture_identity_missing" | "fixture_identity_ambiguous";
export class OrcaCompanionFixtureError extends Error {
  constructor(readonly code: OrcaCompanionFixtureErrorCode) { super(code); this.name = "OrcaCompanionFixtureError"; }
}
interface HostMethods {
  "workspace.list": { workspaces: OrcaCompanionFixtureWorkspace[]; truncated: boolean };
  "workspace.readContext": OrcaCompanionFixtureContext | null;
  "workspace.open": { opened: true };
  "shell.openExternal": { opened: boolean; reason?: "cancelled" | "consent-unavailable" };
}
const METHODS: Record<OrcaCompanionFixtureMethod, { capability?: string; surfaces: readonly OrcaCompanionFixtureSurface[] }> = {
  "workspace.list": { capability: "workspace:read", surfaces: ["worker"] },
  "workspace.readContext": { capability: "workspace:read", surfaces: ["worker", "panel", "editor"] },
  "workspace.open": { capability: "workspace:write", surfaces: ["worker"] },
  "shell.openExternal": { surfaces: ["panel", "editor"] },
};
const fail = (code: OrcaCompanionFixtureErrorCode): never => { throw new OrcaCompanionFixtureError(code); };
function params(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("invalid_params");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.keys(fields).some(key => !keys.includes(key) || !("value" in fields[key]!))) return fail("invalid_params");
  return Object.fromEntries(Object.keys(fields).map(key => [key, fields[key]!.value]));
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export class FakeOrcaCompanionHost {
  readonly calls: OrcaCompanionFixtureCall[] = [];
  readonly openedWorkspaceIds: string[] = [];
  readonly externalNavigation: string[] = [];
  private readonly offered: Set<OrcaCompanionFixtureMethod>;
  private readonly options: FakeOrcaCompanionHostOptions;
  private roster: OrcaCompanionFixtureWorkspace[];
  private context: OrcaCompanionFixtureContext | null;
  private truncated: boolean;
  private enabled: boolean;
  private externalResult: HostMethods["shell.openExternal"] = { opened: true };
  private readonly state: OrcaCompanionFixtureState;
  constructor(options: FakeOrcaCompanionHostOptions) {
    if (!Array.isArray(options.offeredMethods) || options.offeredMethods.some(method => !Object.hasOwn(METHODS, method))) throw new OrcaCompanionFixtureError("invalid_params");
    this.options = structuredClone(options);
    this.offered = new Set(options.offeredMethods);
    this.roster = structuredClone([...options.workspaces]);
    this.context = structuredClone(options.context ?? null);
    this.truncated = options.truncated ?? false; this.enabled = options.enabled ?? true;
    this.state = structuredClone(options.syntheticState ?? { agents: [], worktrees: [], terminals: [] });
  }
  setRoster(workspaces: readonly OrcaCompanionFixtureWorkspace[], truncated = false): void { this.roster = structuredClone([...workspaces]); this.truncated = truncated; }
  setContext(context: OrcaCompanionFixtureContext | null): void { this.context = structuredClone(context); }
  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  setExternalResult(result: HostMethods["shell.openExternal"]): void { this.externalResult = structuredClone(result); }
  /** Synthetic functional state is independent of navigation and plugin enablement. */
  snapshot(): OrcaCompanionFixtureState { return structuredClone(this.state); }
  has(method: string): boolean {
    return this.enabled && Object.hasOwn(METHODS, method) && this.offered.has(method as OrcaCompanionFixtureMethod)
      && METHODS[method as OrcaCompanionFixtureMethod].surfaces.includes(this.options.surface)
      && (method !== "shell.openExternal" || this.options.desktop !== false);
  }
  private workspaces(): OrcaCompanionFixtureWorkspace[] {
    const ids = new Set<string>();
    for (const workspace of this.roster) {
      if (!text(workspace.id) || !text(workspace.path) || typeof workspace.name !== "string" || !["folder", "worktree"].includes(workspace.kind)
        || workspace.branch !== null && typeof workspace.branch !== "string" || workspace.hostId !== null && !text(workspace.hostId)) return fail("fixture_identity_missing");
      if (ids.has(workspace.id)) return fail("fixture_identity_ambiguous"); ids.add(workspace.id);
    }
    return structuredClone(this.roster);
  }
  async call<M extends OrcaCompanionFixtureMethod>(method: M, input?: unknown, invocation?: { userGesture?: boolean }): Promise<HostMethods[M]>;
  async call(method: string, input?: unknown, invocation?: { userGesture?: boolean }): Promise<unknown>;
  async call(method: string, input?: unknown, invocation: { userGesture?: boolean } = {}): Promise<unknown> {
    if (!this.enabled) return fail("consent_required");
    if (!Object.hasOwn(METHODS, method) || !this.offered.has(method as OrcaCompanionFixtureMethod)) return fail("unknown_method");
    const definition = METHODS[method as OrcaCompanionFixtureMethod];
    if (!definition.surfaces.includes(this.options.surface)) return fail("not_permitted");
    if (definition.capability && !this.options.capabilities.includes(definition.capability)) return fail("capability_denied");
    const value = params(input ?? {}, method === "workspace.open" ? ["workspaceId"] : method === "shell.openExternal" ? ["url"] : []);
    this.calls.push({ method, params: structuredClone(value), surface: this.options.surface, capabilities: [...this.options.capabilities], desktop: this.options.desktop ?? true, userGesture: invocation.userGesture === true });
    if (method === "workspace.list") return { workspaces: this.workspaces(), truncated: this.truncated };
    if (method === "workspace.readContext") return structuredClone(this.context);
    if (method === "workspace.open") {
      if (!text(value.workspaceId)) return fail("invalid_params");
      const matches = this.workspaces().filter(workspace => workspace.id === value.workspaceId);
      if (matches.length !== 1) return fail("fixture_identity_missing");
      if (matches[0]!.kind === "folder" && this.options.desktop === false) return fail("not_permitted");
      this.openedWorkspaceIds.push(matches[0]!.id); return { opened: true };
    }
    if (!text(value.url)) return fail("invalid_params");
    if (this.options.desktop === false || invocation.userGesture !== true) return fail("not_permitted");
    try { if (!["http:", "https:", "mailto:"].includes(new URL(value.url).protocol)) return fail("invalid_params"); }
    catch { return fail("invalid_params"); }
    if (this.externalResult.opened) this.externalNavigation.push(value.url);
    return structuredClone(this.externalResult);
  }
}
