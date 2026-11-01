// Argument parsing for `ahub study` (#601). Pure: argv in, one request description or a usage line out, so the I/O in main.ts stays a thin dispatcher and every form is testable without a daemon.
export const STUDY_USAGE = "usage: ahub study draft <parent> <contract.json> | revise <id> <revision> <contract.json> | approve <id> <revision> | close <id> <revision> --reason <text> | show [<id> | --after <id>] [--json] [--color=auto|always|never]";

export type StudyRequest =
  | { op: "draft"; parentTaskId: number; file: string }
  | { op: "revise"; id: string; revision: number; file: string }
  | { op: "approve"; id: string; revision: number }
  | { op: "close"; id: string; revision: number; reason: string }
  | { op: "show"; id?: string; after?: string };

const ID = /^rc-[a-f0-9]{12}$/, INT = /^[1-9]\d{0,8}$/;

/** `operands` is argv with the presentation flags (`--json`, `--color=`) already removed by `splitPresentation`. `--reason` takes the rest of the words, as `task cancel --reason` does. */
export function parseStudyArgs(operands: readonly string[]): StudyRequest | { usage: string } {
  const usage = (detail?: string) => ({ usage: detail ? `${detail}\n${STUDY_USAGE}` : STUDY_USAGE });
  const [sub, ...rest] = operands;
  const id = (value: string | undefined) => value !== undefined && ID.test(value) ? value : undefined;
  const int = (value: string | undefined) => value !== undefined && INT.test(value) ? Number(value) : undefined;
  if (sub === "show") {
    // `--after <id>` continues a list from the cursor a previous page printed; it has no meaning with an id, which shows one campaign.
    if (rest[0] === "--after") {
      if (rest.length !== 2) return usage();
      return id(rest[1]) ? { op: "show", after: rest[1]! } : usage("a campaign id looks like rc-0123456789ab");
    }
    if (rest.length > 1) return usage();
    if (rest[0] === undefined) return { op: "show" };
    return id(rest[0]) ? { op: "show", id: rest[0] } : usage("a campaign id looks like rc-0123456789ab");
  }
  if (sub === "draft") {
    const parent = int(rest[0]);
    if (parent === undefined || !rest[1] || rest.length !== 2) return usage();
    return { op: "draft", parentTaskId: parent, file: rest[1] };
  }
  if (sub === "revise") {
    const revision = int(rest[1]);
    if (!id(rest[0]) || revision === undefined || !rest[2] || rest.length !== 3) return usage();
    return { op: "revise", id: rest[0]!, revision, file: rest[2] };
  }
  if (sub === "approve") {
    const revision = int(rest[1]);
    if (!id(rest[0]) || revision === undefined || rest.length !== 2) return usage();
    return { op: "approve", id: rest[0]!, revision };
  }
  if (sub === "close") {
    const revision = int(rest[1]);
    const at = rest.indexOf("--reason");
    if (!id(rest[0]) || revision === undefined || at !== 2) return usage();
    const reason = rest.slice(at + 1).join(" ").trim();
    return reason ? { op: "close", id: rest[0]!, revision, reason } : usage("study close needs a reason");
  }
  return usage();
}
