export type ClaudeFailureStage = "pre_permission" | "invalid_permission_request" | "wrapper_refused" | "manual_queue_expired" | "native_error";
export interface ClaudeFailureEvidence {
  stage: ClaudeFailureStage;
  requestId?: string;
  instanceId?: string;
  nativeVersion?: string;
}
type SpecificFailure = Exclude<ClaudeFailureStage, "pre_permission" | "native_error">;
export interface ClaudeFailureTrace {
  permissionObserved(requestId?: string): boolean;
  record(stage: SpecificFailure, requestId?: string): boolean;
  seal(): void;
  take(): Readonly<ClaudeFailureEvidence> | undefined;
  discard(): void;
}

const WITHHELD = "Claude implementer turn failed (details withheld)";
function ownData(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return; }
}
function requestId(value: unknown): string | undefined {
  return typeof value === "string" && value.length === 8 && /^[a-f0-9]{8}$/.test(value) ? value : undefined;
}
function instanceId(value: unknown): string | undefined {
  return typeof value === "string" && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) ? value : undefined;
}
function nativeVersion(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 20 && value === value.trim() && /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/.test(value) ? value : undefined;
}
function specific(value: unknown): value is SpecificFailure {
  return value === "invalid_permission_request" || value === "wrapper_refused" || value === "manual_queue_expired";
}
function stage(value: unknown): ClaudeFailureStage {
  return specific(value) || value === "pre_permission" ? value : "native_error";
}
function metadata(value: unknown): Pick<ClaudeFailureEvidence, "instanceId" | "nativeVersion"> {
  const instance = instanceId(ownData(value, "instanceId")), version = nativeVersion(ownData(value, "nativeVersion"));
  return { ...(instance ? { instanceId: instance } : {}), ...(version ? { nativeVersion: version } : {}) };
}

/** Render only fixed host-observed stages and validated metadata, never native diagnostic text. */
export function formatClaudeFailure(evidence: unknown, privateTurn: boolean): string {
  if (privateTurn !== false) return WITHHELD;
  const fields = [`stage=${stage(ownData(evidence, "stage"))}`];
  const request = requestId(ownData(evidence, "requestId")), meta = metadata(evidence);
  if (request) fields.push(`request=${request}`);
  if (meta.instanceId) fields.push(`instance=${meta.instanceId}`);
  if (meta.nativeVersion) fields.push(`native=${meta.nativeVersion}`);
  return `Claude implementer turn failed (${fields.join("; ")})`;
}

/** Host-only per-owned-launch observations. Seal before revoking child authority; consume after exit.
 * pre_permission reports only the absence of a host permission observation, never a native cause. */
export function createClaudeFailureTrace(options: { instanceId?: string; nativeVersion?: string; current: () => boolean }): ClaudeFailureTrace {
  const meta = Object.freeze(metadata(options)), current = ownData(options, "current");
  let sealed = false, consumed = false, discarded = false, seenPermission = false;
  let failure: SpecificFailure | undefined, request: string | undefined;
  const writable = () => {
    if (sealed || consumed || discarded) return false;
    try { return typeof current === "function" && current() === true && !sealed && !consumed && !discarded; } catch { return false; }
  };
  return Object.freeze({
    permissionObserved(id?: string): boolean {
      if (!writable()) return false;
      seenPermission = true; failure = undefined; request = requestId(id);
      return true;
    },
    record(value: SpecificFailure, id?: string): boolean {
      if (!specific(value) || !writable()) return false;
      seenPermission = true; failure = value; request = requestId(id);
      return true;
    },
    seal(): void { sealed = true; },
    take(): Readonly<ClaudeFailureEvidence> | undefined {
      if (!sealed || consumed || discarded) return;
      consumed = true;
      return Object.freeze({ stage: failure ?? (seenPermission ? "native_error" : "pre_permission"), ...meta, ...(request ? { requestId: request } : {}) });
    },
    discard(): void { discarded = true; failure = undefined; request = undefined; },
  });
}
