/** Closed probe-only causes. They carry no physical path, model text, actor id or native diagnostic. */
export type ProbeToolRefusalCode = "outside_workspace" | "invalid_path" | "unadmitted_write" | "file_ceiling"
  | "hardlinked_target" | "nonregular_target" | "authority_stopped" | "target_changed" | "tool_unavailable"
  | "workspace_ceiling" | "confinement_unavailable" | "token_bound_unavailable" | "token_ceiling";
const reasons: Record<ProbeToolRefusalCode, string> = {
  outside_workspace: "path is outside the admitted logical workspace; use a declared /workspace path",
  invalid_path: "path is not an admitted relative name; use a declared /workspace file without traversal, dependency or internal-temp components",
  unadmitted_write: "write target is not admitted; choose a target from the supplied logical /workspace/scratch or /workspace/output list",
  file_ceiling: "file exceeds the 1 MiB file ceiling; reduce the file before requesting another admitted operation",
  hardlinked_target: "hardlinked target is not a private probe file; ask the host for a fresh regular file",
  nonregular_target: "target is not a regular probe file; choose a declared regular file",
  authority_stopped: "probe authority is stopped or unavailable; stop this session and ask the host for a newly admitted session",
  target_changed: "probe target or reservation changed; stop this operation and ask the host to inspect the admitted state",
  tool_unavailable: "tool is unavailable in the confined probe; use only the admitted read, write and edit tools",
  workspace_ceiling: "workspace reservation exceeds its admitted workspace ceiling (at most 64 MiB); reduce the declared data or ask the host for a new bounded session",
  confinement_unavailable: "OS confinement or owned cleanup is unverified; stop this session and ask the host to inspect confinement and retained resources",
  token_bound_unavailable: "trusted token upper-bound proof is unavailable; ask the host to prepare a frozen configuration before another model call",
  token_ceiling: "model call exceeds the admitted token ceiling; reduce its declared input or ask the host for a new bounded session",
};
const unknownReason = "confined probe operation refused; stop this operation and ask the host to inspect the admitted state";
export class ProbeToolRefusal extends Error {
  constructor(readonly code: ProbeToolRefusalCode) { super(Object.hasOwn(reasons, code) ? reasons[code] : unknownReason); }
}
/** Never classify from native/error prose or reuse an arbitrary Error.message. */
export function formatProbeToolRefusal(error: unknown): string {
  const reason = error instanceof ProbeToolRefusal && Object.hasOwn(reasons, error.code) ? reasons[error.code] : unknownReason;
  return `error: ${reason}`;
}
