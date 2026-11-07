/** In-memory scripted CLI port for the Herdr H0 contract. Never spawns, reads HOME, touches a filesystem, reaches a machine or opens a URL. */
import type { HerdrFixtureCliPort, HerdrFixtureCliResult, HerdrFixtureExecCall } from "../helpers/herdr-mod-host.ts";

export interface HerdrFixtureCliResponse { stdout: string; stderr?: string; exitCode: number | null; durationMs?: number; timedOut?: boolean }
export class HerdrFixtureCliError extends Error {
  constructor(readonly code: "invalid_request" | "disabled" | "unscripted" | "unexpected_call") { super(code); this.name = "HerdrFixtureCliError"; }
}
function prefix(text: string, cap: number): string {
  const bytes = new TextEncoder().encode(text);
  let end = Math.min(bytes.length, cap);
  for (;;) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); }
    catch { end--; }
  }
}
export class FakeHerdrCompanionCli {
  readonly calls: HerdrFixtureExecCall[] = [];
  private readonly responses: HerdrFixtureCliResponse[];
  private enabled: boolean;
  constructor(options: { scripted: readonly HerdrFixtureCliResponse[]; enabled?: boolean }) {
    this.responses = structuredClone([...options.scripted]); this.enabled = options.enabled ?? true;
  }
  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  get remainingScripts(): number { return this.responses.length; }
  readonly run: HerdrFixtureCliPort = async (call): Promise<HerdrFixtureCliResult> => {
    if (typeof call.command !== "string" || !call.command || !Array.isArray(call.args) || !call.args.every(a => typeof a === "string")
      || !Number.isSafeInteger(call.timeoutMs) || call.timeoutMs <= 0 || !Number.isSafeInteger(call.maxOutputBytes) || call.maxOutputBytes <= 0) throw new HerdrFixtureCliError("invalid_request");
    this.calls.push({ ...call, args: [...call.args] });
    if (!this.enabled) throw new HerdrFixtureCliError("disabled");
    const response = this.responses.shift(); if (!response) throw new HerdrFixtureCliError("unscripted");
    const duration = response.durationMs ?? 0;
    if (typeof response.stdout !== "string" || response.stderr !== undefined && typeof response.stderr !== "string" || !Number.isFinite(duration) || duration < 0
      || response.exitCode !== null && !Number.isSafeInteger(response.exitCode)) throw new HerdrFixtureCliError("invalid_request");
    const stdout = prefix(response.stdout, call.maxOutputBytes), used = new TextEncoder().encode(stdout).length;
    const stderr = prefix(response.stderr ?? "", call.maxOutputBytes - used);
    const timedOut = response.timedOut === true || duration > call.timeoutMs;
    return { stdout, stderr, exitCode: timedOut ? null : response.exitCode, timedOut, truncated: stdout !== response.stdout || stderr !== (response.stderr ?? "") };
  };
}
