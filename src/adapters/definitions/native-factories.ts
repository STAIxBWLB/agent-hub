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

export function createQwenDual(ctx: CreateContext): PeerAdapter {
  if (!("qwenDual" in ctx.daemon)) throw new Error("Qwen TUI requires its dual-output transport options");
  if (ctx.permission === "read-only") throw new Error("Qwen has no verified read-only permission mapping");
  const { QwenDualPeer } = require("../qwen-dual.ts") as typeof import("../qwen-dual.ts");
  return new QwenDualPeer(ctx.instance, ctx.daemon.qwenDual);
}

export function createPi(ctx: CreateContext): PeerAdapter {
  if (!("pi" in ctx.daemon)) throw new Error("Pi requires its Pi transport options");
  if (ctx.permission === "read-only") throw new Error("Pi has no verified read-only permission mapping");
  const { PiPeer, PiVersionRefusal, piVersionAsync } = require("../pi.ts") as typeof import("../pi.ts");
  const options = ctx.daemon.pi;
  return new PiPeer(ctx.instance, { ...options, preflight: async () => {
    const verdict = await piVersionAsync(options.cmd ?? ["pi"], options.cwd);
    if (!verdict.ok) throw new PiVersionRefusal(verdict);
    if (verdict.note) options.log?.(verdict.note);
  } });
}

export function createLocal(ctx: CreateContext): PeerAdapter {
  if (!("local" in ctx.daemon)) throw new Error("Local worker requires its local transport options");
  if (ctx.permission === "read-only") throw new Error("Local worker has no verified read-only permission mapping");
  const { LocalPeer } = require("../local-worker.ts") as typeof import("../local-worker.ts");
  return new LocalPeer(ctx.instance, ctx.daemon.local);
}

export function createClaudeReviewer(ctx: CreateContext): PeerAdapter {
  if ("reviewerPrint" in ctx.daemon) {
    const { ClaudePrintPeer } = require("../claude-print.ts") as typeof import("../claude-print.ts");
    return new ClaudePrintPeer(ctx.instance, ctx.daemon.reviewerPrint);
  }
  if (!("claudePrint" in ctx.daemon)) throw new Error("Claude reviewer requires its print transport options");
  const { ClaudePrintPeer } = require("../claude-print.ts") as typeof import("../claude-print.ts");
  return new ClaudePrintPeer(ctx.instance, ctx.daemon.claudePrint);
}

export function createCodexReviewer(ctx: CreateContext): PeerAdapter {
  if (!("reviewerPrint" in ctx.daemon)) throw new Error("Codex reviewer requires its fresh print transport options");
  const config = ctx.kindConfig as { codex_bin?: string };
  return createReviewer({ ...ctx, daemon: { reviewerPrint: { ...ctx.daemon.reviewerPrint, command: ctx.daemon.reviewerPrint.command ?? [config.codex_bin ?? "codex"] } } });
}

export function createReviewer(ctx: CreateContext): PeerAdapter {
  if (!("reviewerPrint" in ctx.daemon)) throw new Error("Reviewer requires its fresh print transport options");
  const { ReviewerPrintPeer } = require("../reviewer-print.ts") as typeof import("../reviewer-print.ts");
  return new ReviewerPrintPeer(ctx.instance, ctx.daemon.reviewerPrint);
}

export function createClaudeImplementer(ctx: CreateContext): PeerAdapter {
  if (!("claudeImplementer" in ctx.daemon)) throw new Error("Claude implementer requires its per-task transport options");
  if (ctx.permission !== "ask" && ctx.permission !== "ask-when-needed") throw new Error("Claude implementer requires ask or ask-when-needed");
  const { ClaudeImplementerPeer } = require("../claude-implementer.ts") as typeof import("../claude-implementer.ts");
  return new ClaudeImplementerPeer(ctx.instance, ctx.daemon.claudeImplementer);
}

/** Preserve existing transport option types and object identity; selection stays host-owned. */
export const DAEMON_PORTS = {
  "codex-appserver": (options: Extract<DaemonPorts, { codex: unknown }>["codex"]) => ({ codex: options }),
  acp: (options: Extract<DaemonPorts, { acp: unknown }>["acp"]) => ({ acp: options }),
  "qwen-dual": (options: Extract<DaemonPorts, { qwenDual: unknown }>["qwenDual"]) => ({ qwenDual: options }),
  "owned-acp": (options: Extract<DaemonPorts, { jcode: unknown }>["jcode"]) => ({ jcode: options }),
  "pi-rpc": (options: Extract<DaemonPorts, { pi: unknown }>["pi"]) => ({ pi: options }),
  "local-worker": (options: Extract<DaemonPorts, { local: unknown }>["local"]) => ({ local: options }),
  "reviewer-print": (options: Extract<DaemonPorts, { reviewerPrint: unknown }>["reviewerPrint"]) => ({ reviewerPrint: options }),
  "claude-implementer": (options: Extract<DaemonPorts, { claudeImplementer: unknown }>["claudeImplementer"]) => ({ claudeImplementer: options }),
  "claude-print": (options: Extract<DaemonPorts, { claudePrint: unknown }>["claudePrint"]) => ({ claudePrint: options }),
} satisfies Record<DaemonEngine, unknown>;
