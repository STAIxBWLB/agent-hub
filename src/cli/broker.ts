/** Person-only command; main.ts performs identity/delegation refusal before importing this module. */
import { join, resolve } from "node:path";
import { BrokerStoreError } from "../broker/store.ts";
import { RoomCryptoError } from "../rooms/crypto.ts";
import { startBroker, BrokerServerError, type BrokerOptions } from "../broker/server.ts";

export const BROKER_USAGE = "usage: ahub broker serve [--hostname <host>] [--port <0..65535>] [--public-url <ws[s]://host/>] [--state-dir <dir>]";
export function brokerOptions(args: readonly string[], stateDir: string): BrokerOptions {
  if (args[0] !== "serve" || (args.length - 1) % 2 !== 0) throw new Error(BROKER_USAGE);
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--hostname", "--port", "--public-url", "--state-dir"].includes(key) || !value || value.startsWith("--") || flags.has(key)) throw new Error(BROKER_USAGE);
    flags.set(key, value);
  }
  const portText = flags.get("--port") ?? "8788";
  if (!/^(0|[1-9][0-9]{0,4})$/.test(portText) || Number(portText) > 65535) throw new Error(BROKER_USAGE);
  return { stateDir: flags.has("--state-dir") ? resolve(flags.get("--state-dir")!) : join(stateDir, "broker"), hostname: flags.get("--hostname") ?? "127.0.0.1", port: Number(portText), ...(flags.has("--public-url") ? { publicUrl: flags.get("--public-url")! } : {}) };
}
export async function runBrokerCommand(args: readonly string[], stateDir: string): Promise<void> {
  const options = brokerOptions(args, stateDir);
  const broker = await startBroker(options);
  console.log(`broker listening at ${broker.publicUrl} (ciphertext relay; application delivery is not acknowledged here)`);
  const stop = () => { void broker.stop().catch(() => { process.exitCode = 1; console.error("broker: stop failed"); }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await broker.closed; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
export function brokerCommandError(error: unknown): string {
  if (error instanceof Error && error.message === BROKER_USAGE) return BROKER_USAGE;
  if (error instanceof BrokerServerError || error instanceof BrokerStoreError) return `broker: ${error.code}`;
  if (error instanceof RoomCryptoError && error.code === "unavailable") return "broker: crypto_unavailable";
  return "broker: startup failed";
}
