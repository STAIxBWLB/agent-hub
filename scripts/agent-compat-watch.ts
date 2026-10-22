// #691: compare the npm-published version of each npm-distributed gated CLI with its verified set.
// Prints a markdown report on stdout and exits 3 when some kind is ahead (1 is Bun's own crash code, so it is never a verdict).
// Model-free, no install, no account.
import { assessVersion, COMPAT, describe, type CompatId } from "../src/adapters/compat.ts";

const NPM: Partial<Record<CompatId, string>> = { "codex-review": "@openai/codex", "kimi-review": "@moonshot-ai/kimi-code", qwen: "@qwen-code/qwen-code" };
const rows: string[] = [];
for (const [id, pkg] of Object.entries(NPM) as [CompatId, string][]) {
  let latest: string | undefined;
  try { latest = (await (await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(15_000) })).json() as { version?: string }).version; } catch { /* unknown */ }
  const verdict = assessVersion(id, latest, []);
  if (!verdict.ok || verdict.state !== "verified") rows.push(`- **${id}** (${pkg}): latest ${latest ?? "unknown"}, ${verdict.state}; ${describe(id)}`);
}
if (!rows.length) { console.log("Every watched agent CLI's latest published version is verified."); process.exit(0); }
console.log(["Published agent CLI versions ahead of their verified set (`src/adapters/compat.ts`).", "",
  ...rows, "",
  "Next step for each: a model-free receipt in `docs/verification/`, then add the version to `verified` in the same PR. Until then a person may run `ahub agents trust <id> <version>` on their machine.",
  "", `Checked ${new Date().toISOString().slice(0, 10)} by .github/workflows/agent-compat.yml.`].join("\n"));
process.exit(3);
