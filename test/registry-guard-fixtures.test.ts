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

test("registry guard fixture excludes native adapter implementation while counting kind-aware comparisons", () => {
  const body = `function choose(peer: string) { return peer === "qwen"; }`;
  expect(inventory(body, "src/adapters/acp.ts")).toEqual([]);
  expect(inventory(body, "src/adapters/registry.ts")).toEqual([]);
  expect(inventory(`import { kindOf, definitionOf } from "../adapters/registry.ts"; function choose(peer: string) { return kindOf(peer) === "qwen" || definitionOf(peer)?.kind === "kimi"; }`)).toEqual([{ file: "src/hub/example.ts", symbol: "choose", count: 2 }]);
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
  expect(inventory(`import { kindOf as resolveKind, definitionOf as resolveDefinition } from "../adapters/registry.ts"; function choose(peer: string) { return resolveKind(peer) === "qwen" || resolveDefinition(peer)?.kind === "kimi"; }`)).toEqual([{ file: "src/hub/example.ts", symbol: "choose", count: 2 }]);
  expect(inventory(`import { kindOf } from "./fake-registry.ts"; function choose(peer: string) { return kindOf(peer) === "qwen"; }`)[0]?.count).toBe(1);
});

test("registry guard fixture distinguishes local provider and lifecycle enums from native identity", () => {
  const apply = `function authorizeConfigLeaf(key:string,after:unknown){ if(key === "routing.signals.pii_screen" && after === "local") return true; }`;
  expect(inventory(apply, "src/hub/config-apply.ts")).toEqual([]);
  expect(inventory(apply.replace('key === "routing.signals.pii_screen" && ', ""), "src/hub/config-apply.ts")[0]?.count).toBe(1);
  expect(inventory(apply.replace('key ===', 'key !=='), "src/hub/config-apply.ts")[0]?.count).toBe(1);
  expect(inventory(apply.replace('after ===', 'after !=='), "src/hub/config-apply.ts")[0]?.count).toBe(1);
  const reload = `function validateRoutingRaw(){return {signals:(v:any,k:string)=>closed(v,k,{pii_screen:(x:any,p:string)=>choice(x,p,["off","local"])})};}`;
  expect(inventory(reload, "src/hub/config-reload.ts")).toEqual([]);
  expect(inventory(reload.replace('"off","local"', '"codex","local"'), "src/hub/config-reload.ts")[0]?.count).toBe(2);
  const gates = `const STAGE_GATES=["issue","pr","local","review","checks","phase"];`;
  expect(inventory(gates, "src/hub/sdlc.ts")).toEqual([]);
  expect(inventory(gates + ` function route(peer:string){return peer === "local"}`, "src/hub/sdlc.ts")[0]?.count).toBe(1);
  expect(inventory(`const STAGE_GATES=["local","codex"];`, "src/hub/sdlc.ts")[0]?.count).toBe(2);
});

test("registry guard resolves peer-id constants and alias chains at comparison and case sites", () => {
  const sites = scanRegistrySources(source(`
    const LOCAL = "local", PI = ("pi" as const);
    const PICK = LOCAL;
    function choose(peer: string) {
      if (peer !== LOCAL || PI === peer || peer === PICK) return 1;
      switch (peer) { case PICK: return 2; }
    }
  `));
  expect(sites.map(site => site.pattern)).toEqual(["comparison", "comparison", "comparison", "comparison"]);
  expect(sites.map(site => site.symbol)).toEqual(["choose", "choose", "choose", "choose"]);
});

test("registry guard resolves imported aliases through the supplied source export bindings", () => {
  const sites = scanRegistrySources({
    "src/hub/routing.ts": `export const LOCAL = "local"; const PI = "pi"; export { PI as INSTRUMENTED };`,
    "src/hub/reexport.ts": `export { LOCAL as ON_PREM } from './routing.ts';`,
    "src/hub/example.ts": `import { LOCAL as target, INSTRUMENTED as runner } from './routing.ts'; import { ON_PREM as safe } from './reexport.ts'; function choose(peer:string){ return peer === target || runner !== peer || peer === safe; }`,
  });
  expect(sites.map(site => site.text)).toEqual(["peer === target", "runner !== peer", "peer === safe"]);
  expect(sites.map(site => site.pattern)).toEqual(["comparison", "comparison", "comparison"]);
});

