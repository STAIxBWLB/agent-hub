import type { BusEvent } from "../hub/bus.ts";

export function renderTailEvent(e: BusEvent): string {
  if (e.t === "state") return `  . ${e.peer} is ${e.state}`;
  if (e.t === "undeliverable") return `  ! gave up delivering ${e.env.id} (from ${e.env.from}) to ${e.peer}`;
  if (e.t === "envelope" && e.env.from === "hub" && e.env.kind !== "chat") {
    return `${new Date(e.env.ts).toLocaleTimeString()} hub -> ${e.env.to?.join(",")} [${e.env.kind}${e.env.refs?.task ? ` #${e.env.refs.task}` : ""}]\n${e.env.body.split("\n")[0]!.replace(/^/, "    ")}`;
  }
  if (e.t === "overflow") return `  ! ${e.peer}'s queue is full: dropped ${e.env.id} (from ${e.env.from})`;
  if (e.t === "stale") return `  . dropped ${e.env.id} (from ${e.env.from}) for ${e.peer}: ${e.reason}`;
  if (e.t === "quiet") return `  . ${e.env.id} (from ${e.env.from}) not delivered to ${e.peers.join(", ")}: turn-free cohort`;
  const { env } = e;
  const note = e.dropped === "hop" ? " [not delivered: hop limit]" : e.dropped === "fyi" ? " [fyi: record only]" : "";
  const head = `${env.from} -> ${env.to?.join(",") ?? "*"}${env.priority === "important" ? " !" : ""}${note}`;
  return `${new Date(env.ts).toLocaleTimeString()} ${head}\n${env.body.replace(/^/gm, "    ")}`;
}

