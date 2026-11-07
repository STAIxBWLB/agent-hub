import { expect, test } from "bun:test";
import { FACT_FILES, factValues, renderFacts } from "../scripts/lib/readme-facts.ts";

// #1268, #1273: the pure renderer behind scripts/readme-facts.ts (the gate) and release-prepare (which renders the blocks after the version bump).
const pkg = (version: string, bun = ">=1.4.2", pin = "0.22.1") => JSON.stringify({ version, engines: { bun }, dependencies: { "@staix/agent-mem": pin } });
const block = (name: string, body: string) => `<!-- facts:${name} -->${body}<!-- /facts:${name} -->`;
const tag = (version: string) => `\n\`\`\`bash\nbun add -g github:STAIxBWLB/agent-hub#v${version}\nahub setup\n\`\`\`\n`;
const docs = (version: string): Record<string, string> => ({
  "README.md": `Bun ${block("bun-floor", "1.4.2")}, pinned ${block("bun-pinned", "1.4.2")}\n`,
  "CONTRIBUTING.md": "no blocks here\n",
  "docs/quickstart.md": `${block("install-tag", tag(version))}\n`,
  "docs/operations.md": `pin ${block("agent-mem-pin", "0.22.1")}\n`,
});
const reader = (files: Record<string, string>) => (path: string) => files[path];
const sources = (version: string) => ({ packageJson: pkg(version), bunVersion: "1.4.2\n" });

test("blocks that already match their source render to nothing and report no drift", () => {
  const out = renderFacts(reader(docs("0.34.1")), sources("0.34.1"));
  expect(out).toEqual({ files: {}, drift: [], errors: [] });
});

test("a version bump re-renders only the install tag, and the drift names the file, the block, what it read and what the source says", () => {
  const out = renderFacts(reader(docs("0.34.1")), sources("0.35.0"));
  expect(Object.keys(out.files)).toEqual(["docs/quickstart.md"]);
  expect(out.files["docs/quickstart.md"]).toContain("#v0.35.0");
  expect(out.files["docs/quickstart.md"]).not.toContain("#v0.34.1");
  expect(out.drift).toEqual([{ file: "docs/quickstart.md", name: "install-tag", found: tag("0.34.1").trim(), wanted: tag("0.35.0").trim() }]);
  expect(out.errors).toEqual([]);
});

test("the Bun floor, the pinned Bun and the agent-mem pin come from package.json and .bun-version", () => {
  const out = renderFacts(reader(docs("0.34.1")), { packageJson: pkg("0.34.1", ">=1.5.0", "0.23.0"), bunVersion: "1.5.1\n" });
  expect(out.files["README.md"]).toContain(block("bun-floor", "1.5.0"));
  expect(out.files["README.md"]).toContain(block("bun-pinned", "1.5.1"));
  expect(out.files["docs/operations.md"]).toContain(block("agent-mem-pin", "0.23.0"));
  expect(out.drift.map(d => d.name).sort()).toEqual(["agent-mem-pin", "bun-floor", "bun-pinned"]);
});

test("an unknown or mis-closed block, an unreadable package.json and an unrendered fact are errors", () => {
  expect(renderFacts(reader({ ...docs("0.34.1"), "README.md": "<!-- facts:nope -->x<!-- /facts:nope -->\n" }), sources("0.34.1")).errors.join("\n")).toContain("block nope is unknown");
  expect(renderFacts(reader({ ...docs("0.34.1"), "README.md": "<!-- facts:bun-floor -->1.4.2<!-- /facts:bun-pinned -->\n" }), sources("0.34.1")).errors.join("\n")).toContain("closed as bun-pinned");
  expect(renderFacts(reader(docs("0.34.1")), { packageJson: "{", bunVersion: "1" }).errors).toEqual(["package.json is not valid JSON"]);
  expect(renderFacts(reader(docs("0.34.1")), { packageJson: JSON.stringify({ version: "1.0.0" }), bunVersion: "1" }).errors[0]).toContain("needs a version, engines.bun");
  const lost = { ...docs("0.34.1"), "docs/operations.md": "the pin block was deleted\n" };
  expect(renderFacts(reader(lost), sources("0.34.1")).errors.join("\n")).toContain("facts:agent-mem-pin is rendered nowhere");
});

test("strict mode fails a missing listed file; tolerant mode (release-prepare in any checkout) skips it and a checkout with no block at all renders nothing", () => {
  const missing = docs("0.34.1"); delete missing["CONTRIBUTING.md"];
  expect(renderFacts(reader(missing), sources("0.34.1")).errors.join("\n")).toContain("CONTRIBUTING.md does not exist");
  expect(renderFacts(reader(missing), sources("0.34.1"), FACT_FILES, { tolerant: true })).toEqual({ files: {}, drift: [], errors: [] });
  const plain = { "README.md": "Status: 0.1.0\n", "docs/quickstart.md": "Fixture\n" };
  expect(renderFacts(reader(plain), { packageJson: JSON.stringify({ version: "0.1.0" }), bunVersion: "" }, FACT_FILES, { tolerant: true })).toEqual({ files: {}, drift: [], errors: [] });
  // the gate stays strict on the same checkout
  expect(renderFacts(reader(plain), { packageJson: JSON.stringify({ version: "0.1.0" }), bunVersion: "" }).errors.length).toBeGreaterThan(0);
});

test("factValues says why a package.json cannot give the facts", () => {
  expect(factValues({ packageJson: pkg("0.34.1"), bunVersion: "1.4.2" })).toMatchObject({ facts: { "bun-floor": "1.4.2", "agent-mem-pin": "0.22.1" } });
  expect("error" in factValues({ packageJson: pkg("0.34.1", "^1.4.2"), bunVersion: "1.4.2" })).toBe(true);
});
