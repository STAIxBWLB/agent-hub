import { ADAPTERS } from "../../src/adapters/registry.ts";
import { registerAcpConformance } from "../../src/adapters/conformance/acp.ts";
import { ACP_LEGS, UNSUPPORTED_LEGS, assertAcpLegEnrollment } from "./enrollment.ts";
assertAcpLegEnrollment(ADAPTERS, UNSUPPORTED_LEGS);
for (const definition of ADAPTERS.filter(candidate => candidate.transport === "acp")) {
  const kind = definition.kind, qwen = kind === "qwen";
  registerAcpConformance({
    definition,
    agentArgs: qwen ? ["--agent-name", "qwen-code", "--agent-version", "0.25.0", "--modes", "default,auto-edit,yolo"] : [],
    startupModeAcknowledgement: qwen, modeAcknowledgement: qwen ? "default" : "auto",
    ...(qwen ? { permissionPrompts: { accepted: "PERMISSION QWEN", foreign: "PERMISSION QWEN FOREIGN" } } : {}),
    ...(kind === "kimi" ? { quotaLabel: "Kimi", watchdogLabel: "ACP" } : {}),
    unsupported: Object.fromEntries(ACP_LEGS.flatMap(leg => {
      const reason = UNSUPPORTED_LEGS[kind + ":" + leg];
      return reason === undefined ? [] : [[leg, reason]];
    })),
  });
}
