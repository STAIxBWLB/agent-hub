import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AcpPeer } from "../../src/adapters/acp.ts";
import { newEnvelope } from "../../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../../src/hub/peers.ts";
import { processTable } from "../../src/hub/child-process.ts";
import { until } from "./kit.ts";
import { ADAPTERS } from "../../src/adapters/registry.ts";
import { createRegisteredPeer, expire } from "./factories.ts";
import { ACP_LEGS, UNSUPPORTED_LEGS, assertAcpLegEnrollment, type AcpLeg } from "./enrollment.ts";

const fake = join(import.meta.dir, "../fakes/acp-server.ts");
const nativeArgs = (kind: string) => kind === "qwen" ? ["--agent-name", "qwen-code", "--agent-version", "0.25.0", "--modes", "default,auto-edit,yolo"] : [];

// The catalog chooses every real registration or explicit unsupported outcome; no kind is filtered away.
const registrations: Record<AcpLeg, (kind: string) => void> = {
  "native-approval-rpc": kind => {
    test(`P4 ${kind}: real permission RPC approves exact hub identity once and asks on a lookalike`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "conformance-approval-")), asked: string[] = [], replies: string[] = [];
      const peer = createRegisteredPeer<AcpPeer>(kind, { acp: { cwd: dir, cmd: [process.execPath, fake, ...nativeArgs(kind)], qwen025: kind === "qwen",
        mcpServers: [{ name: "agent-hub", command: "unused", args: [], env: [] }],
        autoApprove: title => title === "mcp__agent-hub__hub_task_list" || title === "mcp__agent-hub__hub_send",
        onPermission: async request => { asked.push(request.title); return "no"; } } });
      peer.onMessage = text => { replies.push(text); };
      try {
        await peer.start();
        await peer.deliver([newEnvelope("user", kind === "qwen" ? "PERMISSION QWEN" : "PERMISSION HUBTOOL")]);
        await until(() => replies.length === 1 && peer.state === "idle", "autoapproved permission settled");
        expect(replies[0]).toEndWith("permission=yes"); expect(asked).toEqual([]);
        await peer.deliver([newEnvelope("user", kind === "qwen" ? "PERMISSION QWEN FOREIGN" : "PERMISSION SPOOF")]);
        await until(() => replies.length === 2 && peer.state === "idle", "lookalike permission settled");
        expect(asked).toHaveLength(1); expect(replies[1]).toEndWith("permission=no");
        await peer.setPermissionMode("never-ask"); expect(peer.permissionModeState).toBe("never-ask");
        await peer.setPermissionMode("ask"); expect(peer.permissionModeState).toBe("ask");
      } finally { await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
    }, 20_000);
  },
  "native-mode-ack": kind => {
    test(`P4 ${kind}: unconfirmed mode change goes unknown/offline despite a late acknowledgement`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "conformance-mode-")), pid = join(dir, "pid"), ack = join(dir, "ack");
      const peer = createRegisteredPeer<AcpPeer>(kind, { acp: { cwd: dir, cmd: [process.execPath, fake, ...nativeArgs(kind), "--ignore-term", "--mode-delay-ms", "200", "--mode-ack-record", ack, "--record-pid", pid],
        qwen025: kind === "qwen", permissionModeTimeoutMs: 40 } });
      try {
        // Qwen reconciles its default at startup; Kimi's unchanged ask default needs no initial request.
        if (kind === "qwen") await expect(peer.start()).rejects.toThrow("unknown");
        else { await peer.start(); await expect(peer.setPermissionMode("never-ask")).rejects.toThrow("unknown"); }
        expect(peer.permissionModeState).toBe("unknown"); expect(peer.state).toBe("offline");
        expect(readFileSync(ack, "utf8").trim()).toBe(kind === "qwen" ? "default" : "auto");
        const owned = Number(readFileSync(pid, "utf8")), table = processTable();
        expect(table).toBeDefined(); expect(table!.some(row => row.pid === owned || row.pgid === owned)).toBe(false);
        await expect(peer.setPermissionMode("ask")).rejects.toThrow("unknown");
        await expect(peer.deliver([newEnvelope("user", "must not start")])).rejects.toThrow("offline");
      } finally { await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
    }, 20_000);
  },
  "native-quota": kind => {
    test(kind === "kimi" ? "P4 Kimi: confirmed pre-activity quota pause settles failed_safe, not an ordinary failure" : `P4 ${kind}: confirmed pre-activity quota pause settles failed_safe, not an ordinary failure`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "conformance-quota-")), receipts: DeliveryReceipt[] = [], order: string[] = [], failures: string[] = [];
      const peer = createRegisteredPeer<AcpPeer>(kind, { acp: { cwd: dir, cmd: [process.execPath, fake, "--quota-refusal"],
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
    test(kind === "kimi" ? "P4 ACP: watchdog cancellation fences the consumed late native result by turn generation" : `P4 ${kind}: watchdog cancellation fences the consumed late native result by turn generation`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "conformance-watchdog-")), receipts: DeliveryReceipt[] = [], messages: string[] = [];
      const peer = createRegisteredPeer<AcpPeer>(kind, { acp: { cwd: dir, cmd: [process.execPath, join(import.meta.dir, "acp-watchdog-agent.ts"), ...nativeArgs(kind)] } });
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

assertAcpLegEnrollment(ADAPTERS, UNSUPPORTED_LEGS);
for (const definition of ADAPTERS.filter(candidate => candidate.transport === "acp")) {
  for (const leg of ACP_LEGS) {
    const reason = UNSUPPORTED_LEGS[`${definition.kind}:${leg}`];
    if (reason !== undefined) test(`P4 ${definition.kind}: ${leg} explicitly unsupported by its native transport`, () => {
      expect(reason.trim()).not.toBeEmpty();
    });
    else registrations[leg](definition.kind);
  }
}
