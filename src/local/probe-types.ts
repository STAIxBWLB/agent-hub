import type { ChatMessage, ChatResult, OmniRoute } from "../omniroute/client.ts";
import type { ProbeFakeEffects, ProbeResourceCharges, ProbeSlot, ProbeStoredState, ProbeWorkerFramePreparer } from "../hub/guidance-probes.ts";
import type { ProbeConfinement } from "./probe-sandbox.ts";
import type { ProbeMaterializedFile, ProbeWorkspace, ProbeWorkspaceInput } from "./probe-workspace.ts";
import type { ToolContext } from "./tools.ts";
import { guidanceProbeCanonical, probeHash } from "../hub/guidance-probes.ts";

export class ProbeLocalError extends Error {
  constructor(readonly reason: "invalid" | "drift" | "model" | "usage" | "interrupted") {
    super("guidance probe execution is unavailable or uncertain; retain its private state and inspect before retrying");
  }
}

export interface ProbeLocalModelConfig {
  maxSteps: number;
  maxOutputTokens: number;
  /** Trusted frozen upper bound for the entire call, not an output-token cap. */
  tokenUpperBound?: number;
}
export interface ProbeLocalRequest {
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  max_tokens: number;
  stream: false;
}
export interface ProbePreparedLocalInput {
  inputFrame: string;
  inputSha256: string;
  nonGuidanceInputSha256: string;
  request: ProbeLocalRequest;
  role: ProbeSlot["role"];
  files: readonly { dataId: string; relative: string; sha256: string; bytes: number }[];
}
export interface ProbeLocalEffectScope {
  effects: ProbeFakeEffects;
  next(): number;
  current(): void;
}
export interface ProbeLocalSession {
  purpose: "guidance_probe";
  prepared: ProbePreparedLocalInput;
  workspace: ProbeWorkspace;
  confinement: ProbeConfinement;
  config: Readonly<ProbeLocalModelConfig>;
  accounting: ProbeLocalEffectScope;
  reserve(charges: ProbeResourceCharges, descriptor: string): Promise<void>;
}
export interface ProbeLocalResult {
  answer: string;
  complete: boolean;
  servedModel: string | null;
  servedModelExact: boolean;
  usageKnown: boolean;
}
export interface ProbeLocalSource {
  files: readonly ProbeMaterializedFile[];
  sourceTree?: ProbeWorkspaceInput["sourceTree"];
  verifySource: ProbeWorkspaceInput["verifySource"];
}
export interface ProbeLocalFixturePorts {
  evidence: "fixture_only";
  materialize(input: ProbeWorkspaceInput): Promise<ProbeWorkspace>;
  confine(workspace: ProbeWorkspace): Promise<ProbeConfinement>;
}
export interface ProbeLocalAdapterOptions {
  omni: OmniRoute;
  config: Readonly<ProbeLocalModelConfig>;
  permit: ToolContext["permit"];
  resolveInput(state: ProbeStoredState, slot: ProbeSlot): ProbeLocalSource | Promise<ProbeLocalSource>;
  current(): void;
  /** Private minted-resource ownership notification, never an ordinary observer or authority source. */
  workspaceOwned?: (workspace: ProbeWorkspace) => void;
  fixture?: ProbeLocalFixturePorts;
}
export interface ProbeLocalAdapter {
  prepareWorkerFrame: ProbeWorkerFramePreparer;
  prepareEditorFrame(state: ProbeStoredState, slot: ProbeSlot): Promise<string>;
  ports: import("../hub/guidance-probes.ts").GuidanceProbeFakePorts;
}

export const probeObservedTokens = (result: ChatResult): number | null => {
  const total = result.usage?.totalTokens;
  return typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null;
};

export async function probeLocalEffect<T>(scope: ProbeLocalEffectScope, unit: "model_calls" | "tool_calls" | "resources", descriptor: string,
  charges: ProbeResourceCharges | undefined, reservedTokens: number | undefined,
  effect: (signal: AbortSignal) => Promise<{ value: T; usage: number | null }>): Promise<T> {
  scope.current();
  const request = { sequence: scope.next(), unit, descriptorSha256: probeHash(descriptor),
    ...(charges ? { charges } : {}), ...(reservedTokens === undefined ? {} : { reservedTokens }) };
  const result = await scope.effects.runEffect(request, async signal => {
    scope.current();
    const observed = await effect(signal);
    return { ...observed, observationSha256: probeHash(guidanceProbeCanonical({ request, usage: observed.usage })) };
  });
  if (result.kind !== "executed") throw new ProbeLocalError("interrupted");
  return result.value;
}
