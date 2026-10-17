import { expect, test } from "bun:test";
import { compareRegistryBaseline, groupRegistrySites, scanRegistrySources } from "./helpers/registry-inventory.ts";

const source = (body: string, file = "src/hub/example.ts") => ({ [file]: body });
const inventory = (body: string, file?: string) => groupRegistrySites(scanRegistrySources(source(body, file)));

test("registry guard fixture detects vendor comparisons in either orientation and switch cases", () => {
  const sites = scanRegistrySources(source(`function assign(peer: string) { if (peer === "codex") return 1; if ('kimi' != peer) return 2; switch(peer) { case "pi": return 3; } }`));
  expect(sites.map(site => site.pattern)).toEqual(["comparison", "comparison", "comparison"]);
  expect(groupRegistrySites(sites)).toEqual([{ file: "src/hub/example.ts", symbol: "assign", count: 3 }]);
});

test("registry guard fixture fails growth in an existing function and new function or file", () => {
  const old = `function assign(peer: string) { return peer === "codex"; }`;
  const baseline = inventory(old);
  expect(compareRegistryBaseline(inventory(old.replace('peer === "codex"', 'peer === "codex" || peer === "kimi"')), baseline).join("\n")).toContain("count");
  expect(compareRegistryBaseline(inventory(old + ` function added(peer: string) { return peer === "pi"; }`), baseline).join("\n")).toContain("added");
  expect(compareRegistryBaseline(inventory(old, "src/new.ts"), baseline).join("\n")).toContain("src/new.ts");
});

test("registry guard fixture detects vendor object keys and name arrays without counting prose or comments", () => {
  const sites = scanRegistrySources(source(`// peer === "codex"\nconst prose = "peer === 'kimi'"; const colors = { claude: 'blue', ['codex']: 'green' }; const peers = ["kimi", 'pi']; const ordinary = ['off','shadow'];`));
  expect(sites.map(site => site.pattern)).toEqual(["vendor-literal", "vendor-literal", "vendor-literal", "vendor-literal"]);
  expect(groupRegistrySites(sites)).toEqual([
    { file: "src/hub/example.ts", symbol: "colors", count: 2 },
    { file: "src/hub/example.ts", symbol: "peers", count: 2 },
  ]);
});

test("registry guard fixture detects aliased and namespace closed-list imports", () => {
  const sites = scanRegistrySources(source(`import { KNOWN_PEERS as choices, isSupportedPeer as allowed } from './peer-catalog.ts'; import * as start from './start-mode.ts'; import { PEER_START_RETRY_MS } from './start-mode.ts';`));
  expect(sites.map(site => site.pattern)).toEqual(["closed-list-import", "closed-list-import", "closed-list-import"]);
  expect(groupRegistrySites(sites)).toEqual([{ file: "src/hub/example.ts", symbol: "(module)", count: 3 }]);
});

test("registry guard fixture keeps symbol attribution stable across unrelated line insertions", () => {
  const body = `function outer(peer: string) { const choose = () => peer === "codex"; return choose(); }`;
  const before = inventory(body), after = inventory("// unrelated line\n\n" + body);
  expect(after).toEqual(before);
  expect(before[0]?.symbol).toBe("outer.choose");
  expect(compareRegistryBaseline(after, before)).toEqual([]);
});

test("registry guard fixture refuses stale, reduced and duplicate baseline entries", () => {
  const entry = { file: "src/hub/example.ts", symbol: "assign", count: 2 };
  expect(compareRegistryBaseline([], [entry]).join("\n")).toContain("stale");
  expect(compareRegistryBaseline([{ ...entry, count: 1 }], [entry]).join("\n")).toContain("count");
  expect(compareRegistryBaseline([entry], [entry, entry]).join("\n")).toContain("duplicate");
});

test("registry guard fixture excludes native adapter implementation and kind-aware comparisons only", () => {
  const body = `function choose(peer: string) { return peer === "qwen"; }`;
  expect(inventory(body, "src/adapters/acp.ts")).toEqual([]);
  expect(inventory(body, "src/adapters/registry.ts")).toEqual([]);
  expect(inventory(`import { kindOf, definitionOf } from "../adapters/registry.ts"; function choose(peer: string) { return kindOf(peer) === "qwen" || definitionOf(peer)?.kind === "kimi"; }`)).toEqual([]);
  expect(inventory(`function choose(peer: string) { return fakeKindOf(peer) === "qwen" || object.kind === "kimi"; }`)[0]?.count).toBe(2);
});

test("registry guard fixture allowlists named config enum semantics without exempting vendor routing", () => {
  expect(inventory(`function parseRouting() { if (signals.pii_screen !== "local") throw new Error(); }`, "src/hub/routing.ts")).toEqual([]);
  expect(inventory(`function parseRouting(peer: string) { if (peer !== "local") throw new Error(); }`, "src/hub/routing.ts")[0]?.count).toBe(1);
  expect(inventory(`function parseRouting() { if (signals.pii_screen !== "local") throw new Error(); }`, "src/unrelated.ts")[0]?.count).toBe(1);
});

test("registry guard fixture scans HTML inline scripts with stable script identity, excluding styles and markup", () => {
  const sites = scanRegistrySources(source(`<style>.codex{color:red}</style><p>peer === "pi"</p><script>function draw(peer) { return peer === 'kimi'; }</script><script>const colors={codex:'green'};</script>`, "src/ui/index.html"));
  expect(sites).toHaveLength(2);
  expect(sites.map(site => site.symbol)).toEqual(["script[1].draw", "script[2].colors"]);
});

test("registry guard fixture records the frozen same-symbol count-only replacement ceiling", () => {
  // ponytail: A0 freezes counts per file/symbol, so a removed comparison replaced inside that same symbol is indistinguishable. A2 removes the baseline.
  const old = inventory(`function assign(peer: string) { return peer === "codex"; }`);
  const replacement = inventory(`function assign(peer: string) { return peer === "kimi"; }`);
  expect(compareRegistryBaseline(replacement, old)).toEqual([]);
});


test("registry guard fixture trusts only imported registry resolvers without local shadowing", () => {
  expect(inventory(`function kindOf(peer: string) { return peer; } function choose(peer: string) { return kindOf(peer) === "qwen"; }`)[0]?.count).toBe(1);
  expect(inventory(`function choose(peer: string) { return kindOf(peer) === "qwen" || definitionOf(peer)?.kind === "kimi"; }`)[0]?.count).toBe(2);
  expect(inventory(`import { kindOf } from "../adapters/registry.ts"; function choose(peer: string, kindOf: (id: string) => string) { return kindOf(peer) === "qwen"; }`)[0]?.count).toBe(1);
  expect(inventory(`import { definitionOf } from "../adapters/registry.ts"; function choose(peer: string) { const definitionOf = (id: string) => ({kind:id}); return definitionOf(peer)?.kind === "kimi"; }`).reduce((count, group) => count + group.count, 0)).toBe(1);
  expect(inventory(`import { kindOf as resolveKind, definitionOf as resolveDefinition } from "../adapters/registry.ts"; function choose(peer: string) { return resolveKind(peer) === "qwen" || resolveDefinition(peer)?.kind === "kimi"; }`)).toEqual([]);
  expect(inventory(`import { kindOf } from "./fake-registry.ts"; function choose(peer: string) { return kindOf(peer) === "qwen"; }`)[0]?.count).toBe(1);
});
