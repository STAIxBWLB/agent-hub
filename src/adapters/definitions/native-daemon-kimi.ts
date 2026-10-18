/** Kimi puts its optional model switch before the configured ACP subcommand. */
export function kimiAcpCommand(command: readonly string[], model?: string): string[] {
  const [cmd, ...args] = command;
  return [cmd!, ...(model ? ["--model", model, ...args] : args)];
}
