export interface MeasurementChildResult {
  status: number | null;
  signal?: string | null;
  error?: { code?: string };
  stdout?: string;
  stderr?: string;
}
export interface MeasurementSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  encoding: "utf8";
  stdio: ["ignore", "pipe", "pipe", number | "ignore"];
  timeout: number;
  killSignal: "SIGKILL";
  maxBuffer: number;
}
export interface MeasurementPorts {
  command?: string;
  run?(command: string, args: string[], options: MeasurementSpawnOptions): MeasurementChildResult;
  now?(): number;
}
export interface MeasurementCommand {
  command: string; args: string[]; cwd: string; env: Record<string, string>;
  directoryFd?: number; expectedExit: number;
}
export interface MeasurementObservation {
  elapsedMs: number; timeoutMs: number; censored: boolean;
  outcome: "success" | "refused" | "unexpected-exit" | "timeout" | "output-cap" | "spawn-error" | "signal" | "unexpected-content";
  exitCode: number | null; signal: "SIGKILL" | "SIGTERM" | "other" | null;
}
export interface PythonStartupInput {
  mode: "output-check" | "extract"; output?: string; sourceSha: string; replicate: number;
}
export interface PythonStartupResult {
  schemaVersion: 1; sourceSha: string; helperSha256: string; mode: PythonStartupInput["mode"]; replicate: number;
  flags: string[]; pythonSelection: "system-python3"; coldDefinition: string;
  runner: { os: string; architecture: string; node: string; imageOS: string; imageVersion: string; runnerOS: string; runnerArchitecture: string };
  cold: MeasurementObservation; warm: MeasurementObservation[]; refusal: MeasurementObservation;
  interpreter: { status: string; version: string | null; implementation: string | null };
  metadataObservation: MeasurementObservation;
}
export function startupArchive(name?: string): Buffer;
export function measureCommand(request: MeasurementCommand, ports?: MeasurementPorts): { observation: MeasurementObservation; result: MeasurementChildResult };
export function measurePythonStartup(input: PythonStartupInput, ports?: MeasurementPorts): PythonStartupResult;
