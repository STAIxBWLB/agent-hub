import type { AdapterDefinition, LaunchContext, LaunchPlan } from "../registry-types.ts";
import { AGY_REVIEWER_VARIANT } from "../definitions/reviewer-variants.ts";
import { AGY_FACTS_HOOK } from "./hooks.ts";

const DISPLAY = { palette: { fg: "#6558a6", bg: "#f1effa" } };
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function agyLaunch(ctx: LaunchContext): LaunchPlan {
  const argv = ["agy", ...ctx.userArgs], command = argv.map(shellQuote).join(" ");
  const metadata = { packageEntrypoint: ctx.entrypoint, command, argv, env: {}, kind: "agy", peer: ctx.instance } as LaunchPlan["metadata"] & { kind: "agy"; peer: string };
  return { cmd: "agy", args: ctx.userArgs, metadata };
}

/** Antigravity is an unmanaged, pull-only peer attached from its native project plugin. */
export const AGY_DEFINITION: AdapterDefinition = {
  api: 1,
  kind: "agy",
  displayName: "Antigravity",
  family: "agy",
  transport: "ws-pull",
  roles: ["implementer", "verifier"],
  optional: true,
  defaultOnRoster: false,
  trust: { onPrem: false, hubSandboxed: false },
  start: {
    forms: ["tui"],
    defaultForm: "tui",
    ownsTerminal: form => form === "tui",
    launch: agyLaunch,
    conductorStartable: true,
    hubSwitches: [],
    ownedFlags: ["--new", "--continue", "--conversation", "--resume"],
    conductorStartArgs: args => args.length ? new Error("conductor starts accept no launch overrides; use ahub agy") : {},
  },
  identity: { mcp: "channel-plugin" },
  attach: {
    pullOnlyForms: ["tui"],
    recoveryLaunch: instance => ({ kind: "agy", peer: instance }),
    pullOnlyNotice: "pull-only: messages wait for hub_inbox; permission modes and session recovery are not managed",
  },
  permission: {
    modes: {},
    unmanaged: "Antigravity selects its own permission mode in its TUI; no hub permission mode",
    unmanagedForms: ["tui"],
    unmanagedNote: "Antigravity approves tools in its own TUI; no hub permission mode",
    unmanagedStatusNote: "unmanaged native permission policy",
  },
  session: {
    idField: "sessionId",
    currentId: () => undefined,
    freshOnRestore: true,
    recoveryRefusal: () => "Antigravity session continuity and resume are unavailable until native behavior is verified",
  },
  turnEnd: "native-hook",
  cli: { command: "agy", authority: "person", startWords: () => ["agy"] },
  display: DISPLAY,
  routing: { allowedRoles: ["implementer", "verifier"] },
  reviewer: { defaultPool: false, declaration: "automatic", unavailable: "agy is an implementer peer (#485)" },
  reviewerVariant: AGY_REVIEWER_VARIANT,
  hooks: { factsHook: AGY_FACTS_HOOK },
};
