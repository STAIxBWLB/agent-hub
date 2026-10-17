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
