import type { KimiWireRow } from "../adapters/kimi-wire-usage.ts";
import type { HubEvent } from "./events.ts";
import { kimiRowTotal } from "../adapters/kimi-wire-usage.ts";
import type { KimiRowAttribution } from "./kimi-usage.ts";

export interface KimiEventPorts {
  append(event: HubEvent): boolean;
  read(): readonly HubEvent[];
}

/** Exactly-once Kimi usage events, including a retry after only one of the two records was appended. */
export class KimiEventWriter {
  private readonly tokens = new Set<string>();
  private readonly usage = new Set<string>();
  private readonly attributions = new Map<string, KimiRowAttribution>();
  private dirty = false;

  constructor(private readonly ports: KimiEventPorts, events: readonly HubEvent[] = []) { this.seed(events); }

  private seed(events: readonly HubEvent[]): void {
    for (const event of events) {
      if (event.type === "tokens" && event.source === "kimi_wire" && event.id) this.tokens.add(event.id);
      else if (event.type === "usage" && event.source === "kimi_wire") this.usage.add(event.id);
      else continue;
      if (event.id && event.attribution && !this.attributions.has(event.id)) this.attributions.set(event.id, { attribution: { task: event.task, attribution: event.attribution, ...(event.pii ? { pii: true } : {}) } });
    }
  }

  write(peer: string, row: KimiWireRow, counted: number, attributed: KimiRowAttribution): void {
    if (this.dirty) { this.seed(this.ports.read()); this.dirty = false; }
    const stable = this.attributions.get(row.id) ?? attributed;
    this.attributions.set(row.id, stable);
    if (!this.tokens.has(row.id)) {
      const committed = this.ports.append({ type: "tokens", peer, source: "kimi_wire", id: row.id, n: counted, ...stable.attribution });
      if (!committed) { this.dirty = true; throw new Error("Kimi tokens event commit failed"); }
      this.tokens.add(row.id);
    }
    if (!this.usage.has(row.id)) {
      const committed = this.ports.append({ type: "usage", peer, source: "kimi_wire", id: row.id, measuredAt: new Date(row.at).toISOString(), inputTokens: row.inputOther, outputTokens: row.output,
        cacheReadTokens: row.inputCacheRead, cacheWriteTokens: row.inputCacheCreation, totalTokens: kimiRowTotal(row),
        ...stable.attribution, ...(row.model ? { servedModel: row.model } : {}) });
      if (!committed) { this.dirty = true; throw new Error("Kimi usage event commit failed"); }
      this.usage.add(row.id);
    }
  }
}
