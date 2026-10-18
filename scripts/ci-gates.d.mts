export interface VerifiedRun { id: number; head_sha: string; html_url: string; conclusion: string; event: string }
export function findVerifiedRun(api: (path: string) => Promise<any>, tree: string): Promise<VerifiedRun | undefined>;
export const REUSE_MARKER: "Reuse verified identical-tree full gate";
export type GateAdmission =
  | { kind: "run" }
  | { kind: "reuse" | "duplicate"; run: Record<string, unknown> }
  | { kind: "unknown"; reason: string };
export function fullGateAdmission(tree: string, runs: unknown[], options?: { currentRunId?: string | number; complete?: boolean }): GateAdmission;
export function readFullGateAdmission(api: (path: string) => Promise<unknown>, tree: string, options?: { currentRunId?: string | number }): Promise<GateAdmission>;
