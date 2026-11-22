import { exactForm } from "./instructed-exact.ts";

export interface IntentForm { argv: string[]; taskId?: number; targetPeer?: string; verdictIds?: string[]; review?: true }

/** Each id must occur as its own literal token; repeated ids need separate occurrences. */
export function literalInstructionIds(prompt: string, ids: readonly string[]): boolean {
  const used: { start: number; end: number }[] = [];
  for (const id of ids) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) return false;
    let at = prompt.indexOf(id), found = false;
    while (at >= 0) {
      const before = prompt[at - 1], after = prompt[at + id.length];
      if ((!before || !/[\p{L}\p{N}_-]/u.test(before)) && (!after || !/[\p{L}\p{N}_-]/u.test(after)) && !used.some(span => at < span.end && at + id.length > span.start)) {
        used.push({ start: at, end: at + id.length }); found = true; break;
      }
      at = prompt.indexOf(id, at + 1);
    }
    if (!found) return false;
  }
  return true;
}

/** Closed intent forms; child argv is passed directly, never to a shell. */
export function intentForm(argv: readonly string[]): IntentForm | undefined {
  if (!argv.length || argv.some(word => typeof word !== "string" || !word.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(word))) return;
  if (argv.some(word => word === "--as-user" || word.startsWith("--as-user=") || word === "--live-test" || word.startsWith("--live-test=") || word === "--project" || word.startsWith("--project="))) return;
  const [command, sub, ...tail] = argv;
  const exact = exactForm(argv);
  if (exact && (command === "task" && sub === "assign" || command === "backlog" && (sub === "pull" || sub === "return") || command === "model" || command === "stop")) return exact;
  const integer = (value: string | undefined) => !!value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  if (command === "task" && sub === "claim") {
    const [id, slot, verdict, ...extra] = tail;
    if (!extra.length && integer(id) && integer(slot) && ["supported", "unsupported", "unclear"].includes(verdict ?? "")) return { argv: [...argv], taskId: Number(id), verdictIds: [id!, slot!] };
  }
  if (command === "results" && argv.slice(1).every(word => ["--unread", "--json", "--full", "--color=auto", "--color=always", "--color=never"].includes(word))) return { argv: [...argv] };
  if (command === "capabilities" && argv.slice(1).every(word => ["--json", "--color=auto", "--color=always", "--color=never"].includes(word))) return { argv: [...argv] };
  if (command === "learn" && sub === "list" && tail.every(word => ["--all", "--json", "--color=auto", "--color=always", "--color=never"].includes(word))) return { argv: [...argv] };
  if (command === "learn" && ["accept", "reject"].includes(sub ?? "") && tail.length === 1 && integer(tail[0])) return { argv: [...argv], taskId: Number(tail[0]), verdictIds: [tail[0]!] };
  if (command === "review" && integer(sub)) {
    const [verdict, flag, head, ...extra] = tail;
    if (["approved", "changes_requested"].includes(verdict ?? "") && !extra.length && (flag === undefined && head === undefined || flag === "--head" && !!head && /^[a-f0-9]{40}$/.test(head))) return { argv: [...argv], taskId: Number(sub), verdictIds: [sub!], review: true };
  }
  return;
}

/** A closed family gets an explanation without echoing its operands. */
export function intentRefusal(argv: readonly string[]): string {
  const [command, sub] = argv;
  if (command === "role") return "role changes are trust settings and stay person-only";
  if (command === "task" && sub === "claim" && argv.includes("--manifest")) return "file-backed claim verdicts stay person-only";
  if (command === "task" && sub === "handoff") return "cross-project handoff lacks an instruction revocation fence";
  if (command === "backlog" && ["add", "split"].includes(sub ?? "")) return "task creation requires instruction-bound privacy screening";
  if (command === "study" && sub === "approve") return "study approval requires instruction-bound privacy screening";
  if (command === "roadmap" && sub === "state") return "roadmap verdicts lack retained instructed provenance";
  if (command === "title") return "titles contain free text, and an unnamed title cannot be restored";
  if (command === "backlog" && ["plan", "pin", "pull-ready"].includes(sub ?? "") || command === "review") return "this form contains free text or unclassified options";
  return "this form is not proven for instructed intent mode";
}
