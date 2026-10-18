import type { CreateContext, DaemonEngine, DaemonPorts } from "../registry-types.ts";
import type { PeerAdapter } from "../../hub/peers.ts";

// Load only fixed builtin modules after the pre-effect guards. A top-level LocalPeer import would
// cycle through hub-tools and the registry while its definitions are still being initialized.
export function createCodex(ctx: CreateContext): PeerAdapter {
  if (!("codex" in ctx.daemon)) throw new Error("Codex requires its Codex transport options");
  if (ctx.permission === "read-only") throw new Error("Codex has no verified read-only permission mapping");
  const { CodexPeer } = require("../codex-appserver.ts") as typeof import("../codex-appserver.ts");
  return new CodexPeer(ctx.instance, ctx.daemon.codex);
}

export function createKimi(ctx: CreateContext): PeerAdapter {
  if (!("acp" in ctx.daemon)) throw new Error("Kimi requires its ACP transport options");
  if (ctx.permission === "read-only") throw new Error("Kimi has no verified read-only permission mapping");
  const { AcpPeer } = require("../acp.ts") as typeof import("../acp.ts");
  return new AcpPeer(ctx.instance, ctx.daemon.acp);
}

export function createJcode(ctx: CreateContext): PeerAdapter {
  if (!("jcode" in ctx.daemon)) throw new Error("Jcode requires its Jcode transport options");
  if (ctx.permission === "read-only") throw new Error("Jcode has no verified read-only permission mapping");
  const { JcodePeer } = require("../jcode.ts") as typeof import("../jcode.ts");
  return new JcodePeer(ctx.daemon.jcode);
}

export function createPi(ctx: CreateContext): PeerAdapter {
  if (!("pi" in ctx.daemon)) throw new Error("Pi requires its Pi transport options");
  if (ctx.permission === "read-only") throw new Error("Pi has no verified read-only permission mapping");
  const { PiPeer } = require("../pi.ts") as typeof import("../pi.ts");
  return new PiPeer(ctx.instance, ctx.daemon.pi);
}

export function createLocal(ctx: CreateContext): PeerAdapter {
  if (!("local" in ctx.daemon)) throw new Error("Local worker requires its local transport options");
  if (ctx.permission === "read-only") throw new Error("Local worker has no verified read-only permission mapping");
  const { LocalPeer } = require("../local-worker.ts") as typeof import("../local-worker.ts");
  return new LocalPeer(ctx.instance, ctx.daemon.local);
}

/** Preserve existing transport option types and object identity; selection stays host-owned. */
export const DAEMON_PORTS = {
  "codex-appserver": (options: Extract<DaemonPorts, { codex: unknown }>["codex"]) => ({ codex: options }),
  acp: (options: Extract<DaemonPorts, { acp: unknown }>["acp"]) => ({ acp: options }),
  "owned-acp": (options: Extract<DaemonPorts, { jcode: unknown }>["jcode"]) => ({ jcode: options }),
  "pi-rpc": (options: Extract<DaemonPorts, { pi: unknown }>["pi"]) => ({ pi: options }),
  "local-worker": (options: Extract<DaemonPorts, { local: unknown }>["local"]) => ({ local: options }),
} satisfies Record<DaemonEngine, unknown>;
