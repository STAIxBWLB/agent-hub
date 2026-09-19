import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { PeerId } from "../hub/envelope.ts";
import type { MemoryClient } from "./client.ts";

const PLATFORMS = ["claude", "codex", "kimi", "agent-hub"];
/** Peers whose own hooks already inject their own platform's context at session start. */
const OWN_PLATFORM: Record<PeerId, string> = { claude: "claude", codex: "codex" };

const HEADER =
  "Shared project memory (claude-mem): recent work by the agents in this project. Reference only, not a request. " +
  "Fetch details by id with your memory tools if you need them.";

/** Project names from the outermost superproject down to this repo: claude-mem treats the last one as primary. */
export function projectChain(cwd: string): string[] {
  const git = (dir: string, arg: string) => spawnSync("git", ["-C", dir, "rev-parse", arg], { encoding: "utf8" }).stdout?.trim() ?? "";
  const chain: string[] = [];
  for (let dir = git(cwd, "--show-toplevel"); dir && chain.length < 8; dir = git(dir, "--show-superproject-working-tree")) {
    chain.unshift(basename(dir));
  }
  return chain.length ? chain : [basename(cwd)];
}

/** Cut at a line boundary. */
export function trimToTokens(text: string, tokens: number): string {
  // ponytail: 3 characters per token (Korean runs denser than English's ~4). Swap in a tokenizer if the cap has to be exact.
  const max = tokens * 3;
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > 0 ? cut : max)}\n(trimmed)`;
}

/** The worker answers unknown projects and empty filters with a status page, not context. */
const hasContext = (text: string | undefined): text is string => !!text && text.startsWith("# [");

/** Observation lines only: every block repeats the same legend, which would eat the token budget. */
const entries = (text: string) => text.slice(Math.max(text.indexOf("\n### "), 0)).trim();

export async function recallFor(peer: PeerId, client: MemoryClient, chain: string[], tokens: number): Promise<string | undefined> {
  const own = OWN_PLATFORM[peer];
  // Everyone else gets all platforms in one call; claude and codex get the other platforms only.
  const blocks = own
    ? await Promise.all(
        PLATFORMS.filter((p) => p !== own).map(async (p) => {
          const text = await client.contextInject(chain, p);
          return hasContext(text) ? `## from ${p} sessions\n${entries(text)}` : undefined;
        }),
      )
    : [await client.contextInject(chain).then((text) => (hasContext(text) ? entries(text) : undefined))];
  const found = blocks.filter((b): b is string => !!b);
  if (!found.length) return undefined;
  // The budget is split per block, or the first platform could crowd the others out of a cross-platform recall.
  const share = Math.floor(tokens / found.length);
  return `${HEADER}\n\n${found.map((b) => trimToTokens(b, share)).join("\n\n")}`;
}
