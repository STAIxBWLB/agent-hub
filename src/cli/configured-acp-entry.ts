import type { ProjectAdapterCatalog } from "../adapters/registry.ts";
import { externalInstanceCatalog, type ExternalInstanceCatalog } from "../adapters/external-metadata.ts";
import type { DeclaredExternalInstance } from "../hub/instance-config.ts";
import type { InstancesConfig } from "../hub/instances.ts";
import { requireActiveInstance, requirePeerInstances } from "./launch.ts";
import { configuredAcpPreview } from "./preview.ts";

export interface ConfiguredAcpSelection { peer: string; mode: "headless"; sessionId?: string; preview: boolean }
export function parseConfiguredAcpArguments(kind: string, raw: readonly string[], catalog: ProjectAdapterCatalog, instances?: InstancesConfig, declaredExternalInstances: readonly DeclaredExternalInstance[] = []): ConfiguredAcpSelection {
  const definition = catalog.definitionOf(kind);
  if (!definition?.permission.genericAcp && !declaredExternalInstances.some(row => row.kind === kind)) throw new Error("unknown configured ACP kind");
  const values = new Map<string, string>();
  let preview = false;
  for (let index = 0; index < raw.length; index++) {
    const arg = raw[index]!;
    if (arg === "--print-command" || arg === "--dry-run") { if (preview) throw new Error("preview option may appear only once"); preview = true; continue; }
    const equal = arg.indexOf("="), flag = equal < 0 ? arg : arg.slice(0, equal);
    if (!["--as", "--mode", "--session-id"].includes(flag) || values.has(flag)) throw new Error("configured ACP accepts only --mode headless, --as, --session-id and one preview option");
    const value = equal < 0 ? raw[++index] : arg.slice(equal + 1);
    if (!value || value.startsWith("--") || Buffer.byteLength(value) > 4096 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error(`${flag} needs a bounded control-free value`);
    values.set(flag, value);
  }
  if (values.has("--mode") && values.get("--mode") !== "headless") throw new Error("configured ACP supports headless only");
  const peer = values.get("--as") ?? kind;
  const executable = !!instances && Object.hasOwn(instances, peer) && instances[peer]?.kind === kind && !!catalog.definitionOf(peer, instances);
  const declaredOnly = declaredExternalInstances.some(row => row.id === peer && row.kind === kind && row.availability === "declared-unknown" && row.refusalCode === "catalog-unavailable");
  // Inert declarations select a preview or request id only; live daemon admission remains mandatory.
  if (values.has("--as") && !executable && !declaredOnly) throw new Error("--as must name a declared instance of this configured kind");
  return { peer, mode: "headless", ...(values.has("--session-id") ? { sessionId: values.get("--session-id")! } : {}), preview };
}
export interface ConfiguredAcpControl {
  features: readonly string[];
  readonly instanceId?: string;
  readonly isOpen?: boolean;
  readExternalInstanceCatalog?(projectRoot: string): Promise<ExternalInstanceCatalog>;
  request(message: Record<string, unknown>, timeout?: number): Promise<any>;
  close(): void;
}
export async function requireActiveConfiguredAcp(hub: ConfiguredAcpControl, kind: string, peer: string, warn?: (text: string) => void, external?: { projectRoot: string }): Promise<void> {
  if (!hub.features.includes("configured_acp")) throw new Error("running hub lacks configured_acp; upgrade and restart it first");
  if (peer !== kind) requirePeerInstances(hub.features);
  const epoch = hub.instanceId;
  if (external && (!epoch || hub.isOpen !== true || !hub.readExternalInstanceCatalog || !["external_adapter_instances", "external_adapter_modules", "peer_instances"].every(feature => hub.features.includes(feature)))) throw new Error("running hub lacks a live external instance catalog");
  const reply = await hub.request({ t: "status" });
  const active = reply.status?.configuredAdapters;
  if (!Array.isArray(active) || !active.includes(kind)) throw new Error(`running hub has not loaded ${kind}; restart it after declaring the adapter`);
  if (peer !== kind) requireActiveInstance(reply.status, peer);
  if (external) {
    const observed = externalInstanceCatalog(await hub.readExternalInstanceCatalog!(external.projectRoot));
    const row = observed.instances.find(row => row.id === peer);
    if (hub.isOpen !== true || hub.instanceId !== epoch || reply.status?.instanceId !== epoch || reply.status?.cwd !== external.projectRoot
      || observed.epoch !== epoch || observed.projectRoot !== external.projectRoot || !row || row.kind !== kind || !["ready", "offline"].includes(row.availability)) throw new Error("external instance is not bound to the current live catalog");
  }
  const namespace = `adapters.${kind}`;
  const retained = [reply.status?.retainedConfig, reply.status?.pendingRestart].some(rows => Array.isArray(rows) && rows.some(row => {
    const key = row && typeof row === "object" ? row.key : undefined;
    return typeof key === "string" && (key === "adapters" || key === namespace || key.startsWith(`${namespace}.`));
  }));
  if (retained) warn?.(`${kind}: configured adapter changes are retained; this start uses the running definition. Restart the hub to apply the file's definition.`);
}
export async function runConfiguredAcpEntry(context: {
  kind: string; raw: readonly string[]; catalog: ProjectAdapterCatalog; instances?: InstancesConfig;
  declaredExternalInstances?: readonly DeclaredExternalInstance[]; projectRoot?: string;
  connect(): Promise<ConfiguredAcpControl>; print(text: string): void; operationId?: string;
}): Promise<void> {
  const selected = parseConfiguredAcpArguments(context.kind, context.raw, context.catalog, context.instances, context.declaredExternalInstances);
  if (selected.preview) { context.print(JSON.stringify(configuredAcpPreview(context.kind, selected.peer, selected.sessionId !== undefined), null, 2)); return; }
  const hub = await context.connect();
  try {
    const external = selected.peer !== context.kind && (context.declaredExternalInstances?.some(row => row.id === selected.peer && row.kind === context.kind)
      || context.catalog.externalDefinitions.some(definition => definition.kind === context.kind));
    if (external && !context.projectRoot) throw new Error("external instance start requires the canonical project root");
    await requireActiveConfiguredAcp(hub, context.kind, selected.peer, context.print, external ? { projectRoot: context.projectRoot! } : undefined);
    const reply = await hub.request({ t: "start", peer: selected.peer, args: { mode: "headless", ...(selected.sessionId ? { sessionId: selected.sessionId } : {}) }, ...(context.operationId ? { operationId: context.operationId } : {}) }, 70_000);
    if (!reply.ok) throw new Error(typeof reply.error === "string" ? reply.error : "configured ACP start refused");
    context.print(reply.already ? `${selected.peer} is already attached` : `${selected.peer} attached (headless); use ahub say @${selected.peer} and the console for approvals`);
  } finally { hub.close(); }
}
