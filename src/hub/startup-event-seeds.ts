import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { parseEventLine, type StampedEvent } from "./events.ts";
import { segmentsOf } from "./log-rotation.ts";

const STARTUP_EVENT_BUFFER_BYTES = 64 * 1024;
export interface StartupEventSeeds {
  events: StampedEvent[];
  /** False if any nonblank record was malformed or the journal ended in a partial row. */
  complete: boolean;
  nativeStopsSeen: Set<string>;
  claudeNativeUsageSeen: Set<string>;
  readPasses: number;
  readBytes: number;
}

/** One streaming pass, retaining every accepted row and every historical dedupe key. */
export function readStartupEventSeeds(file: string, options: { bufferBytes?: number } = {}): StartupEventSeeds {
  const seeds: StartupEventSeeds = { events: [], complete: true, nativeStopsSeen: new Set(), claudeNativeUsageSeen: new Set(), readPasses: 0, readBytes: 0 };
  const segments = segmentsOf(file); // #1546: rotated segments first, then the live file, so a restart still sees every dedupe key the kept history holds
  if (!segments.length) return seeds;
  // Host-only chunk-boundary test seam, never a line, history or total-byte ceiling.
  const bufferBytes = options.bufferBytes ?? STARTUP_EVENT_BUFFER_BYTES;
  if (!Number.isSafeInteger(bufferBytes) || bufferBytes < 1) throw new Error("startup event buffer must be a positive integer; use the default reader buffer");
  const decoder = new StringDecoder("utf8"), buffer = Buffer.alloc(bufferBytes);
  let parts: string[] = [];
  const accept = (line: string) => {
    const event = parseEventLine(line);
    if (event === undefined) { if (line.trim()) seeds.complete = false; return; }
    seeds.events.push(event);
    // Keep the same predicates as the former three readEvents consumers, including legacy malformed IDs.
    if (event.type === "native_turn_end" && event.id) seeds.nativeStopsSeen.add(event.id);
    if (event.type === "usage" && event.source === "claude_transcript") seeds.claudeNativeUsageSeen.add((event as { id: string }).id);
  };
  const consume = (text: string) => {
    let start = 0;
    for (let end = text.indexOf("\n", start); end >= 0; end = text.indexOf("\n", start)) {
      parts.push(text.slice(start, end)); accept(parts.join("")); parts = []; start = end + 1;
    }
    if (start < text.length) parts.push(text.slice(start));
  };
  seeds.readPasses++;
  for (const segment of segments) {
    let fd: number;
    try { fd = openSync(segment.path, "r"); } catch { seeds.complete = false; continue; }
    try {
      for (;;) {
        const bytes = readSync(fd, buffer, 0, buffer.length, null);
        if (!bytes) break;
        seeds.readBytes += bytes;
        consume(decoder.write(buffer.subarray(0, bytes)));
      }
      consume(decoder.end());
    } finally { closeSync(fd); }
    // readEvents also accepts a complete final JSON record without a newline.
    if (parts.length) { seeds.complete = false; accept(parts.join("")); parts = []; }
  }
  return seeds;
}
