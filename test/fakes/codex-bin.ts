// Stands in for the codex binary in daemon tests: `codex app-server --listen ws://127.0.0.1:<port> ...` runs the fake
// app-server on that port. A test's wrapper script passes `--record <file>`, where each thread/revert is appended.
import { appendFileSync } from "node:fs";
import { startFakeAppServer } from "./app-server.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const record = arg("--record");
startFakeAppServer(30, Number(new URL(arg("--listen") ?? "ws://127.0.0.1:0").port), (params) => {
  if (record) appendFileSync(record, `${JSON.stringify(params)}\n`);
});
await new Promise(() => {}); // until the hub stops it
