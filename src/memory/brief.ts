import type { PeerId } from "../hub/envelope.ts";
import type { MemoryClient } from "./client.ts";

export interface BriefItem {
  id: number;
  time: string;
  type: string;
  title: string;
}

/** Rows of claude-mem's index tables: `| #65499 | 12:30 PM | ◆ | Title | ~372 |`. A row that does not match is skipped, never an error. */
export function parseRows(markdown: string | undefined): BriefItem[] {
  const out: BriefItem[] = [];
  for (const m of (markdown ?? "").matchAll(/^\|\s*#(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|/gm)) {
    out.push({ id: Number(m[1]), time: m[2]!, type: m[3]!, title: m[4]!.replace(/\s*<-\s*\*\*ANCHOR\*\*/, "") });
  }
  return out;
}

/**
 * Task briefs: what memory already knows about a piece of work, handed over with it. Index first (search), then the
 * neighbourhood of the top hit (timeline); details stay in claude-mem for the receiver to fetch by id. A peer is never
 * shown the same observation twice in one hub run.
 */
export class Briefs {
  private readonly seen = new Map<PeerId, Set<number>>();

  constructor(
    private readonly client: MemoryClient,
    private readonly project: string,
    private readonly maxItems = 8,
  ) {}

  async forTask(peer: PeerId, task: { title: string; refs: { paths?: string[] } }): Promise<string | undefined> {
    const query = [task.title, ...(task.refs.paths ?? [])].join(" ").slice(0, 300);
    const hits = parseRows(await this.client.search(query, this.project, 10));
    if (!hits.length) return undefined;
    const around = parseRows(await this.client.timeline(hits[0]!.id, this.project));
    const seen = this.seen.get(peer) ?? new Set<number>();
    this.seen.set(peer, seen);
    const items: BriefItem[] = [];
    for (const item of [...hits, ...around]) {
      if (seen.has(item.id) || items.some((i) => i.id === item.id)) continue;
      items.push(item);
      if (items.length === this.maxItems) break;
    }
    if (!items.length) return undefined;
    for (const item of items) seen.add(item.id);
    return ["Memory brief (claude-mem; fetch details by id if you need them):", ...items.map((i) => `#${i.id} ${i.time} ${i.type} ${i.title}`)].join("\n");
  }
}
