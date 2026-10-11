import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[process.argv.indexOf("--session-dir") + 1]!;
mkdirSync(dir, { recursive: true });
const sessionFile = join(dir, "readonly-pi.jsonl");
writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "readonly-pi", cwd: process.cwd() }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  const data = msg.type === "get_state" ? { sessionId: "readonly-pi", sessionFile } : undefined;
  process.stdout.write(JSON.stringify({ id: msg.id, success: true, ...(data ? { data } : {}) }) + "\n");
}
