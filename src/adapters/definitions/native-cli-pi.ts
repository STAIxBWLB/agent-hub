export function parsePiFlags(args: string[], fail: (message: string) => never): { mode?: "headless" | "tui"; backend?: "auto" | "dgx" | "mlx"; model?: string; sessionId?: string; sessionFile?: string; replaceSession?: boolean } {
  const usage = "usage: ahub pi [--mode headless|tui | --headless] [--backend auto|dgx|mlx] [--model <alias>] [--session-id <id> | --session-file <path>] [--replace-session --session-file <path>]";
  if (args.includes("--headless")) {
    if (args.includes("--mode")) fail(usage);
    args.splice(args.indexOf("--headless"), 1, "--mode", "headless");
  }
  for (const flag of ["--mode", "--backend", "--model", "--session-id", "--session-file"]) {
    const index = args.indexOf(flag);
    if (index >= 0 && (!args[index + 1] || args[index + 1]!.startsWith("--"))) fail(`${flag} needs a value`);
  }
  const mode = (args.includes("--mode") ? args[args.indexOf("--mode") + 1] : undefined) as string | undefined;
  const backend = (args.includes("--backend") ? args[args.indexOf("--backend") + 1] : undefined) as string | undefined;
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined;
  const sessionId = args.includes("--session-id") ? args[args.indexOf("--session-id") + 1] : undefined;
  const sessionFile = args.includes("--session-file") ? args[args.indexOf("--session-file") + 1] : undefined;
  const replaceSession = args.includes("--replace-session");
  if (replaceSession && (!sessionFile || sessionId)) fail("--replace-session requires --session-file, without --session-id");
  const valueFlags = new Set(["--mode", "--backend", "--model", "--session-id", "--session-file"]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--replace-session") continue;
    if (!valueFlags.has(args[i]!)) fail(`unknown Pi option: ${args[i]}`);
    i++;
  }
  if ((mode !== undefined && !["headless", "tui"].includes(mode)) || (backend !== undefined && !["auto", "dgx", "mlx"].includes(backend)) || (sessionId && sessionFile)) fail(usage);
  return { ...(replaceSession ? { replaceSession: true } : {}), ...(mode ? { mode: mode as "headless" | "tui" } : {}), ...(backend ? { backend: backend as "auto" | "dgx" | "mlx" } : {}), ...(model ? { model } : {}), ...(sessionId ? { sessionId } : {}), ...(sessionFile ? { sessionFile } : {}) };
}

/** The conductor can repeat only the selected form; native startup options remain person-only. */
export function piConductorStartArgs(args: string[]): { mode?: "headless" | "tui" } | Error {
  if (args.length === 1 && args[0] === "--headless") args.splice(0, 1, "--mode", "headless");
  if (args.length && !(args.length === 2 && args[0] === "--mode" && ["headless", "tui"].includes(args[1] ?? ""))) return new Error("conductor starts accept no launch overrides; use ahub pi [--mode headless|tui]");
  return args[1] ? { mode: args[1] as "headless" | "tui" } : {};
}
