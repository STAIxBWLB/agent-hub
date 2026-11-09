import { CompanionError, LIMITS, consoleCommand, object, parse, parseRegistration, projectReading, type Binding, type Reading } from "./status.ts";
export type ReadCall = { executable: string; argv: readonly string[]; cwd: string; timeoutMs: number; maxOutputBytes: number };
export type Response = { stdout: string; stderr?: string; exitCode: number | null; durationMs?: number };
export interface Ports {
  /** Canonical session root, supplied by the host, never process.cwd or a fallback. */
  realRoot(): Promise<string>;
  run(call: ReadCall): Promise<Response>;
  now(): number;
  publish(reading: Reading): void | Promise<void>;
  toggle(): void | Promise<void>;
}
export const COMMAND_TEXT = { hub: "Hub pane command received.", refresh: "Hub refresh requested.", invalid: "Use /hub, /hub refresh or /hub console." } as const;
export const commandText = (argument: string, root: string): string => argument === "console" ? consoleCommand(root) : argument === "refresh" ? COMMAND_TEXT.refresh : argument === "" ? COMMAND_TEXT.hub : COMMAND_TEXT.invalid;
/** Session-local coordinator. Retains no raw CLI output; no timers and no persistent host APIs. */
export class CompanionController {
  private generation = 0;
  private enabled = true;
  private binding?: Binding;
  private flight?: Promise<void>;
  private pending = false;
  private lastStart = -Infinity;
  constructor(private readonly ports: Ports) {}
  disable(): void { this.enabled = false; this.generation++; this.pending = false; this.binding = undefined; }
  /** Host selection change invalidates success, failure and cleanup from an older read. */
  reset(): void { this.generation++; this.pending = false; this.binding = undefined; this.lastStart = -Infinity; }
  async command(argument: string, origin: string, root: string): Promise<string> {
    const answer = commandText(argument, root);
    if (origin !== "composer" || !this.enabled) return answer;
    if (argument === "") await this.ports.toggle();
    if (argument === "" || argument === "refresh") await this.refresh();
    return answer;
  }
  event(kind: "session.start" | "turn.end" | "tool.done", toolName?: string): Promise<void> {
    if (kind === "tool.done" && !/^mcp__(?:agent-hub|plugin_agent-hub_agent-hub)__hub_[a-z_]+$/.test(toolName ?? "")) return Promise.resolve();
    return this.refresh();
  }
  refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.flight) { this.pending = true; return this.flight; }
    if (this.ports.now() - this.lastStart < 1000) return Promise.resolve();
    const generation = this.generation;
    const current = () => this.enabled && this.generation === generation;
    this.lastStart = this.ports.now();
    const read = async () => {
      try {
        const root = await this.ports.realRoot();
        if (!current()) return;
        if (this.binding && this.binding.root !== root) throw new CompanionError("binding");
        const readBound = async (kind: "projects" | "status" | "board") => {
          if (!current() || await this.ports.realRoot() !== root) throw new CompanionError("binding");
          const result = await this.ports.run({ executable: "ahub", argv: ["--project", root, kind, "--json"], cwd: root, ...LIMITS });
          if (!current() || await this.ports.realRoot() !== root) throw new CompanionError("binding");
          if ((result.durationMs ?? 0) > LIMITS.timeoutMs) throw new CompanionError("timeout");
          if (new TextEncoder().encode(result.stdout + (result.stderr ?? "")).length > LIMITS.maxOutputBytes) throw new CompanionError("oversized");
          if (result.exitCode !== 0) throw new CompanionError(result.exitCode === 1 && (result.stderr ?? "").startsWith("ahub: no hub running for ") ? "offline" : "nonzero");
          return parse(result.stdout);
        };
        const binding = parseRegistration(await readBound("projects"), root, this.binding?.projectId);
        if (!current()) return;
        this.binding = binding;
        const status = await readBound("status");
        if (!object(status)) throw new CompanionError("unrecognized");
        if (status.cwd !== root || status.projectId !== binding.projectId) throw new CompanionError("binding");
        // A registration is rechecked before every public data read.
        parseRegistration(await readBound("projects"), root, binding.projectId);
        const board = await readBound("board");
        // Board rows have no binding header: verify their owner after the awaited read.
        parseRegistration(await readBound("projects"), root, binding.projectId);
        const projection = projectReading(status, board, binding, this.ports.now());
        if (await this.ports.realRoot() !== root) throw new CompanionError("binding");
        if (current()) await this.ports.publish(projection);
      } catch (error) {
        if (current()) await this.ports.publish({ state: error instanceof CompanionError ? error.state : "unknown" });
      }
    };
    const flight = read().finally(async () => {
      // A stale finally must not clear a newer binding or start a disabled read.
      if (this.flight !== flight) return;
      this.flight = undefined;
      const again = this.enabled && this.pending;
      this.pending = false;
      if (again) await this.refresh();
    });
    this.flight = flight;
    return flight;
  }
}
