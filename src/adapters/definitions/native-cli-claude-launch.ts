import { mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { CLAUDE_CHANNEL, sessionSettings, UNATTENDED_WARNING, type Launch } from "../../cli/launch.ts";
import type { LaunchContext, LaunchPlan } from "../registry-types.ts";
import { nativeLaunchArguments, nativeLaunchPlan } from "./native-cli-launch-common.ts";

export const CLAUDE_LAUNCH_POLICY = Object.freeze({ hubSwitches: Object.freeze(["--unattended", "--safe", "--new"]), ownedFlags: Object.freeze(["--dangerously-load-development-channels", "--dangerously-skip-permissions"]), unattended: true, passthrough: true });

function claudeChannel(userArgs: string[]): string {
  const bundle = resolve(import.meta.dir, "../../../plugins/agent-hub/server.js");
  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i]!;
    const path = arg === "--mcp-config" ? userArgs[i + 1] : arg.startsWith("--mcp-config=") ? arg.slice("--mcp-config=".length) : undefined;
    if (!path) continue;
    try {
      const server = JSON.parse(readFileSync(resolve(path), "utf8")).mcpServers?.["agent-hub"];
      if (server?.command === "bun" && Array.isArray(server.args) && server.args.some((value: unknown) => typeof value === "string" && resolve(value) === bundle)) return "server:agent-hub";
    } catch { /* The native CLI reports invalid user-supplied MCP configuration. */ }
  }
  return CLAUDE_CHANNEL;
}

export function claudeNativeLaunch(ctx: LaunchContext): LaunchPlan {
  const { passthrough, unattended } = nativeLaunchArguments("claude", ctx, CLAUDE_LAUNCH_POLICY);
  const build = (): Launch => {
    // `--settings` takes one value, so a user-supplied one wins and Claude has no quota source for that session.
    const own = passthrough.some((a) => a === "--settings" || a.startsWith("--settings="));
    let settingsArgs = ctx.statusLine && !own ? ["--settings", sessionSettings(ctx.statusLine, ctx.facts)] : [];
    let nativeArgs = passthrough;
    let settingsFile: string | undefined;
    if (own) {
      if (passthrough.filter(a => a === "--settings" || a.startsWith("--settings=")).length > 1) throw new Error("pass --settings only once so the hub permission hook stays installed");
      const index = passthrough.findIndex(a => a === "--settings" || a.startsWith("--settings="));
      const arg = passthrough[index]!;
      const value = arg === "--settings" ? passthrough[index + 1] : arg.slice("--settings=".length);
      if (!value) throw new Error("--settings requires a JSON object or readable file so the hub permission hook can be installed");
      let caller: Record<string, unknown>;
      try {
        caller = JSON.parse(value.trim().startsWith("{") ? value : readFileSync(resolve(value), "utf8"));
        if (!caller || typeof caller !== "object" || Array.isArray(caller)) throw new Error("not an object");
      } catch { throw new Error("cannot read --settings as a JSON object; the hub permission hook must be installed"); }
      if (ctx.facts && caller.disableAllHooks === true) throw new Error("--settings disableAllHooks prevents the required hub permission hook; enable hooks to launch");
      const injected = JSON.parse(sessionSettings(undefined, ctx.facts));
      const callerHooks = caller.hooks;
      if (callerHooks !== undefined && (!callerHooks || typeof callerHooks !== "object" || Array.isArray(callerHooks))) throw new Error("--settings hooks must be an object");
      const hooks = { ...(callerHooks as Record<string, unknown> | undefined) };
      for (const [event, entries] of Object.entries(injected.hooks ?? {})) {
        const existing = hooks[event];
        if (existing !== undefined && !Array.isArray(existing)) throw new Error(`--settings ${event} hooks must be an array`);
        hooks[event] = [...(existing as unknown[] | undefined ?? []), ...(entries as unknown[])];
      }
      settingsArgs = ["--settings", JSON.stringify({ ...caller, ...(ctx.facts ? { hooks } : {}) })];
      nativeArgs = passthrough.filter((_, i) => i !== index && (arg !== "--settings" || i !== index + 1));
    } else if (ctx.facts && !ctx.statusLine) {
      const injected = JSON.parse(sessionSettings(undefined, ctx.facts));
      settingsArgs = ["--settings", JSON.stringify({ hooks: injected.hooks })];
    }
    if (settingsArgs.length && !ctx.preview) {
      const stateDir = ctx.facts?.stateDir ?? ctx.statusLine?.stateDir;
      if (!stateDir) throw new Error("Claude session settings require the hub state directory");
      const file = join(stateDir, `claude-settings-${randomUUID()}.json`);
      try {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        writeFileSync(`${file}.tmp`, settingsArgs[1]!, { mode: 0o600, flag: "wx" });
        renameSync(`${file}.tmp`, file);
      } catch {
        try { unlinkSync(`${file}.tmp`); } catch { /* no temp file was written */ }
        throw new Error("cannot write private Claude session settings in the hub state directory");
      }
      settingsArgs[1] = file;
      settingsFile = file;
    }
    const notes = [
      unattended ? UNATTENDED_WARNING : "",
      ctx.statusLine && own ? "note: you passed --settings, so the hub's status line tee is off and the budget coordinator cannot see Claude's quota (ahub budget set claude <0..1> still works)." : "",
    ].filter(Boolean);
    return {
      cmd: "claude",
      args: ["--dangerously-load-development-channels", claudeChannel(passthrough), ...(unattended ? ["--dangerously-skip-permissions"] : []), ...settingsArgs, ...nativeArgs],
      ...(settingsFile ? { settingsFile } : {}),
      permissionHook: !!ctx.facts,
      ...(ctx.facts ? { hookPurpose: ctx.facts.purpose ?? "facts" } : {}),
      unattended,
      ...(notes.length ? { warning: notes.join("\n") } : {}),
    };

  };
  return nativeLaunchPlan(build(), ctx);
}
