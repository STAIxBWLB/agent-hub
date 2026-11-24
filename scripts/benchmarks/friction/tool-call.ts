// Friction tool-call step (#1644 T3). Run inside the isolated project as `bun tool-call.ts <entry> <peer> <tool> [json args]`.
// It speaks the control protocol through the MEASURED binary's own client (read from the entry's tree), so an old release and the
// current build run the same corpus and the runner itself imports no product code for it. A refusal envelope is `{ ok: false, error }`:
// it is printed to stderr and exits 1, so it is a block like a non-zero CLI exit; a success prints its text and exits 0.
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [entry, peer, tool, raw] = process.argv.slice(2);
if (!entry || !peer || !tool) { console.error("usage: tool-call.ts <entry> <peer> <tool> [json args]"); process.exit(2); }
const root = resolve(dirname(resolve(entry)), "..");
const { ControlClient, stateDirFor } = await import(pathToFileURL(join(root, "hub/control-client.ts")).href);
// `console` is the person's own seat; any other name is a tools-role peer.
const client = await ControlClient.connect(stateDirFor(process.cwd()), peer === "console" ? { role: "console", projectRoot: process.cwd() } : { role: "tools", peer, projectRoot: process.cwd() });
try {
  const reply = await client.request({ t: "task", op: tool, args: raw ? JSON.parse(raw) : {} }, 30_000);
  if (reply.ok) console.log(String(reply.text ?? ""));
  else { console.error(`refused: ${String(reply.error)}`); process.exitCode = 1; }
} finally { client.close(); }
