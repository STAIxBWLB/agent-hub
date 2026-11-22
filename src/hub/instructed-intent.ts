import { parseStudyArgs } from "../cli/study.ts";
import { exactForm } from "./instructed-exact.ts";

export interface IntentForm { argv: string[]; taskId?: number; dependencyIds?: number[]; targetPeer?: string; verdictId?: string; review?: true }

/** An id is a literal token, never a substring of a different id. */
export function literalInstructionId(prompt: string, id: string): boolean {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) return false;
  let at = prompt.indexOf(id);
  while (at >= 0) {
    const before = prompt[at - 1], after = prompt[at + id.length];
    if ((!before || !/[\p{L}\p{N}_-]/u.test(before)) && (!after || !/[\p{L}\p{N}_-]/u.test(after))) return true;
    at = prompt.indexOf(id, at + 1);
  }
  return false;
}

/** Closed intent forms; child argv is passed directly, never to a shell. */
export function intentForm(argv: readonly string[]): IntentForm | undefined {
  if (!argv.length || argv.some(word => typeof word !== "string" || !word.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(word))) return;
  if (argv.some(word => word === "--as-user" || word.startsWith("--as-user=") || word === "--live-test" || word.startsWith("--live-test="))) return;
  const [command, sub, ...tail] = argv;
  if (argv.some(word => word === "--project" || word.startsWith("--project="))) return;
  const exact = exactForm(argv);
  if (exact && (command === "task" && sub === "assign" || command === "backlog" && (sub === "pull" || sub === "return") || command === "model" || command === "stop")) return exact;
  const integer = (value: string | undefined) => !!value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  const [backlogClass, ...backlogTitle] = tail;
  if (command === "backlog" && sub === "add" && backlogClass && backlogTitle.length && backlogTitle.every(word => word && !word.startsWith("--"))) return { argv: [...argv] };
  const [backlogId, revision, value, ...reason] = tail;
  if (command === "backlog" && ["plan", "pin", "pull-ready", "split"].includes(sub ?? "") && integer(backlogId) && /^\d+$/.test(revision ?? "") && value !== undefined) {
    if (sub === "pull-ready") return { argv: [...argv], taskId: Number(backlogId) };
    if (!reason.length) return;
    if (sub === "pin" && !["true", "false"].includes(value)) return;
    let dependencyIds: number[] | undefined;
    if (sub === "plan" || sub === "split") {
      try {
        const parsed = JSON.parse(value);
        if (sub === "plan" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.hasOwn(parsed, "needsPerson"))) return;
        if (sub === "split" && !Array.isArray(parsed)) return;
        if (sub === "plan" && Object.hasOwn(parsed, "deps")) {
          if (!Array.isArray(parsed.deps) || parsed.deps.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) < 1)) return;
          dependencyIds = parsed.deps;
        }
      } catch { return; }
    }
    return { argv: [...argv], taskId: Number(backlogId), ...(dependencyIds ? { dependencyIds } : {}) };
  }
  if (command === "results" && argv.slice(1).every(word => ["--unread", "--json", "--full", "--color=auto", "--color=always", "--color=never"].includes(word))) return { argv: [...argv] };
  if (command === "capabilities" && argv.slice(1).every(word => ["--json", "--color=auto", "--color=always", "--color=never"].includes(word))) return { argv: [...argv] };
  if (command === "learn" && sub === "list" && tail.every(word => ["--all", "--json", "--color=auto", "--color=always", "--color=never"].includes(word))) return { argv: [...argv] };
  if (command === "learn" && ["accept", "reject"].includes(sub ?? "") && tail.length === 1 && integer(tail[0])) return { argv: [...argv], taskId: Number(tail[0]), verdictId: tail[0] };
  if (command === "review" && integer(sub) && ["approved", "changes_requested"].includes(tail[0] ?? "")) {
    const seen = new Set<string>();
    for (let i = 1; i < tail.length; i++) {
      const word = tail[i]!;
      if (!word.startsWith("--")) continue;
      if (!["--head", "--findings", "--security-pass", "--unmet"].includes(word) || word !== "--unmet" && seen.has(word) || !tail[i + 1] || tail[i + 1]!.startsWith("--")) return;
      seen.add(word); i++;
    }
    return { argv: [...argv], taskId: Number(sub), verdictId: sub, review: true };
  }
  if (command === "study" && sub === "approve") {
    const parsed = parseStudyArgs(argv.slice(1));
    if (!("usage" in parsed) && parsed.op === "approve") return { argv: [...argv], verdictId: parsed.id };
  }
  return;
}
