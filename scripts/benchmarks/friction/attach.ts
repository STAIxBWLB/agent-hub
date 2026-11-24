// Friction peer attachment (#1644 T3): a no-model peer that stays attached to the isolated hub until it is killed, so a journey can have
// an owner and a reviewer. It speaks the control protocol through the MEASURED binary's own client. It answers nothing and never works.
// Run as `bun attach.ts <entry> <peer>` inside the isolated project; it prints `attached` once the hub has accepted it.
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [entry, peer] = process.argv.slice(2);
if (!entry || !peer) { console.error("usage: attach.ts <entry> <peer>"); process.exit(2); }
const root = resolve(dirname(resolve(entry)), "..");
const { ControlClient, stateDirFor } = await import(pathToFileURL(join(root, "hub/control-client.ts")).href);
const client = await ControlClient.connect(stateDirFor(process.cwd()), { role: "peer", peer, projectRoot: process.cwd() });
client.onPush = () => {};
console.log("attached");
await new Promise<void>(() => {});
