import { resolveColor } from "./console-state.ts";
import type { RecoveryPresentationOptions } from "./upgrade-presentation.ts";

/** Presentation flags never consume another option's audit, version or peer value. */
export function readRecoveryPresentationFlags(
  argv: readonly string[],
  terminal: { isTTY: boolean; columns?: number; TERM?: string; NO_COLOR?: string },
  now: () => number = Date.now,
): { args: string[]; flags: string[]; json: boolean; options: RecoveryPresentationOptions } {
  const args: string[] = [], flags: string[] = [];
  let color: string | undefined, json = false, verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (["--reason", "--fresh-session", "--to"].includes(arg)) {
      args.push(arg);
      if (i + 1 < argv.length) args.push(argv[++i]!);
    } else if (arg === "--color") {
      throw new Error("usage: ahub <command> [--color=auto|always|never]");
    } else if (arg.startsWith("--color=")) {
      if (color !== undefined) throw new Error("usage: ahub <command> [--color=auto|always|never]");
      color = arg.slice("--color=".length); flags.push(arg);
    } else if (arg === "--json") { json = true; flags.push(arg); }
    else if (arg === "--verbose") { verbose = true; flags.push(arg); }
    else args.push(arg);
  }
  const resolved = resolveColor(color, terminal);
  if (resolved instanceof Error) throw resolved;
  const columns = terminal.columns !== undefined && Number.isFinite(terminal.columns) && terminal.columns > 0 ? Math.floor(terminal.columns) : 80;
  return { args, flags, json, options: { columns, color: resolved, verbose, now } };
}
