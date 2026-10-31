import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesPolicy } from "../src/hub/path-policy.ts";

test("experiment privacy fails closed on incomplete alias discovery without changing legacy policy", () => {
  const root=mkdtempSync(join(tmpdir(),"ahub-output-policy-"));
  try {
    mkdirSync(join(root,"private-results"));
    const strict={failClosedOnDiscoveryLimit:true};
    expect(matchesPolicy(root,"public-results/missing.csv",["private-results"],true,strict)).toBe(false);
    expect(matchesPolicy(root,"private-results/missing.csv",["private-results"],true,strict)).toBe(true);
    for (let index=0; index<4100; index++) writeFileSync(join(root,"private-results",String(index)),"");
    expect(matchesPolicy(root,"public-results/missing.csv",["private-results"],true)).toBe(false);
    expect(matchesPolicy(root,"public-results/missing.csv",["private-results"],true,strict)).toBe(true);
    expect(matchesPolicy(root,"public-results/missing.csv",[],true,strict)).toBe(false);
  } finally { rmSync(root,{recursive:true,force:true}); }
},20_000);
