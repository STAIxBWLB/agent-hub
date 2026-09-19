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

/** Index first, then the neighbourhood of the top hit: the retrieval both task briefs and `ahub ask` use. Deduplicated, in order. */
export async function related(client: MemoryClient, project: string, query: string, around = 3): Promise<BriefItem[]> {
  const hits = parseRows(await client.search(query.slice(0, 300), project, 10));
  if (!hits.length) return [];
  const near = parseRows(await client.timeline(hits[0]!.id, project, around, around));
  const out: BriefItem[] = [];
  for (const item of [...hits, ...near]) if (!out.some((o) => o.id === item.id)) out.push(item);
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
    const found = await related(this.client, this.project, [task.title, ...(task.refs.paths ?? [])].join(" "));
    if (!found.length) return undefined;
    const seen = this.seen.get(peer) ?? new Set<number>();
    this.seen.set(peer, seen);
    const items: BriefItem[] = [];
    for (const item of found) {
      if (seen.has(item.id)) continue;
      items.push(item);
      if (items.length === this.maxItems) break;
    }
    if (!items.length) return undefined;
    for (const item of items) seen.add(item.id);
    return ["Memory brief (claude-mem; fetch details by id if you need them):", ...items.map((i) => `#${i.id} ${i.time} ${i.type} ${i.title}`)].join("\n");
  }
}
