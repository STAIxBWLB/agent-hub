import { fileURLToPath } from "node:url";

/** Shipped assets are resolved without importing or executing their native protocol loops. */
export const fakePaths = Object.freeze({
  acpServer: fileURLToPath(new URL("./fakes/acp-server.ts", import.meta.url)),
  appServer: fileURLToPath(new URL("./fakes/app-server.ts", import.meta.url)),
  modelServer: fileURLToPath(new URL("./fakes/model-server.ts", import.meta.url)),
  piRpc: fileURLToPath(new URL("./fakes/pi-rpc.ts", import.meta.url)),
  jcodeAgent: fileURLToPath(new URL("./fakes/jcode-agent.ts", import.meta.url)),
  codexBin: fileURLToPath(new URL("./fakes/codex-bin.ts", import.meta.url)),
  acpWatchdog: fileURLToPath(new URL("./fakes/acp-watchdog-agent.ts", import.meta.url)),
});
