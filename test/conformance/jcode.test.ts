import { definitionOf } from "../../src/adapters/registry.ts";
import { registerOwnedAcpConformance } from "../../src/adapters/conformance/owned-acp.ts";
import { UNSUPPORTED_LEGS } from "./enrollment.ts";
registerOwnedAcpConformance(definitionOf("jcode")!, { label: "Jcode", unmanagedReason: UNSUPPORTED_LEGS["jcode:native-mode-ack"] });