test("registry guard preserves lexical shadowing and ignores non-peer literal bindings", () => {
  expect(inventory(`const LOCAL="local"; function choose(peer:string, LOCAL:string){return peer===LOCAL;} function other(peer:string){ const LOCAL="shadow"; return peer===LOCAL; }`)).toEqual([]);
  expect(inventory(`const PI="pi"; function choose(peer:string){ { const PI="off"; if(peer===PI) return 1; } return peer===PI; }`)).toEqual([{ file: "src/hub/example.ts", symbol: "choose", count: 1 }]);
  expect(inventory(`const PI="shadow", LOCAL="off"; function choose(mode:string){return mode===PI || mode===LOCAL;}`)).toEqual([]);
  expect(inventory(`const PI="pi"; function choose(peer:string){ try { throw new Error(); } catch(PI) { return peer===PI; } }`)).toEqual([]);
  expect(inventory(`const PI="pi"; function choose(peer:string){ for(const PI of ["off"]) { if(peer===PI) return 1; } }`)).toEqual([]);
});

test("registry guard classifies constant comparisons with trusted kind resolvers", () => {
  const sites = scanRegistrySources(source(`import { kindOf as resolveKind } from '../adapters/registry.ts'; const LOCAL='local'; function choose(peer:string){ return resolveKind(peer)===LOCAL; }`));
  expect(sites.map(site => site.pattern)).toEqual(["kind-aware-comparison"]);
});

test("registry guard preserves named local provider exemptions when the value is a constant", () => {
  expect(inventory(`const LOCAL="local"; function parseRouting(){return signals.pii_screen!==LOCAL;}`, "src/hub/routing.ts")).toEqual([]);
  expect(inventory(`const LOCAL="local"; function parseRouting(peer:string){return peer!==LOCAL;}`, "src/hub/routing.ts")[0]?.count).toBe(1);
});


test("registry guard does not borrow a constant from an unrelated supplied script", () => {
  expect(scanRegistrySources({
    "src/hub/first.ts": `const LOCAL="local"; function first(peer:string){return peer===LOCAL;}`,
    "src/hub/second.ts": `function second(value:string){return value===LOCAL;}`,
  }).map(site => site.symbol)).toEqual(["first"]);
  expect(scanRegistrySources({
    "src/hub/first.ts": `const LOCAL="local"; function first(peer:string){return peer===LOCAL;}`,
    "src/hub/second.ts": `const LOCAL="shadow"; function second(value:string){return value===LOCAL;}`,
  }).map(site => site.symbol)).toEqual(["first"]);
});

for (const body of [
  `function choose(peer = "claude") { return peer; }`,
  `const CLAUDE = "claude"; function choose(peer = CLAUDE) { return peer; }`,
  `function choose(options: any) { const { peer = "codex" } = options; return peer; }`,
  `function choose(peer: string | undefined) { return peer ?? "kimi"; }`,
  `const PI = "pi"; function choose(peer?: string) { return peer ?? PI; }`,
  `function choose(peer?: string) { peer ??= "qwen"; return peer; }`,
]) test(`registry guard A2b detects native default identity: ${body}`, () => {
  const sites = scanRegistrySources(source(body));
  expect(sites).toHaveLength(1);
  expect(sites[0]?.symbol).toBe("choose");
});

for (const expression of [
  `budget.report("claude", 1)`,
  `definitionOf("codex")`,
  `peer.startsWith("codex-")`,
  `peer.startsWith("kimi")`,
  `ids.includes("pi")`,
  `"qwen".includes(peer)`,
  `Object.hasOwn(states, "jcode")`,
  `Object.prototype.hasOwnProperty.call(states, "agy")`,
]) test(`registry guard A2b detects vendor call or peer-id predicate: ${expression}`, () => {
  const sites = scanRegistrySources(source(`declare const budget: { report(peer: string, used: number): void }; declare const ids: readonly PeerId[]; declare const states: Record<PeerId, unknown>; declare function definitionOf(peer: string): unknown; function choose(peer: string) { return ${expression}; }`));
  expect(sites).toHaveLength(1);
  expect(sites[0]?.symbol).toBe("choose");
});

