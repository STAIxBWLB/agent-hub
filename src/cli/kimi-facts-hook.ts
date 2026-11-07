#!/usr/bin/env bun
import { factsHook } from "./facts-hook.ts";

try {
  const stateDir = process.env.AGENTHUB_STATE_DIR, event = process.argv[2];
  const out = stateDir && event ? await factsHook(await Bun.stdin.text(), stateDir, process.env.AGENTHUB_PEER_ID ?? "kimi", 2000, event) : undefined;
  if (out) console.log(out);
} catch {
  // Native hooks fail open; a missing or refused observation never changes the turn.
}
process.exit(0);
