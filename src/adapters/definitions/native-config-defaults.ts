import { join } from "node:path";
import type { HubConfig } from "../../hub/daemon.ts";
import type { Routing } from "../../hub/routing.ts";

/** Preserve the legacy config block order and shallow native merges. */
export const NATIVE_CONFIG_BLOCKS = ["local", "pi"] as const;
export function nativeConfigurationDefaults(ctx: { home: string; env: Readonly<Record<string, string | undefined>>; networkAllow: string[] }) {
  return {
    commands: { kimi_cmd: ["kimi", "acp"], qwen_cmd: ["qwen", "--acp"], jcode_cmd: ["jcode"], jcode_home: ctx.env.JCODE_HOME ?? join(ctx.home, ".jcode"), jcode_provider_profile: "" },
    proxy: { codex_bin: "codex" },
    rpc: { pi: { enabled: false, auto_start: false, cmd: ["pi"], backend: "auto" as const, dgx_coding: "coding", dgx_fast: "fast", max_steps: 30 } },
    sandbox: { local: { deny: [] as string[], bash_network: false, network_allow: ctx.networkAllow, max_steps: 30, read_allow: [] as string[], doc_read: false, web_fetch: { allow: [] as string[] } } },
  };
}
export function mergeNativeConfiguration(file: Record<string, any>, defaults: HubConfig): Pick<HubConfig, "local" | "pi"> {
  return { local: { ...defaults.local, ...file.local }, pi: { ...defaults.pi, ...file.pi } };
}
/** The published RPC relay stays bound while other routing leaves are reloaded. */
export function retainNativeRouting(running: Routing): Pick<Routing, "pi"> { return { pi: running.pi }; }