test("registry guard A2b resolves vendor call/default aliases without confusing shadowed bindings", () => {
  const sites = scanRegistrySources({
    "src/adapters/native-test.ts": `export const KIND = "codex"; export const PREFIX = "codex-";`,
    "src/hub/example.ts": `import { KIND as name, PREFIX as prefix } from '../adapters/native-test.ts'; declare const budget: {report(peer: string): void}; function choose(peer?:string) { peer ??= name; budget.report(name); return peer.startsWith(prefix); } function other(name:string,prefix:string) { return budget.report(name) || peer.startsWith(prefix); }`,
  });
  expect(sites).toHaveLength(3);
  expect(sites.map(site => site.symbol)).toEqual(["choose", "choose", "choose"]);
});

for (const expression of [
  `/^codex$/.test(peer)`,
  `/^(?:kimi|pi)$/.test(peer)`,
  `/^claude$/i.test(peer)`,
  `new RegExp("^qwen$").test(peer)`,
]) test(`registry guard A2b detects anchored native kind regex: ${expression}`, () => {
  const sites = scanRegistrySources(source(`function choose(peer:string) { return ${expression}; }`));
  expect(sites).toHaveLength(1);
  expect(sites[0]?.symbol).toBe("choose");
});

for (const body of [
  `import { AcpPeer } from '../adapters/acp.ts'; function choose(peer:unknown) { return peer instanceof AcpPeer; }`,
  `import { CodexPeer as Native } from '../adapters/codex-appserver.ts'; function choose(peer:unknown) { return peer instanceof Native; }`,
  `import * as native from '../adapters/acp.ts'; function choose(peer:unknown) { return peer instanceof native.AcpPeer; }`,
]) test(`registry guard A2b detects native instanceof dispatch outside adapters: ${body}`, () => {
  const sites = scanRegistrySources(source(body));
  expect(sites).toHaveLength(1);
  expect(sites[0]?.symbol).toBe("choose");
});

test("registry guard A2b keeps prose, unrelated defaults/predicates/regex and ordinary instanceof out of policy", () => {
  expect(inventory(`
    // /^codex$/.test(peer), peer.startsWith("kimi-") and peer instanceof AcpPeer are examples.
    const prose = "budget.report('claude')";
    function choose(mode = "ask") {
      mode ??= "off";
      return /^codex session/.test(mode) || /^(?:ask|off)$/.test(mode)
        || mode.startsWith("feature-") || Object.hasOwn(states, "ask")
        || error instanceof Error || states instanceof Map;
    }
  `)).toEqual([]);
});

test("registry guard A2b adapter exclusion applies to every broadened detector without adding core exemptions", () => {
  const body = `import { AcpPeer } from '../adapters/acp.ts'; declare function report(peer: string): void; function choose(peer="codex") { return /^kimi$/.test(peer) || peer.startsWith("pi-") || report("claude") || peer instanceof AcpPeer; }`;
  expect(inventory(body, "src/adapters/native-policy.ts")).toEqual([]);
  expect(inventory(body, "src/hub/new-native-policy.ts").reduce((count, row) => count + row.count, 0)).toBe(5);
});


test("registry guard A2b call arguments require a source-proven peer or kind position", () => {
  const sites = scanRegistrySources(source(`
    declare function report(peer: string): void;
    declare function byModel(model: string): void;
    declare function byFile(file: string): void;
    function choose() { report("claude"); byModel("claude"); byFile("codex"); unknownFunction("kimi"); }
  `));
  expect(sites).toHaveLength(1);
  expect(sites[0]?.text).toContain('"claude"');
  expect(sites[0]?.symbol).toBe("choose");
});


