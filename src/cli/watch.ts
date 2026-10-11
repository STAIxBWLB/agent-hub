import type { Activity } from "../hub/activity.ts";
import { paint, stateTone, terminalText, wrap } from "./console-state.ts";

export function renderActivity(peer: string, item: Activity, columns: number, color: boolean, noThoughts = false): string[] {
  if (noThoughts && item.kind === "thought") return [];
  const width = Math.max(20, Math.floor(columns));
  const time = new Date(item.at).toISOString().slice(11, 19);
  const header = `${time} ${peer} ${item.kind} (turn ${item.turn})`;
  const tone = item.kind === "turn_end" ? stateTone("idle") : "info";
  return [...wrap(header, width).map(text => paint([{ text, tone }], color)),
    ...wrap(terminalText(item.text), width - 4, 0).map(text => paint([{ text: `    ${text}` }], color))];
}
export interface WatchClient {
  request(msg: Record<string, unknown>): Promise<any>;
  onPush: (msg: any) => void;
  onClose: (code: number, reason: string) => void;
  close(): void;
}
/** This view only watches and reads status. No prompt, permission or command request exists here. */
export async function attachWatch(client: WatchClient, peer: string, write: (text: string) => void, options: { columns: () => number; color: boolean; noThoughts: boolean }): Promise<void> {
  client.onPush = msg => {
    if (msg.t !== "activity" || msg.peer !== peer || !msg.item || typeof msg.item.text !== "string" || !Number.isFinite(msg.item.at) || !Number.isSafeInteger(msg.item.turn)) return;
    for (const line of renderActivity(peer, msg.item, options.columns(), options.color, options.noThoughts)) write(line);
  };
  const watched = await client.request({ t: "watch", peer });
  if (watched.ok !== true) throw new Error(watched.error ?? "hub does not support watch; upgrade it before using this view");
  const status = await client.request({ t: "status" });
  if (status.ok === false) throw new Error(status.error ?? "watch connection closed");
  const row = status.peers?.[peer];
  if (row) for (const line of wrap(`${peer}: ${row.state ?? "unknown"}; context ${row.context?.used ?? "unknown"}; q or Ctrl+C quits (approvals: ahub console)`, options.columns())) write(line);
}
