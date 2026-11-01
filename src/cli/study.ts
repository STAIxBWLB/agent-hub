// Argument parsing for `ahub study` (#601). Pure: argv in, one request description or a usage line out, so the I/O in main.ts stays a thin dispatcher and every form is testable without a daemon.
export const STUDY_USAGE = "usage: ahub study draft <parent> <contract.json> | revise <id> <revision> <contract.json> | approve <id> <revision> | approve-protocol <hash> | close <id> <revision> --reason <text> | show [<id> | --after <id>] | experiments (--campaign <id> [--after <n>] | --attempt <ra-id> | --plan <hash> --baseline <ra-id> --variant <ra-id>) [--json] [--color=auto|always|never]";

export type StudyRequest =
  | { op: "draft"; parentTaskId: number; file: string }
  | { op: "revise"; id: string; revision: number; file: string }
  | { op: "approve"; id: string; revision: number }
  | { op: "approve_protocol"; hash: string }
  | { op: "close"; id: string; revision: number; reason: string }
  | { op: "show"; id?: string; after?: string }
  | { op: "experiments"; campaign?: string; attempt?: string; after?: number; plan?: string; baseline?: string; variant?: string };

const ID = /^rc-[a-f0-9]{12}$/, INT = /^[1-9]\d{0,8}$/, ATTEMPT = /^ra-[a-f0-9]{12}$/, HASH = /^[a-f0-9]{64}$/, CURSOR = /^(0|[1-9]\d{0,8})$/;

/** `operands` is argv with the presentation flags (`--json`, `--color=`) already removed by `splitPresentation`. `--reason` takes the rest of the words, as `task cancel --reason` does. */
export function parseStudyArgs(operands: readonly string[]): StudyRequest | { usage: string } {
  const usage = (detail?: string) => ({ usage: detail ? `${detail}\n${STUDY_USAGE}` : STUDY_USAGE });
  const [sub, ...rest] = operands;
  const id = (value: string | undefined) => value !== undefined && ID.test(value) ? value : undefined;
  const int = (value: string | undefined) => value !== undefined && INT.test(value) ? Number(value) : undefined;
  if (sub === "approve-protocol") {
    if (rest.length !== 1) return usage();
    const hash = rest[0];
    return hash?.length === 64 && /^[a-f0-9]{64}$/.test(hash) ? { op: "approve_protocol", hash } : usage("a protocol hash is 64 lowercase hexadecimal characters");
  }
  if (sub === "experiments") {
    // Three closed forms, the ones Tasks.experimentShow takes: a campaign page, one attempt, or one comparison. A flag with no value, a repeat, a stray word or a mix is a usage error before anything is sent.
    const names = ["--campaign", "--attempt", "--after", "--plan", "--baseline", "--variant"], seen = new Map<string, string>();
    for (let at = 0; at < rest.length; at += 2) {
      const name = rest[at], value = rest[at + 1];
      if (name === undefined || !names.includes(name) || value === undefined || value.startsWith("--") || seen.has(name)) return usage();
      seen.set(name, value);
    }
    const campaign = seen.get("--campaign"), attempt = seen.get("--attempt"), after = seen.get("--after"), plan = seen.get("--plan"), baseline = seen.get("--baseline"), variant = seen.get("--variant");
    if (campaign !== undefined && !id(campaign)) return usage("a campaign id looks like rc-0123456789ab");
    for (const [name, value] of [["--attempt", attempt], ["--baseline", baseline], ["--variant", variant]] as const) if (value !== undefined && !ATTEMPT.test(value)) return usage(`${name} takes an attempt id like ra-0123456789ab`);
    if (plan !== undefined && !HASH.test(plan)) return usage("a plan hash is 64 lowercase hexadecimal characters");
    if (after !== undefined && !CURSOR.test(after)) return usage("--after takes the cursor a previous page printed");
    const comparison = plan !== undefined || baseline !== undefined || variant !== undefined;
    if (comparison) return plan !== undefined && baseline !== undefined && variant !== undefined && campaign === undefined && attempt === undefined && after === undefined
      ? { op: "experiments", plan, baseline, variant } : usage("a comparison needs --plan, --baseline and --variant and nothing else");
    if ((campaign === undefined) === (attempt === undefined)) return usage("give --campaign or --attempt");
    if (attempt !== undefined && after !== undefined) return usage("--after pages a campaign, not one attempt");
    return attempt !== undefined ? { op: "experiments", attempt } : { op: "experiments", campaign: campaign!, ...(after === undefined ? {} : { after: Number(after) }) };
  }
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
