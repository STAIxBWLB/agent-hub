import { expect, test } from "bun:test";
import { consideredFindingMatch, parseConsideredEntry, publicConsideredEntry, type ConsideredDiff } from "../src/hub/considered-findings.ts";

const base = "a".repeat(40), head = "b".repeat(40);
const entry = { repo: "owner/repo", id: "bounded-survey-parser", pass: "bugs" as const, paths: ["src/parser", "test/parser.test.ts"],
  reason: "Existing guard covers this behavior", ref: base, source: { task: 7, created: 123, kind: "survey" as const } };
const diff = (paths: string[], complete = true): ConsideredDiff => ({ repo: entry.repo, base, head, complete, paths });
const match = (changed?: ConsideredDiff) => consideredFindingMatch(entry, { repo: entry.repo, id: entry.id, pass: entry.pass, currentRef: head, diff: changed });

test("considered matching scopes identity and preserves only individually unchanged paths", () => {
  expect(match(diff([]))).toEqual({ status: "applicable", applicablePaths: entry.paths });
  expect(match(diff(["src/parser/decoder.ts"]))).toEqual({ status: "applicable", applicablePaths: ["test/parser.test.ts"] });
  expect(match(diff(["src/parser/decoder.ts", "test/parser.test.ts"]))).toEqual({ status: "changed", applicablePaths: [] });
  expect(match(diff(["src/parser-other/decoder.ts"])).applicablePaths).toEqual(entry.paths);
  expect(match(diff(["src"])).applicablePaths).toEqual(["test/parser.test.ts"]);
  for (const patch of [{ repo: "foreign/repo" }, { id: "different-semantic-id" }, { pass: "security" as const }])
    expect(consideredFindingMatch(entry, { repo: entry.repo, id: entry.id, pass: entry.pass, currentRef: head, diff: diff([]), ...patch }).status).toBe("different");
  expect(consideredFindingMatch(entry, { repo: entry.repo, id: entry.id, pass: entry.pass, currentRef: base })).toEqual({ status: "applicable", applicablePaths: entry.paths });
  expect(entry.paths).toEqual(["src/parser", "test/parser.test.ts"]);
});

test("missing, partial, malformed or foreign diff remains unknown and never clears a rejection", () => {
  for (const changed of [undefined, diff([], false), { ...diff([]), repo: "foreign/repo" }, { ...diff([]), base: head }, { ...diff([]), head: base }, diff(["../escape"]), diff(["src/a", "src/a"])])
    expect(match(changed)).toEqual({ status: "unknown", applicablePaths: [] });
  expect(publicConsideredEntry({ ...entry, withheld: true }, "unknown")).toEqual({ id: entry.id, status: "unknown", rejectedBefore: true });
});

test("withheld and security rejection readback carries ids and status only", () => {
  const secret = "SECRET_VALUE_CANARY";
  for (const patch of [{ withheld: true as const }, { pass: "security" as const }]) {
    const value = publicConsideredEntry({ ...entry, ...patch, paths: [secret], reason: secret, repo: secret }, "applicable");
    expect(JSON.stringify(value)).not.toContain(secret);
    expect(Object.keys(value).sort()).toEqual(["id", "rejectedBefore", "status"]);
  }
});

test("considered entries are closed inert bounded records with semantic identity and full SHA", () => {
  let effects = 0;
  const getter = { ...entry }; Object.defineProperty(getter, "reason", { enumerable: true, get() { effects++; return "executed"; } });
  const proxy = new Proxy(entry, { ownKeys() { effects++; return []; } });
  const paths = [...entry.paths]; Object.setPrototypeOf(paths, Object.create(Array.prototype, { map: { get() { effects++; return Array.prototype.map; } } }));
  for (const value of [getter, proxy, { ...entry, paths }, { ...entry, ref: "main" }, { ...entry, reason: "line1\nline2" },
    { ...entry, source: { ...entry.source, actor: "user" } }, { ...entry, source: { ...entry.source, task: 0 } }, { ...entry, withheld: false }, { ...entry, secret: "unrecognized" }])
    expect(() => parseConsideredEntry(value)).toThrow();
  expect(effects).toBe(0); expect(parseConsideredEntry(entry)).toEqual(entry);
  const local = { ...entry, id: "F1" };
  expect(parseConsideredEntry(local).id).toBe("F1");
  expect(consideredFindingMatch(local, { repo: entry.repo, pass: entry.pass, id: "F1", currentRef: base }).status).toBe("different");
  expect(publicConsideredEntry(entry, "applicable")).not.toHaveProperty("repo");
});
