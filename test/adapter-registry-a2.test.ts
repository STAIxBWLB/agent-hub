import { expect, test } from "bun:test";
import { definitionOf } from "../src/adapters/registry.ts";
import { scanRegistrySources, groupRegistrySites } from "./helpers/registry-inventory.ts";

test("#451 A2 kind-aware equality and switch sites stay counted in their lexical group", () => {
  const file = "src/hub/example.ts";
  const body = `import { kindOf as kind, definitionOf as definition } from "../adapters/registry.ts";
    function choose(peer: string) {
      if (kind(peer) === "codex") return 1;
      if ("pi" !== definition(peer)?.kind) return 2;
      switch (kind(peer)) { case "kimi": return 3; }
    }`;
  const sites = scanRegistrySources({ [file]: body });
  expect(sites.map(site => site.pattern)).toEqual(["kind-aware-comparison", "kind-aware-comparison", "kind-aware-comparison"]);
  expect(groupRegistrySites(sites)).toEqual([{ file, symbol: "choose", count: 3 }]);
  const raw = body.replace('kind(peer) === "codex"', 'peer === "codex"').replace('"pi" !== definition(peer)?.kind', '"pi" !== peer').replace('switch (kind(peer))', 'switch (peer)');
  expect(groupRegistrySites(scanRegistrySources({ [file]: raw }))).toEqual(groupRegistrySites(sites));
});

test("#451 A2 resume-by-id is separate from daemon auto-start restoration", () => {
  expect(definitionOf("qwen")!.session).toMatchObject({ resumeById: true });
  expect(definitionOf("qwen")!.session.restoreOnStart).toBeUndefined();
  expect(definitionOf("pi")!.session.restoreOnStart).toBe(true);
});

import { splitRegistryInventory } from "./helpers/registry-inventory.ts";
const probeSources = () => ({
  "src/hub/peer-catalog.ts": 'export const KNOWN_PEERS = ["claude","codex","kimi","pi","local"] as const; export const OPTIONAL_PEERS = ["qwen","jcode"] as const;',
  "src/hub/start-mode.ts": 'export const START_MODE_PEERS = ["pi","codex","kimi"] as const;',
});
test("#451 A2 compatibility probes are named and separately counted without hiding policy", () => {
  const sources = probeSources();
  const result = splitRegistryInventory(sources);
  expect(result.issues).toEqual([]);
  expect(result.policy).toEqual([]);
  expect(result.compatibility.map(row => [row.file,row.symbol,row.count,row.reason])).toEqual([
    ["src/hub/peer-catalog.ts","KNOWN_PEERS",5,"cross-release source probe"],
    ["src/hub/peer-catalog.ts","OPTIONAL_PEERS",2,"cross-release source probe"],
    ["src/hub/start-mode.ts","START_MODE_PEERS",3,"cross-release source probe"],
  ]);
  const changed = { ...sources, "src/hub/peer-catalog.ts": sources["src/hub/peer-catalog.ts"] + '\nfunction route(peer:string) { return peer === "codex"; }' };
  expect(splitRegistryInventory(changed).policy.map(row=>row.symbol)).toEqual(["route"]);
  const invalid = { ...sources, "src/hub/start-mode.ts": 'export const START_MODE_PEERS = (() => ["pi","codex","kimi"])();' };
  expect(splitRegistryInventory(invalid).issues).toContain("invalid compatibility probe: src/hub/start-mode.ts START_MODE_PEERS");
  expect(splitRegistryInventory(invalid).policy).toHaveLength(3);
});