test("registry guard A2b follows constant peer aliases for predicates and refuses local constructor shadowing", () => {
  expect(inventory(`function choose(peer:string) { const target=peer; const selected=target; return selected.startsWith("codex-"); }`)).toEqual([{ file: "src/hub/example.ts", symbol: "choose", count: 1 }]);
  expect(inventory(`import { AcpPeer as Native } from '../adapters/acp.ts'; function choose(peer:unknown, Native:Function) { return peer instanceof Native; }`)).toEqual([]);
  expect(inventory(`import * as native from '../adapters/acp.ts'; function choose(peer:unknown, native:any) { return peer instanceof native.AcpPeer; }`)).toEqual([]);
});

for (const expression of [
  `peer["startsWith"]("codex-")`,
  `peers["includes"]("pi")`,
  `Object["hasOwn"](states, "codex")`,
  `states["hasOwnProperty"]("kimi")`,
  `Object.prototype["hasOwnProperty"]["call"](states, "agy")`,
]) test(`registry guard A2b detects constant bracket peer predicates: ${expression}`, () => {
  const sites = scanRegistrySources(source(`declare const peers: readonly PeerId[]; declare const states: Record<PeerId, unknown>; function choose(peer:string) { return ${expression}; }`));
  expect(sites).toHaveLength(1);
  expect(sites[0]?.symbol).toBe("choose");
});

test("registry guard A2b resolves lexical bracket method aliases but never guesses dynamic or shadowed keys", () => {
  const sites = scanRegistrySources({
    "src/adapters/method-names.ts": `export const STARTS="startsWith";`,
    "src/hub/example.ts": `import { STARTS as starts } from '../adapters/method-names.ts'; const includes="includes"; function choose(peer:string,peers:PeerId[]) { return peer[starts]("codex-") || peers[includes]("pi"); } function shadow(peer:string,starts:string,includes:string) { return peer[starts]("codex-") || peer[includes]("pi"); } function dynamic(peer:string,key:string) { return peer[key]("codex-"); }`,
  });
  expect(sites).toHaveLength(2);
  expect(sites.map(site => site.symbol)).toEqual(["choose", "choose"]);
});

test("registry guard A2b resolves constant bracket native constructor names with lexical namespace shadowing", () => {
  const sites = scanRegistrySources({
    "src/adapters/ctor-names.ts": `export const CTOR="AcpPeer";`,
    "src/hub/example.ts": `import * as native from '../adapters/acp.ts'; import { CTOR as ctor } from '../adapters/ctor-names.ts'; function choose(peer:unknown) { return peer instanceof native["AcpPeer"] || peer instanceof native[ctor]; } function shadow(peer:unknown,native:any) { return peer instanceof native[ctor]; } function dynamic(peer:unknown,key:string) { return peer instanceof native[key]; }`,
  });
  expect(sites).toHaveLength(2);
  expect(sites.map(site => site.symbol)).toEqual(["choose", "choose"]);
});


test("registry guard A2b native instanceof requires adapter provenance rather than a Peer suffix", () => {
  expect(scanRegistrySources({
    "src/hub/peers.ts": `export class BasePeer {}`,
    "src/hub/example.ts": `import { BasePeer } from './peers.ts'; function choose(peer:unknown) { return peer instanceof BasePeer; }`,
  })).toEqual([]);
  expect(inventory(`class Peer {} class WsPeer extends Peer {} function choose(peer:unknown) { return peer instanceof Peer || peer instanceof WsPeer; }`)).toEqual([]);
  const sites = scanRegistrySources({
    "src/adapters/acp.ts": `export class AcpPeer {}`,
    "src/hub/reexport.ts": `export { AcpPeer as Native } from '../adapters/acp.ts';`,
    "src/hub/example.ts": `import { Native } from './reexport.ts'; class Derived extends Native {} function choose(peer:unknown) { return peer instanceof Native || peer instanceof Derived; }`,
  });
  expect(sites).toHaveLength(2);
  expect(sites.map(site => site.symbol)).toEqual(["choose", "choose"]);
});
