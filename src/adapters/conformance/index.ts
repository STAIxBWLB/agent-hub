/** Bun test registration kit. Importing this entry registers no suite and starts no native transport. */
export { registerConformance, registerExternalChannelConformance, until, type AdapterConformance, type ConformanceFixture } from "./kit.ts";
export { registerAcpConformance, type AcpConformanceOptions } from "./acp.ts";
export { registerCodexConformance } from "./codex.ts";
export { registerOwnedAcpConformance } from "./owned-acp.ts";
export { registerLocalConformance, registerPiConformance } from "./local-pi.ts";
export { createFromDefinition, expire } from "./factories.ts";
export { ACP_LEGS, assertAcpLegEnrollment, assertEnrollment, definitionIdentities, type AcpLeg } from "./enrollment.ts";
export { fakePaths } from "./fake-paths.ts";
export { startFakeAppServer } from "./fakes/app-server.ts";
export { startFakeModelServer, toolCall, type Script } from "./fakes/model-server.ts";
