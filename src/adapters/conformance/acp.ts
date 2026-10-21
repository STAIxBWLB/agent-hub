import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AcpPeer } from "../acp.ts";
import { newEnvelope } from "../../hub/envelope.ts";
import type { DeliveryReceipt } from "../../hub/peers.ts";
import { processTable } from "../../hub/child-process.ts";
import { until } from "./kit.ts";
import type { AdapterDefinition } from "../registry-types.ts";
import { fakePaths } from "./fake-paths.ts";
import { createFromDefinition, expire } from "./factories.ts";
import { ACP_LEGS, assertAcpLegEnrollment, type AcpLeg } from "./enrollment.ts";

export interface AcpConformanceOptions {
  definition: AdapterDefinition;
  agentArgs?: readonly string[];
  unsupported?: Partial<Record<AcpLeg, string>>;
  permissionPrompts?: { accepted: string; foreign: string };
  startupModeAcknowledgement?: boolean;
  modeAcknowledgement?: string;
  quotaLabel?: string;
  watchdogLabel?: string;
}
/** No protocol is run at import; callers explicitly select supported fake protocol legs. */
export function registerAcpConformance(options: AcpConformanceOptions): void {
    const { definition } = options, kind = definition.kind, fake = fakePaths.acpServer;
    if (definition.transport !== "acp") throw new Error(kind + ": ACP conformance requires an ACP definition");
    const reasons = Object.fromEntries(Object.entries(options.unsupported ?? {}).map(([leg, reason]) => [kind + ":" + leg, reason!]));
    assertAcpLegEnrollment([definition], reasons);
    if (!options.unsupported?.["native-mode-ack"] && !options.modeAcknowledgement) throw new Error(kind + ": mode acknowledgement fixture must be explicit");
  // The catalog chooses every real registration or explicit unsupported outcome; no kind is filtered away.
  const registrations: Record<AcpLeg, (kind: string) => void> = {
    "native-approval-rpc": kind => {
      test(`P4 ${kind}: real permission RPC approves exact hub identity once and asks on a lookalike`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "conformance-approval-")), asked: string[] = [], replies: string[] = [];
        const peer = createFromDefinition<AcpPeer>(definition, { acp: { cwd: dir, cmd: [process.execPath, fake, ...(options.agentArgs ?? [])],
          mcpServers: [{ name: "agent-hub", command: "unused", args: [], env: [] }],
          autoApprove: title => title === "mcp__agent-hub__hub_task_list" || title === "mcp__agent-hub__hub_send",
          onPermission: async request => { asked.push(request.title); return "no"; } } });
        peer.onMessage = text => { replies.push(text); };
        try {
          await peer.start();
          await peer.deliver([newEnvelope("user", options.permissionPrompts?.accepted ?? "PERMISSION HUBTOOL")]);
          await until(() => replies.length === 1 && peer.state === "idle", "autoapproved permission settled");
          expect(replies[0]).toEndWith("permission=yes"); expect(asked).toEqual([]);
          await peer.deliver([newEnvelope("user", options.permissionPrompts?.foreign ?? "PERMISSION SPOOF")]);
          await until(() => replies.length === 2 && peer.state === "idle", "lookalike permission settled");
          expect(asked).toHaveLength(1); expect(replies[1]).toEndWith("permission=no");
          await peer.setPermissionMode("never-ask"); expect(peer.permissionModeState).toBe("never-ask");
          await peer.setPermissionMode("ask"); expect(peer.permissionModeState).toBe("ask");
        } finally { await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
      }, 20_000);
    },
    "native-mode-ack": kind => {
      const modeAcknowledgement = options.modeAcknowledgement;
      if (!modeAcknowledgement) throw new Error(kind + ": mode acknowledgement fixture must be explicit");
      test(`P4 ${kind}: unconfirmed mode change goes unknown/offline despite a late acknowledgement`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "conformance-mode-")), pid = join(dir, "pid"), ack = join(dir, "ack");
        const peer = createFromDefinition<AcpPeer>(definition, { acp: { cwd: dir, cmd: [process.execPath, fake, ...(options.agentArgs ?? []), "--ignore-term", "--mode-delay-ms", "200", "--mode-ack-record", ack, "--record-pid", pid],
          permissionModeTimeoutMs: 40 } });
        try {
          // Qwen reconciles its default at startup; Kimi's unchanged ask default needs no initial request.
          if (options.startupModeAcknowledgement) await expect(peer.start()).rejects.toThrow("unknown");
          else { await peer.start(); await expect(peer.setPermissionMode("never-ask")).rejects.toThrow("unknown"); }
          expect(peer.permissionModeState).toBe("unknown"); expect(peer.state).toBe("offline");
          expect(readFileSync(ack, "utf8").trim()).toBe(modeAcknowledgement);
          const owned = Number(readFileSync(pid, "utf8")), table = processTable();
          expect(table).toBeDefined(); expect(table!.some(row => row.pid === owned || row.pgid === owned)).toBe(false);
          await expect(peer.setPermissionMode("ask")).rejects.toThrow("unknown");
          await expect(peer.deliver([newEnvelope("user", "must not start")])).rejects.toThrow("offline");
        } finally { await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
      }, 20_000);
    },
    "native-quota": kind => {
      test(`P4 ${options.quotaLabel ?? kind}: confirmed pre-activity quota pause settles failed_safe, not an ordinary failure`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "conformance-quota-")), receipts: DeliveryReceipt[] = [], order: string[] = [], failures: string[] = [];
        const peer = createFromDefinition<AcpPeer>(definition, { acp: { cwd: dir, cmd: [process.execPath, fake, ...(options.agentArgs ?? []), "--quota-refusal"],
          onQuotaRefusal: () => { order.push("paused"); return true; }, onTurnFailure: (_envs, reason) => { failures.push(reason); } } });
        peer.onDelivery = receipt => { receipts.push(receipt); order.push(receipt.state); };
        try {
          await peer.start(); await peer.deliver([newEnvelope("user", "QUOTA_REFUSAL")], "quota");
          await until(() => receipts.length > 0, "quota refusal receipt");
          expect(order).toEqual(["paused", "failed_safe"]); expect(receipts[0]).toMatchObject({ id: "quota", state: "failed_safe", quota: true }); expect(failures).toEqual([]);
        } finally { await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
      });
    },
    "watchdog-generation": kind => {
      test(`P4 ${options.watchdogLabel ?? kind}: watchdog cancellation fences the consumed late native result by turn generation`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "conformance-watchdog-")), receipts: DeliveryReceipt[] = [], messages: string[] = [];
        const peer = createFromDefinition<AcpPeer>(definition, { acp: { cwd: dir, cmd: [process.execPath, fakePaths.acpWatchdog, ...(options.agentArgs ?? [])] } });
        peer.onDelivery = receipt => { receipts.push(receipt); }; peer.onMessage = text => { messages.push(text); };
        try {
          await peer.start(); await peer.deliver([newEnvelope("user", "ACK_SLOW")], "old");
          await until(() => receipts.some(receipt => receipt.state === "accepted"), "native acceptance before explicit expiry");
          expire(peer);
          await until(() => receipts.some(receipt => receipt.state === "needs_review"), "watchdog uncertainty");
          // The fake responds to this mode request after sending the old prompt result on the same stdio stream.
          await peer.setPermissionMode("ask");
          expect(receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
          expect(messages).toEqual([]); expect(peer.state).toBe("offline");
        } finally { await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
      });
    },
  };

  for (const leg of ACP_LEGS) {
    const reason = options.unsupported?.[leg];
    if (reason !== undefined) test(`P4 ${kind}: ${leg} explicitly unsupported by its native transport`, () => {
      expect(reason.trim()).not.toBeEmpty();
    });
    else registrations[leg](kind);
}
}
