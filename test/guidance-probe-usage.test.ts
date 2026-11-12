import { expect, test } from "bun:test";
import { GUIDANCE_PROBE_USAGE, guidanceProbeUsage, helpEntries } from "../src/cli/help.ts";
import { parseGuidanceProbeSubcommand } from "../src/hub/guidance-probes.ts";

test("#1405 a refused probe command names the typed subcommand, its own usage and where the id comes from", () => {
  expect(() => parseGuidanceProbeSubcommand(["probe", "receipts"])).toThrow();
  const text = guidanceProbeUsage(["probe", "receipts"]);
  expect(text).toContain("ahub guidance probe receipts has a missing or malformed argument");
  expect(text).toContain("usage: ahub guidance probe receipts --id HASH [--json].");
  expect(text).toContain("the 64-character probe id that ahub guidance probe register printed");
  expect(text).not.toContain("start --id");
  expect(guidanceProbeUsage(["probe", "register"])).toBe("ahub guidance probe register has a missing or malformed argument; usage: ahub guidance probe register --file JSON [--json].");
});

test("#1405 an unknown probe subcommand lists all five, and every usage printed is one ahub help shows", () => {
  for (const typed of [undefined, "list", "constructor"]) {
    const text = guidanceProbeUsage(typed === undefined ? ["probe"] : ["probe", typed]);
    expect(text.startsWith("unknown guidance probe command; usage: ")).toBe(true);
    for (const form of Object.values(GUIDANCE_PROBE_USAGE)) expect(text).toContain(`ahub guidance probe ${form}`);
  }
  const help = helpEntries().map(entry => entry.usage).find(usage => usage.startsWith("ahub guidance probe "))!;
  expect(help).toBe("ahub guidance probe register --file JSON [--json] | start --id HASH --revision N [--variant G1-HASH] [--json] | show --id HASH [--json] | receipts --id HASH [--json] | cancel --id HASH --revision N [--json]");
  for (const op of Object.keys(GUIDANCE_PROBE_USAGE)) expect(help).toContain(guidanceProbeUsage(["probe", op]).split("usage: ahub guidance probe ")[1]!.split(".")[0]!);
});
