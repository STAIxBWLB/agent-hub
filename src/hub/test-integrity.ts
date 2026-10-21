import { types } from "node:util";
import type { SdlcGh } from "./sdlc.ts";

/** Check-origin vocabulary, not peer identities; labels make claimed versus remote evidence explicit. */
const CHECK_SOURCES = [
  { value: "local", evidence: "claimed" },
  { value: "container", evidence: "claimed" },
  { value: "ci", evidence: "observed" },
] as const;
type CheckSource = typeof CHECK_SOURCES[number]["value"];
export interface RedFirstReceipt {
  red: { source: CheckSource; head: string; check: string; result: "failed" };
  green: { source: CheckSource; head: string; check: string; result: "passed" };
}
const SHA = /^[a-f0-9]{40}$/;
const text = (v: unknown, limit: number): v is string => typeof v === "string" && v.length > 0 && v.length <= limit && !/[\p{Cc}\p{Cf}]/u.test(v);
function plain(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const found = Reflect.ownKeys(value);
  return found.length === keys.length && found.every(key => typeof key === "string" && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value") && Object.getOwnPropertyDescriptor(value, key)!.enumerable);
}
export function parseRedFirst(value: unknown): RedFirstReceipt {
  const fail = (): never => { throw new Error("invalid red-first receipt"); };
  if (!plain(value, ["red", "green"])) return fail();
  for (const [key, result] of [["red", "failed"], ["green", "passed"]] as const) {
    const leg = value[key];
    if (!plain(leg, ["source", "head", "check", "result"]) || typeof leg.source !== "string" || !CHECK_SOURCES.some(origin => origin.value === leg.source)
      || typeof leg.head !== "string" || !SHA.test(leg.head) || !text(leg.check, 120) || leg.check.trim() !== leg.check || leg.result !== result) return fail();
  }
  const red = value.red as RedFirstReceipt["red"], green = value.green as RedFirstReceipt["green"];
  if (red.head === green.head || red.check !== green.check) return fail();
  return { red: { ...red }, green: { ...green } };
}
const legSchema = (result: string) => ({ type: "object", additionalProperties: false, required: ["source", "head", "check", "result"], properties: {
  source: { type: "string", enum: CHECK_SOURCES.map(origin => origin.value), description: CHECK_SOURCES.map(origin => `${origin.value}: ${origin.evidence}`).join("; ") }, head: { type: "string", pattern: "^[a-f0-9]{40}$" }, check: { type: "string", minLength: 1, maxLength: 120 }, result: { type: "string", enum: [result] },
} });
export const redFirstSchema = { type: "object", additionalProperties: false, required: ["red", "green"], properties: { red: legSchema("failed"), green: legSchema("passed") } };

export interface TestIntegrity {
  applicability: "bug" | "not_bug" | "unknown";
  redFirst: "verified" | "missing" | "invalid" | "unknown" | "not_required";
  fileState: "complete" | "unknown" | "not_required";
  modifiedTests: string[];
  sources?: { red: string; green: string };
  checkEvidence?: { red: "claimed" | "observed"; green: "claimed" | "observed" };
  blockers: string[];
}
function safePath(value: unknown): value is string {
  return text(value, 1000) && !value.startsWith("/") && !value.includes("\\") && !/^[A-Za-z]:/.test(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
/** Literal repository paths, never globs or filesystem reads. */
export function isTestPath(path: string): boolean {
  return safePath(path) && (path.split("/").slice(0, -1).some(part => ["test", "tests", "__tests__"].includes(part))
    || /\.(?:test|spec)\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|sh)$/.test(path)
    || /(?:^|\/)(?:[^/]+_test\.go|test_[^/]+\.py|[^/]+_test\.py|[^/]+_spec\.rb|[^/]*Test\.java)$/.test(path));
}
export function testIntegrityBlockers(view: TestIntegrity | undefined): string[] { return view ? [...view.blockers] : []; }
/** Host policy decides whether remote path identities can enter a public projection. */
export function publicTestIntegrity(view: TestIntegrity, readable: (path: string) => boolean = () => false): TestIntegrity {
  return view.modifiedTests.every(readable) ? view : { applicability: "unknown", redFirst: "unknown", fileState: "unknown", modifiedTests: [], blockers: ["test integrity: private evidence unavailable"] };
}


/** Complete issue label metadata only; undefined means unavailable or truncated. */
export function parseIssueLabels(value: unknown, issue: number): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const found = value as { number?: unknown; labels?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } };
  const nodes = found.labels?.nodes;
  if (found.number !== issue || found.labels?.pageInfo?.hasNextPage !== false || !Array.isArray(nodes) || nodes.length > 100
    || nodes.some(node => !text(node?.name, 100))) return undefined;
  return nodes.map(node => node.name as string);
}

