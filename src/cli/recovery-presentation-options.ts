/** Pure shared recognition; the console still validates colour values and precedence. */
export function recoveryPresentationFlag(arg: string): { kind: "json" | "verbose" } | { kind: "color"; value: string } | undefined {
  if (arg === "--json") return { kind: "json" };
  if (arg === "--verbose") return { kind: "verbose" };
  const prefix = "--color=";
  if (arg.startsWith(prefix)) return { kind: "color", value: arg.slice(prefix.length) };
  return undefined;
}
