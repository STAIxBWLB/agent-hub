import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";

export async function runLocalEntry(ctx: NativeCliEntryContext): Promise<void> {
  const peer = ctx.instance ?? "local";
  const { args, connect, fail } = ctx;
  const opt = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] ?? fail(`${flag} needs a value`) : undefined);
  for (const flag of ["--route", "--model"]) if (args.includes(flag) && (!opt(flag) || opt(flag)!.startsWith("--"))) fail(`${flag} needs a value`);
  if (args.includes("--route") && args.includes("--model")) fail("use --route or --model, not both");
  if (args.some((a, i) => i % 2 === 0 && !["--route", "--model"].includes(a))) fail("usage: ahub local [--route <id> | --model <id>]");
  const hub = await connect();
  const snapshot = (await hub.request({ t: "status" })).status;
  const warning = ctx.helpers.retainedLaunchWarning(snapshot, peer, ctx.definition); if (warning) console.error(warning);
  const res = await hub.request({ t: "start", peer, args: { route: opt("--route"), model: opt("--model") }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
  hub.close();
  if (!res.ok) fail(res.error);
  console.log(res.already ? `${peer} is already attached` : `${peer} attached on ${res.model}. Give it work with: ahub say @${peer} "..."`);
}
