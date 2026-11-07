/** In-memory injected CLI port only. Never spawns, reads HOME, accesses a filesystem or opens a URL. */
export interface OrcaCompanionFixtureCliCall {
  executable: string;
  argv: readonly string[];
  cwd: string;
  hostId: string | null;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface OrcaCompanionFixtureCliResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean }
export interface OrcaCompanionFixtureCliResponse { stdout: string; stderr?: string; exitCode: number | null; durationMs?: number; timedOut?: boolean }
export type OrcaCompanionFixtureCliPort = (call: OrcaCompanionFixtureCliCall) => Promise<OrcaCompanionFixtureCliResult>;
export class OrcaCompanionFixtureCliError extends Error {
  constructor(readonly code: "invalid_request" | "disabled" | "host_mismatch" | "unscripted") { super(code); this.name = "OrcaCompanionFixtureCliError"; }
}
function prefix(text: string, cap: number): string {
  const bytes = new TextEncoder().encode(text);
  let end = Math.min(bytes.length, cap);
  for (;;) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); }
    catch { end--; }
  }
}
export class FakeOrcaCompanionCli {
  readonly calls: OrcaCompanionFixtureCliCall[] = [];
  private readonly hostId: string | null;
  private readonly responses: OrcaCompanionFixtureCliResponse[];
  private enabled: boolean;
  constructor(options: { hostId: string | null; scripted: readonly OrcaCompanionFixtureCliResponse[]; enabled?: boolean }) {
    this.hostId = options.hostId; this.responses = structuredClone([...options.scripted]); this.enabled = options.enabled ?? true;
  }
  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  get remainingScripts(): number { return this.responses.length; }
  readonly run: OrcaCompanionFixtureCliPort = async call => {
    if (typeof call.executable !== "string" || !call.executable || typeof call.cwd !== "string" || !call.cwd || !Array.isArray(call.argv)
      || !call.argv.every(argument => typeof argument === "string") || call.hostId !== null && typeof call.hostId !== "string"
      || !Number.isSafeInteger(call.timeoutMs) || call.timeoutMs <= 0 || !Number.isSafeInteger(call.maxOutputBytes) || call.maxOutputBytes <= 0) throw new OrcaCompanionFixtureCliError("invalid_request");
    this.calls.push({ ...call, argv: [...call.argv] });
    if (!this.enabled) throw new OrcaCompanionFixtureCliError("disabled");
    if (call.hostId !== this.hostId) throw new OrcaCompanionFixtureCliError("host_mismatch");
    const response = this.responses.shift(); if (!response) throw new OrcaCompanionFixtureCliError("unscripted");
    const duration = response.durationMs ?? 0;
    if (typeof response.stdout !== "string" || response.stderr !== undefined && typeof response.stderr !== "string" || !Number.isFinite(duration) || duration < 0
      || response.exitCode !== null && !Number.isSafeInteger(response.exitCode)) throw new OrcaCompanionFixtureCliError("invalid_request");
    const stdout = prefix(response.stdout, call.maxOutputBytes), used = new TextEncoder().encode(stdout).length;
    const stderr = prefix(response.stderr ?? "", call.maxOutputBytes - used);
    const timedOut = response.timedOut === true || duration > call.timeoutMs;
    return { stdout, stderr, exitCode: timedOut ? null : response.exitCode, timedOut,
      truncated: stdout !== response.stdout || stderr !== (response.stderr ?? "") };
  };
}
