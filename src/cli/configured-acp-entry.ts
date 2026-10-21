import type { ProjectAdapterCatalog } from "../adapters/registry.ts";
import type { InstancesConfig } from "../hub/instances.ts";
import { requireActiveInstance, requirePeerInstances } from "./launch.ts";
import { configuredAcpPreview } from "./preview.ts";

export interface ConfiguredAcpSelection { peer: string; mode: "headless"; sessionId?: string; preview: boolean }
export function parseConfiguredAcpArguments(kind: string, raw: readonly string[], catalog: ProjectAdapterCatalog, instances?: InstancesConfig): ConfiguredAcpSelection {
  const definition = catalog.definitionOf(kind);
  if (!definition?.permission.genericAcp) throw new Error("unknown configured ACP kind");
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
  if (values.has("--as") && (!instances || !Object.hasOwn(instances, peer) || instances[peer]?.kind !== kind || !catalog.definitionOf(peer, instances))) throw new Error("--as must name a declared instance of this configured kind");
  return { peer, mode: "headless", ...(values.has("--session-id") ? { sessionId: values.get("--session-id")! } : {}), preview };
}
export interface ConfiguredAcpControl {
  features: readonly string[];
  request(message: Record<string, unknown>, timeout?: number): Promise<any>;
  close(): void;
}
export async function requireActiveConfiguredAcp(hub: ConfiguredAcpControl, kind: string, peer: string): Promise<void> {
  if (!hub.features.includes("configured_acp")) throw new Error("running hub lacks configured_acp; upgrade and restart it first");
  if (peer !== kind) requirePeerInstances(hub.features);
  const reply = await hub.request({ t: "status" });
  const active = reply.status?.configuredAdapters;
  if (!Array.isArray(active) || !active.includes(kind)) throw new Error(`running hub has not loaded ${kind}; restart it after declaring the adapter`);
  if (peer !== kind) requireActiveInstance(reply.status, peer);
}
export async function runConfiguredAcpEntry(context: {
  kind: string; raw: readonly string[]; catalog: ProjectAdapterCatalog; instances?: InstancesConfig;
  connect(): Promise<ConfiguredAcpControl>; print(text: string): void; operationId?: string;
}): Promise<void> {
  const selected = parseConfiguredAcpArguments(context.kind, context.raw, context.catalog, context.instances);
  if (selected.preview) { context.print(JSON.stringify(configuredAcpPreview(context.kind, selected.peer, selected.sessionId !== undefined), null, 2)); return; }
  const hub = await context.connect();
  try {
    await requireActiveConfiguredAcp(hub, context.kind, selected.peer);
    const reply = await hub.request({ t: "start", peer: selected.peer, args: { mode: "headless", ...(selected.sessionId ? { sessionId: selected.sessionId } : {}) }, ...(context.operationId ? { operationId: context.operationId } : {}) }, 35_000);
    if (!reply.ok) throw new Error(typeof reply.error === "string" ? reply.error : "configured ACP start refused");
    context.print(reply.already ? `${selected.peer} is already attached` : `${selected.peer} attached (headless); use ahub say @${selected.peer} and the console for approvals`);
  } finally { hub.close(); }
}
