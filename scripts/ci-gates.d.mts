export const REUSE_MARKER: "Reuse verified identical-tree full gate";
export type GateAdmission =
  | { kind: "run" }
  | { kind: "reuse" | "duplicate"; run: Record<string, unknown> }
  | { kind: "unknown"; reason: string };
export function fullGateAdmission(tree: string, runs: unknown[], options?: { currentRunId?: string | number; complete?: boolean }): GateAdmission;
export function readFullGateAdmission(api: (path: string) => Promise<unknown>, tree: string, options?: { currentRunId?: string | number; deadline?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<GateAdmission>;
