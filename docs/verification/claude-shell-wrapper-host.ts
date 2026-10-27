// Model-free native receipt fixture. Run by claude-shell-wrapper-native.py, never by production startup.
import { readFileSync } from "node:fs";
import { createHostShellWrapper } from "../../src/hub/claude-shell-wrapper.ts";
import { hostShellEnvironment } from "../../src/local/shell-environment.ts";
import { realPath } from "../../src/hub/project.ts";

const fixture = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { root: string; executable: string };
const root = realPath(fixture.root), executable = realPath(fixture.executable), signal = new AbortController();
const wrapper = await createHostShellWrapper();
const command = wrapper.issue({ peer: "claude-fixture", task: 1, generation: "native-fixture:1", root, branch: "fixture/task", executable, argv: [],
  env: hostShellEnvironment({ AGENTHUB_PEER_ID: "claude-fixture" }), signal: signal.signal, timeoutMs: 5000,
  current: () => !signal.signal.aborted && realPath(fixture.root) === root && realPath(fixture.executable) === executable });
if (!command) throw new Error("host receipt fixture refused");
process.stdout.write(`${JSON.stringify(command)}\n`);
let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => { signal.abort(); await wrapper.close(); })();
process.on("SIGTERM", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
process.on("SIGINT", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
for await (const _chunk of process.stdin) { /* Parent ownership pipe, not command input. */ }
await close();
