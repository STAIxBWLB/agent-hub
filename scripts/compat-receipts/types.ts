import type { CompatId } from "../../src/adapters/compat.ts";

export type LegStatus = "pass" | "fail" | "not-run";
export const CAUSES = ["ok", "proof-failed", "timeout", "cancelled", "platform", "model-required", "tui-required", "producer-not-committed", "producer-not-importable", "not-applicable", "source-review-required", "install-unavailable", "integrity", "input", "cleanup"] as const;
export type Cause = typeof CAUSES[number];
export interface ManifestLeg { id: string; label: string; category: string; runnerOS: string[]; requiredForAdmission: boolean }
export interface ManifestEntry {
  receipt: string;
  runnerOS: string[];
  nativePlatform: string;
  autoAdmit: boolean;
  install: { method: string; package?: string; repository?: string; tagTemplate?: string; asset?: string; checksumAsset?: string };
  legs: ManifestLeg[];
}
export interface ReceiptLimits { totalMs: number; installMs: number; legMs: number; outputBytes: number; artifactBytes: number; expandedBytes: number; archiveEntries: number }
export interface CommandOptions { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number; maxBytes?: number }
export interface CommandResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; cleanup: boolean }
export type ReceiptFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
export type ReceiptCommand = (argv: readonly string[], options: CommandOptions) => Promise<CommandResult>;
export interface ReceiptContext {
  id: CompatId;
  version: string;
  root: string;
  home: string;
  prefix: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  limits: ReceiptLimits;
  run: ReceiptCommand;
}
export interface InstalledArtifact {
  method: string;
  integrity: string;
  packageRoot: string;
  command: string[];
}
export interface ProofResult { status: LegStatus; cause: Cause }
export interface ProofContext extends ReceiptContext { artifact: InstalledArtifact; entry: ManifestEntry }
export type ProofResults = Record<string, ProofResult>;
export type ReceiptProofs = (context: ProofContext) => Promise<ProofResults>;
export interface LegResult extends ProofResult { id: string; requiredForAdmission: boolean; reason: string; nextStep: string }
export interface ReceiptSummary {
  schemaVersion: 1;
  id: CompatId;
  version: string;
  runnerOS: string;
  architecture: string;
  procedureReceipt: string;
  generatedAt: string;
  bounds: { totalMs: number; legMs: number; cleanupMs: number };
  cleanupConfirmed: boolean;
  installation: ProofResult & { reason: string; nextStep: string };
  artifact: { method: string; integrity: string } | null;
  integrity: string | null;
  autoAdmit: boolean;
  eligible: boolean;
  outcome: LegStatus;
  elapsedMs: number;
  legs: LegResult[];
}
export interface ReceiptPorts {
  fetch?: ReceiptFetch;
  run?: ReceiptCommand;
  install?: (context: ReceiptContext, entry: ManifestEntry, fetcher: ReceiptFetch) => Promise<InstalledArtifact>;
  proofs?: ReceiptProofs;
  entry?: ManifestEntry;
  platform?: string;
  architecture?: string;
  limits?: Partial<ReceiptLimits>;
}

/** Closed diagnostic cause only: native stdout/config text is never an error message. */
export class ReceiptError extends Error {
  constructor(readonly causeCode: Cause) { super(causeCode); this.name = "ReceiptError"; }
}
