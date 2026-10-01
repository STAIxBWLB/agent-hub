import type { StampedEvent } from "./events.ts";

export interface Report {
  from?: string;
  to?: string;
  peers: Record<string, { turns: number; busyMinutes: number; tokens: number }>;
  messages: { total: number; dropped: Record<string, number>; overflow: number; undeliverable: number; perTask: number };
  overlaps: { warnings: number; pairs: number };
  tasks: Record<string, number>;
  quota: { readings: number; hard: number };
}

/** The numbers `ahub report` prints, from `events.jsonl` alone (issue #40). */
export function summarize(events: StampedEvent[]): Report {
  const r: Report = { peers: {}, messages: { total: 0, dropped: {}, overflow: 0, undeliverable: 0, perTask: 0 }, overlaps: { warnings: 0, pairs: 0 }, tasks: {}, quota: { readings: 0, hard: 0 } };
  const peer = (id: string) => (r.peers[id] ??= { turns: 0, busyMinutes: 0, tokens: 0 });
  const pairs = new Set<string>();
  const taskMessages = new Map<string, number>();
  for (const e of events) {
    r.from ??= e.at;
    r.to = e.at;
    switch (e.type) {
      case "envelope":
        r.messages.total++;
        if (e.dropped) r.messages.dropped[e.dropped] = (r.messages.dropped[e.dropped] ?? 0) + 1;
        if (e.task) taskMessages.set(e.task, (taskMessages.get(e.task) ?? 0) + 1);
        break;
      case "overflow":
      case "undeliverable":
        r.messages[e.type]++;
        break;
      case "turn_end":
        peer(e.peer).turns++;
        peer(e.peer).busyMinutes += e.ms / 60_000;
        break;
      case "tokens":
        peer(e.peer).tokens += e.n;
        break;
      case "task":
        r.tasks[e.event] = (r.tasks[e.event] ?? 0) + 1;
        break;
      case "overlap":
        r.overlaps.warnings++;
        for (const o of e.others) pairs.add([e.task, o.task].sort((a, b) => a - b).join("-"));
        break;
      case "quota":
        r.quota.readings++;
        if (e.hard) r.quota.hard++;
        break;
    }
  }
  r.overlaps.pairs = pairs.size;
  r.messages.perTask = taskMessages.size ? Number(([...taskMessages.values()].reduce((a, b) => a + b, 0) / taskMessages.size).toFixed(1)) : 0;
  for (const p of Object.values(r.peers)) p.busyMinutes = Number(p.busyMinutes.toFixed(1));
  return r;
}

export function formatReport(r: Report): string[] {
  const lines = [`period: ${r.from ?? "-"} .. ${r.to ?? "-"}`];
  for (const [id, p] of Object.entries(r.peers).sort()) lines.push(`peer ${id}: ${p.turns} turns, ${p.busyMinutes} busy minutes, ${p.tokens || "-"} tokens`);
  const dropped = Object.entries(r.messages.dropped).map(([k, n]) => `${n} ${k}`).join(", ");
  lines.push(`messages: ${r.messages.total} (dropped: ${dropped || "none"}; overflow ${r.messages.overflow}; undeliverable ${r.messages.undeliverable}); ${r.messages.perTask} per task that had any`);
  lines.push(`overlap warnings: ${r.overlaps.warnings}, task pairs: ${r.overlaps.pairs}`);
  const tasks = Object.entries(r.tasks).sort().map(([k, n]) => `${k} ${n}`).join(", ");
  lines.push(`task events: ${tasks || "none"}`);
  lines.push(`quota readings: ${r.quota.readings} (${r.quota.hard} hard limits)`);
  return lines;
}