type Evidence = { head: string; pathsComplete?: boolean; typesComplete?: boolean; fileChanges?: { path: string; change: string }[]; issueLabels?: { issue: number; labels: string[] | null } };
/** Bounded metadata only. A failed or incomplete read never establishes a clean test history. */
export async function readTestIntegrity(receipt: { repo?: string; issue?: number; pr?: number; redFirst?: RedFirstReceipt }, evidence: Evidence | undefined, run: SdlcGh): Promise<TestIntegrity> {
  const unknown = (): TestIntegrity => ({ applicability: "unknown", redFirst: "unknown", fileState: "unknown", modifiedTests: [], blockers: ["test integrity: issue label metadata unknown"] });
  const repository = receipt.repo, issue = receipt.issue, pr = receipt.pr;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(issue) || issue! <= 0) return unknown();
  const [owner, name] = repository.split("/");
  const deadline = performance.now() + 20_000;
  async function read(args: string[], cap = 128 * 1024): Promise<any> {
    const remaining = deadline - performance.now(); if (remaining <= 0) throw new Error("metadata unavailable");
    const result = await run(args, Math.max(1, Math.min(10_000, remaining)), undefined, cap);
    if (result.code !== 0 || Buffer.byteLength(result.stdout) > cap) throw new Error("metadata unavailable");
    const parsed = JSON.parse(result.stdout); if (parsed?.errors !== undefined) throw new Error("metadata unavailable"); return parsed;
  }
  const graphql = (query: string, fields: string[]) => ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, ...fields];
  let labels: string[] | undefined;
  const cachedLabels = evidence?.issueLabels;
  if (cachedLabels && cachedLabels.issue === issue) {
    const preloaded = cachedLabels.labels;
    if (!Array.isArray(preloaded) || preloaded.length > 100 || preloaded.some(name => !text(name, 100))) return unknown();
    labels = [...preloaded];
  } else {
    try {
      const found = (await read(graphql("query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number labels(first:100){nodes{name} pageInfo{hasNextPage}}}}}", ["-F", `number=${issue}`]), 32 * 1024)).data?.repository?.issue;
      labels = parseIssueLabels(found, issue!);
    } catch { return unknown(); }
  }
  if (labels === undefined) return unknown();
  if (!labels.some(name => name.toLowerCase() === "bug")) return { applicability: "not_bug", redFirst: "not_required", fileState: "not_required", modifiedTests: [], blockers: [] };
  const view: TestIntegrity = { applicability: "bug", redFirst: "unknown", fileState: "unknown", modifiedTests: [], blockers: [] };
  const changes = evidence?.fileChanges;
  if (evidence && SHA.test(evidence.head) && evidence.pathsComplete === true && evidence.typesComplete === true && Array.isArray(changes) && changes.length <= 1000
    && new Set(changes.map(file => file.path)).size === changes.length && changes.every(file => safePath(file.path) && ["ADDED", "MODIFIED", "DELETED", "CHANGED"].includes(file.change))) {
    view.fileState = "complete";
    view.modifiedTests = changes.filter(file => file.change !== "ADDED" && isTestPath(file.path)).map(file => file.path).sort();
  }
  if (view.fileState === "unknown") view.blockers.push("test integrity: PR test file metadata unknown");
  if (view.modifiedTests.length) view.blockers.push("test integrity: pre-existing test files modified or deleted");
  if (receipt.redFirst === undefined) view.redFirst = "missing";
  else {
    let proof: RedFirstReceipt | undefined;
    try { proof = parseRedFirst(receipt.redFirst); } catch { view.redFirst = "invalid"; }
    if (proof) {
      view.sources = { red: proof.red.source, green: proof.green.source };
      view.checkEvidence = { red: "claimed", green: "claimed" };
      if (!evidence || !SHA.test(evidence.head) || !Number.isSafeInteger(pr) || pr! <= 0) view.redFirst = "unknown";
      else if (proof.green.head !== evidence.head) view.redFirst = "invalid";
      else try {
        const current = (await read(graphql("query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid commits(first:100){nodes{commit{oid}} pageInfo{hasNextPage}}}}}", ["-F", `number=${pr}`]))).data?.repository?.pullRequest;
        if (current?.headRefOid !== evidence.head || current.commits?.pageInfo?.hasNextPage !== false || !Array.isArray(current.commits.nodes) || current.commits.nodes.length > 100 || current.commits.nodes.some((node: any) => !SHA.test(node?.commit?.oid ?? ""))) throw new Error("metadata unavailable");
        if (!current.commits.nodes.some((node: any) => node.commit.oid === proof!.red.head)) view.redFirst = "invalid";
        else {
          const commits = new Set<string>(current.commits.nodes.map((node: any) => node.commit.oid));
          if (commits.size !== current.commits.nodes.length || !commits.has(evidence.head)) throw new Error("metadata unavailable");
          const seen = new Set<string>();
          let cursor: string = proof.red.head;
          view.redFirst = "verified";
          // ponytail: metadata proves file identity and ordering, not later gutting of added tests; content-aware review is the upgrade path.
          while (commits.has(cursor)) {
            if (seen.has(cursor) || seen.size >= 100) throw new Error("metadata unavailable");
            seen.add(cursor);
            const commit = await read(["api", `repos/${repository}/commits/${cursor}?per_page=100`, "--jq", "{sha,parents:[.parents[].sha],files:[.files[]|{path:.filename,change:.status}]}"], 256 * 1024);
            if (commit?.sha !== cursor || !Array.isArray(commit.parents) || !Array.isArray(commit.files) || commit.files.length >= 100) throw new Error("metadata unavailable");
            const red = cursor === proof.red.head;
            if (commit.parents.length !== 1 || !SHA.test(commit.parents[0]) || (red && commit.files.length === 0)
              || !commit.files.every((file: any) => isTestPath(file?.path) && (red ? file.change === "added" : ["added", "modified", "removed", "changed"].includes(file.change)))) {
              view.redFirst = "invalid"; break;
            }
            cursor = commit.parents[0];
          }
          for (const key of ["red", "green"] as const) {
            const leg = proof[key];
            if (view.redFirst !== "verified" || leg.source !== "ci") continue;
            const object = (await read(graphql("query($owner:String!,$name:String!,$oid:String!){repository(owner:$owner,name:$name){object(expression:$oid){... on Commit{oid statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion}} pageInfo{hasNextPage}}}}}}}", ["-f", `oid=${leg.head}`]))).data?.repository?.object;
            const contexts = object?.statusCheckRollup?.contexts;
            if (object?.oid !== leg.head || contexts?.pageInfo?.hasNextPage !== false || !Array.isArray(contexts.nodes) || contexts.nodes.length > 100) throw new Error("metadata unavailable");
            const matches = contexts.nodes.filter((node: any) => node?.__typename === "CheckRun" && node.name === leg.check);
            const result = leg.result === "failed" ? "FAILURE" : "SUCCESS";
            if (matches.length !== 1 || matches[0].status !== "COMPLETED" || matches[0].conclusion !== result) view.redFirst = "invalid";
            else view.checkEvidence[key] = "observed";
          }
        }
      } catch { view.redFirst = "unknown"; }
    }
  }
  if (view.redFirst !== "verified") view.blockers.push(`test integrity: red-first receipt ${view.redFirst}`);
  return view;
}
