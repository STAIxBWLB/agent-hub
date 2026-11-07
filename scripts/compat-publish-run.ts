import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, readSync, readdirSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { planCompatPublish, type CompatPublishAction, type CompatPublishPlan, type CompatPullRequest, type PublishManifestEntry } from "./compat-publish.ts";
import { patchCompatSource, renderPublishedReceipt } from "./compat-publish-files.ts";
import { AGENT_COMPAT_ISSUE_TITLE, selectAgentCompatIssue } from "./agent-compat-issue.ts";
import type { PreparedCompatArtifact, PreparedBundleDescriptor } from "./compat-prepare.ts";

export interface GithubAPI { request(method: "GET" | "POST" | "PATCH", route: string, body?: unknown): Promise<unknown> }
export interface CompatPublisherInput { preparedDir: string; repository: string; sourceBaseSha: string; dryRun: boolean; validateOnly?: boolean }
export interface CompatPublisherResult { dryRun: boolean; sourceBaseSha: string; actions: CompatPublishPlan["actions"]; pullRequests: { number: number; head: string; id: string; version: string }[] }
export class GithubApiError extends Error { readonly status: number; constructor(status: number) { super("GitHub request failed; inspect the workflow request status"); this.status = status; } }
export class CompatPublisherError extends Error { readonly causeClass: string; constructor(causeClass: string) { super(`compat publisher refused (${causeClass}); inspect the trusted preparation and bot branch before retrying`); this.causeClass = causeClass; } }
const fail = (cause: string): never => { throw new CompatPublisherError(cause); };
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/, ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const JSON_CAP = 4 * 1024 * 1024, ASSET_CAP = 64 * 1024 * 1024, TOTAL_CAP = 128 * 1024 * 1024;
const SOURCE = "src/adapters/compat.ts", SERVER = "plugins/agent-hub/server.js", PLUGIN = "plugins/agent-hub/.claude-plugin/plugin.json";
const NAMES = ["compat.ts", "receipt.md", "server.js", "plugin.json"] as const, BOT = "github-actions[bot]";
const digest = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("shape");
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(properties).some(p => !Object.hasOwn(p, "value"))) return fail("shape");
  return value as Record<string, unknown>;
}
function exact(row: Record<string, unknown>, names: readonly string[]): void { if (Object.keys(row).length !== names.length || names.some(key => !Object.hasOwn(row, key))) fail("shape"); }
function array(value: unknown, maximum: number, cause: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return fail(cause);
  return value;
}
function string(value: unknown, cap = JSON_CAP): string { if (typeof value !== "string" || Buffer.byteLength(value) > cap) return fail("shape"); return value; }
function sha(value: unknown): string { const result = string(value, 40); if (!SHA.test(result)) fail("sha"); return result; }
function identity(id: unknown, version: unknown): void {
  if (typeof id !== "string" || !ID.test(id) || typeof version !== "string" || version.length > 64) fail("identity");
  const match = VERSION.exec(version as string); if (!match || match[4]?.split(".").some(p => /^\d+$/.test(p) && p.length > 1 && p.startsWith("0"))) fail("identity");
}
function repository(value: string): string { if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split("/").some(p => p === "." || p === "..")) fail("repository"); return value; }
function safePath(value: unknown): string {
  const result = string(value, 500);
  if (!result || result.startsWith("/") || /[\\\p{Cc}\p{Cf}]/u.test(result) || result.split("/").some(p => !p || p === "." || p === "..")) fail("path");
  return result;
}
function receiptPath(value: unknown, id: string, version: string): string {
  const result = safePath(value);
  if (!/^docs\/verification\/\d{4}-\d{2}-\d{2}-compat-/.test(result) || !result.endsWith(`-compat-${id}-${version}.md`)) fail("receipt-path");
  const date = result.slice(18, 28);
  if (!Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) fail("receipt-path");
  return result;
}
function directory(file: string): void {
  const info = lstatSync(file);
  if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid() || (info.mode & 0o022)) fail("artifact-path");
}
function read(file: string, cap: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > cap || process.getuid && before.uid !== process.getuid()) fail("artifact-file");
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, size); if (!count) break; size += count; }
    const after = fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail("artifact-race");
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
function parse(bytes: Buffer): unknown { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail("json"); } }
interface Bundle { descriptor: PreparedBundleDescriptor; files: Record<string, Buffer> }
function load(input: CompatPublisherInput): { index: PreparedCompatArtifact; bundles: Map<string, Bundle> } {
  sha(input.sourceBaseSha); repository(input.repository);
  if (typeof input.dryRun !== "boolean" || input.validateOnly !== undefined && typeof input.validateOnly !== "boolean") fail("input");
  const root = resolve(input.preparedDir); directory(root);
  const index = object(parse(read(join(root, "index.json"), JSON_CAP)));
  exact(index, ["schemaVersion", "sourceBaseSha", "dryRun", "watch", "artifacts", "rejectedBatch", "plan", "projections", "bundles"]);
  if (index.schemaVersion !== 1 || index.sourceBaseSha !== input.sourceBaseSha || typeof index.dryRun !== "boolean" || !Array.isArray(index.artifacts)
    || typeof index.rejectedBatch !== "boolean" || !Array.isArray(index.bundles) || index.bundles.length > 8) fail("index");
  const watch = object(index.watch); exact(watch, ["code", "report", "candidates"]);
  if (watch.code !== 0 && watch.code !== 3 || !Array.isArray(watch.candidates)) fail("watch");
  const report = string(watch.report);
  const header = watch.code === 0 ? "Every watched agent CLI's latest published version is verified." : "Published agent CLI versions ahead of their verified set (`src/adapters/compat.ts`).";
  if (report.split("\n")[0] !== header || /[<>]|```|[\p{Cc}\p{Cf}]/u.test(report.replaceAll("\n", ""))) fail("watch-report");
  const bundles = new Map<string, Bundle>(); let total = 0;
  for (const raw of array(index.bundles, 8, "index")) {
    const row = object(raw); exact(row, ["id", "version", "directory", "descriptorSha256", "descriptorSize"]); identity(row.id, row.version);
    const key = `${row.id}-${row.version}`;
    if (row.directory !== key || bundles.has(key)) fail("bundle");
    const target = join(root, key); directory(target);
    if (readdirSync(target).sort().join("|") !== [...NAMES, "descriptor.json"].sort().join("|")) fail("bundle-files");
    const bytes = read(join(target, "descriptor.json"), JSON_CAP);
    if (bytes.length !== row.descriptorSize || digest(bytes) !== row.descriptorSha256) fail("descriptor-hash");
    const desc = object(parse(bytes)); exact(desc, ["schemaVersion", "id", "version", "sourceBaseSha", "originalSourceSha256", "receiptPath", "files"]);
    if (desc.schemaVersion !== 1 || desc.id !== row.id || desc.version !== row.version || desc.sourceBaseSha !== input.sourceBaseSha || !HASH.test(string(desc.originalSourceSha256, 64))) fail("descriptor");
    receiptPath(desc.receiptPath, row.id as string, row.version as string);
    const metadata = object(desc.files); exact(metadata, NAMES); const files: Record<string, Buffer> = {};
    for (const name of NAMES) {
      const expected = object(metadata[name]); exact(expected, ["sha256", "size"]);
      const content = read(join(target, name), ASSET_CAP); total += content.length;
      if (total > TOTAL_CAP || content.length !== expected.size || digest(content) !== expected.sha256) fail("bundle-hash");
      files[name] = content;
    }
    bundles.set(key, { descriptor: desc as unknown as PreparedBundleDescriptor, files });
  }
  if (readdirSync(root).sort().join("|") !== ["index.json", ...bundles.keys()].sort().join("|")) fail("artifact-files");
  return { index: index as unknown as PreparedCompatArtifact, bundles };
}
type Leaf = { path: string; mode: string; type: string; sha: string };
interface Snapshot { sha: string; tree: string; leaves: Map<string, Leaf> }
async function optional(api: GithubAPI, route: string): Promise<unknown | undefined> { try { return await api.request("GET", route); } catch (error) { if (error instanceof GithubApiError && error.status === 404) return; throw error; } }
async function inventory(api: GithubAPI, route: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= 10; page++) {
    const rows = array(await api.request("GET", `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`), 100, "inventory");
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  return fail("inventory-ceiling");
}
async function snapshot(api: GithubAPI, base: string, head: string): Promise<Snapshot> {
  const commit = object(await api.request("GET", `${base}/git/commits/${sha(head)}`));
  if (commit.sha !== head) fail("commit"); const tree = sha(object(commit.tree).sha);
  const response = object(await api.request("GET", `${base}/git/trees/${tree}?recursive=1`));
  if (response.sha !== tree || response.truncated !== false || !Array.isArray(response.tree) || response.tree.length > 100_000) fail("tree");
  const leaves = new Map<string, Leaf>();
  for (const value of array(response.tree, 100_000, "tree")) {
    const leaf = object(value), name = safePath(leaf.path);
    if (leaf.type === "tree") continue;
    if (leaves.has(name) || !["blob", "commit"].includes(string(leaf.type)) || !["100644", "100755", "120000", "160000"].includes(string(leaf.mode))) fail("tree-leaf");
    leaves.set(name, { path: name, mode: leaf.mode as string, type: leaf.type as string, sha: sha(leaf.sha) });
  }
  return { sha: head, tree, leaves };
}
async function blob(api: GithubAPI, base: string, tree: Snapshot, file: string): Promise<Buffer> {
  const leaf = tree.leaves.get(file); if (!leaf || leaf.type !== "blob" || !["100644", "100755"].includes(leaf.mode)) return fail("source-file");
  const response = object(await api.request("GET", `${base}/git/blobs/${leaf.sha}`));
  if (response.sha !== leaf.sha || response.encoding !== "base64") fail("blob");
  const encoded = string(response.content, TOTAL_CAP).replaceAll("\n", ""), bytes = Buffer.from(encoded, "base64");
  if (bytes.length > ASSET_CAP || bytes.length !== response.size || bytes.toString("base64") !== encoded
    || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== leaf.sha) fail("blob-hash");
  return bytes;
}
async function ref(api: GithubAPI, base: string, branch: string): Promise<string | undefined> {
  const value = await optional(api, `${base}/git/ref/heads/${branch}`); return value === undefined ? undefined : sha(object(object(value).object).sha);
}
const BEGIN = "<!-- agent-compat-publisher:start -->", END = "<!-- agent-compat-publisher:end -->", META = "<!-- agent-compat-publisher:v1 ";
interface Ownership { id: string; version: string; sourceBaseSha: string; head: string; tree: string; receiptPath: string; receiptSha256: string }
function title(id: string, version: string): string { return `chore(compat): verify ${id} ${version}`; }
function managed(owner: Ownership): string {
  return `${BEGIN}\nRefs #888 and #1248.\n\nModel-free compatibility receipt for ${owner.id} ${owner.version}.\nReceipt: \`${owner.receiptPath}\`.\nSource base: \`${owner.sourceBaseSha}\`.\nHead: \`${owner.head}\`.\n\nReview and exact-head checks are required; this PR is never auto-merged.\n\n${META}${JSON.stringify(owner)} -->\n${END}`;
}
function ownership(body: string, id: string, version: string): { owner: Ownership; prefix: string; suffix: string } {
  if (body.split(BEGIN).length !== 2 || body.split(END).length !== 2 || body.split(META).length !== 2) return fail("bot-marker");
  const start = body.indexOf(BEGIN), end = body.indexOf(END) + END.length, marker = body.indexOf(META), finish = body.indexOf(" -->", marker);
  let value: unknown; try { value = JSON.parse(body.slice(marker + META.length, finish)); } catch { return fail("bot-marker"); }
  const row = object(value); exact(row, ["id", "version", "sourceBaseSha", "head", "tree", "receiptPath", "receiptSha256"]);
  if (row.id !== id || row.version !== version || !HASH.test(string(row.receiptSha256, 64))) fail("bot-marker");
  sha(row.sourceBaseSha); sha(row.head); sha(row.tree); receiptPath(row.receiptPath, id, version);
  const owner = row as unknown as Ownership;
  if (body.slice(start, end) !== managed(owner)) fail("bot-marker");
  return { owner, prefix: body.slice(0, start), suffix: body.slice(end) };
}
interface BotPull extends CompatPullRequest { owner: Ownership; prefix: string; suffix: string }
function botPull(value: unknown, repo: string, manifest: Record<string, PublishManifestEntry>): BotPull | undefined {
  const row = object(value), head = object(row.head), user = object(row.user), branch = string(head.ref, 200);
  if (!branch.startsWith("compat/")) return;
  const id = Object.keys(manifest).sort((a, b) => b.length - a.length).find(key => branch.startsWith(`compat/${key}-`));
  if (!id) return;
  const version = branch.slice(`compat/${id}-`.length); identity(id, version);
  if (user.login !== BOT || user.type !== "Bot" || object(head.repo).full_name !== repo) return;
  if (row.title !== title(id, version) || object(row.base).ref !== "main" || !Number.isSafeInteger(row.number) || Number(row.number) <= 0) fail("bot-provenance");
  const marker = ownership(string(row.body ?? ""), id, version);
  if (head.sha !== marker.owner.head) fail("manual-head");
  const state = row.merged_at ? "merged" : row.state === "open" ? "open" : row.state === "closed" ? "closed" : fail("pull-state");
  return { id, version, number: row.number as number, branch, state, ...marker };
}
async function verifyOwned(api: GithubAPI, base: string, pull: BotPull): Promise<void> {
  if (await ref(api, base, pull.branch) !== pull.owner.head) fail("manual-head");
  const before = await snapshot(api, base, pull.owner.sourceBaseSha), after = await snapshot(api, base, pull.owner.head);
  if (after.tree !== pull.owner.tree) fail("manual-tree");
  const allowed = new Set([SOURCE, SERVER, PLUGIN, pull.owner.receiptPath]);
  for (const key of new Set([...before.leaves.keys(), ...after.leaves.keys()])) {
    if (JSON.stringify(before.leaves.get(key)) !== JSON.stringify(after.leaves.get(key)) && !allowed.has(key)) fail("manual-files");
  }
  const original = (await blob(api, base, before, SOURCE)).toString("utf8"), current = (await blob(api, base, after, SOURCE)).toString("utf8");
  if (current !== patchCompatSource(original, pull.id, pull.version, pull.owner.receiptPath)
    || digest(await blob(api, base, after, pull.owner.receiptPath)) !== pull.owner.receiptSha256) fail("manual-source");
}
type Drift = Extract<CompatPublishAction, { kind: "update-drift" }>;
const ROW_START = "<!-- agent-compat-receipt:start ", ROW_END = "<!-- agent-compat-receipt:end -->";
const NEXT: Record<Drift["cause"], string> = { "missing-artifact": "Run the committed model-free procedure on its required runner.", "malformed-artifact": "Inspect the native summary schema, then rerun the committed procedure.", "proof-failed": "Repair the failed proof leg, then rerun the committed procedure.", "not-run": "Run each required leg on its supported runner; retain manual boundaries.", policy: "Obtain the separately authorized native, account, model or human review evidence.", "newer-pr": "Review the newer bot-owned compatibility PR.", "already-published": "Keep the existing merged compatibility receipt." };
const PROOF_CAUSES = new Set(["ok", "proof-failed", "timeout", "cancelled", "platform", "model-required", "tui-required", "producer-not-committed", "producer-not-importable", "not-applicable", "disposable-required", "process-cleanup-unproven", "source-review-required", "install-unavailable", "integrity", "input", "cleanup"]);
function driftBlock(action: Drift): string {
  identity(action.id, action.version);
  if (!Object.hasOwn(NEXT, action.cause) || !Array.isArray(action.legs) || action.legs.length > 128) fail("drift");
  const seen = new Set<string>();
  for (const leg of action.legs) {
    exact(object(leg), ["id", "category", "requiredForAdmission", "status", "cause"]);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(leg.id) || seen.has(leg.id) || !["linux-ci", "macos-runner", "account-or-model", "tui-desktop"].includes(leg.category)
      || typeof leg.requiredForAdmission !== "boolean" || !["pass", "fail", "not-run"].includes(leg.status) || !PROOF_CAUSES.has(leg.cause) || (leg.status === "pass") !== (leg.cause === "ok")) fail("drift-leg");
    seen.add(leg.id);
  }
  const row = { id: action.id, version: action.version, cause: action.cause, legs: action.legs };
  return `${ROW_START}${JSON.stringify(row)} -->\n### ${row.id} ${row.version}\n\nCause: ${row.cause}.\nNext step: ${NEXT[row.cause]}\n${row.legs.map(leg => `- ${leg.id}: ${leg.status} (${leg.cause}).`).join("\n")}\n${ROW_END}`;
}
function receiptBlocks(body: string): Map<string, { start: number; end: number; block: string }> {
  string(body); const result = new Map<string, { start: number; end: number; block: string }>(); let cursor = 0, count = 0;
  while (true) {
    const start = body.indexOf(ROW_START, cursor); if (start < 0) break;
    const markerEnd = body.indexOf(" -->", start), endAt = body.indexOf(ROW_END, markerEnd), end = endAt + ROW_END.length;
    if (markerEnd < 0 || endAt < 0 || ++count > 8) fail("issue-marker");
    let value: unknown; try { value = JSON.parse(body.slice(start + ROW_START.length, markerEnd)); } catch { return fail("issue-marker"); }
    const row = object(value); exact(row, ["id", "version", "cause", "legs"]);
    const canonical = driftBlock({ kind: "update-drift", ...row } as Drift);
    if (body.slice(start, end) !== canonical || result.has(row.id as string)) fail("issue-marker");
    result.set(row.id as string, { start, end, block: canonical }); cursor = end;
  }
  if (body.split(ROW_END).length !== count + 1) fail("issue-marker"); return result;
}
function replaceRows(body: string, changes: Map<string, string | undefined>): string {
  const current = receiptBlocks(body); let result = body;
  for (const [id, row] of [...current.entries()].sort((a, b) => b[1].start - a[1].start)) {
    if (changes.has(id)) { result = result.slice(0, row.start) + (changes.get(id) ?? "") + result.slice(row.end); changes.delete(id); }
  }
  for (const block of changes.values()) if (block) result += `${result.endsWith("\n") ? "\n" : "\n\n"}${block}\n`;
  if (Buffer.byteLength(result) > JSON_CAP) fail("issue-size"); return result;
}
export function retainManagedReceiptRows(report: string, previous: string): string {
  return replaceRows(report, new Map([...receiptBlocks(previous)].map(([id, row]) => [id, row.block])));
}
async function issue(api: GithubAPI, base: string): Promise<{ number: number; body: string } | undefined> {
  const rows = (await inventory(api, `${base}/issues?state=open`)).filter(value => !Object.hasOwn(object(value), "pull_request"));
  const number = selectAgentCompatIssue(rows); if (number === undefined) return;
  const row = object(await api.request("GET", `${base}/issues/${number}`));
  if (row.title !== AGENT_COMPAT_ISSUE_TITLE || row.state !== "open" || row.pull_request) fail("issue-identity");
  return { number, body: string(row.body ?? "") };
}
/** Data-only privileged phase. Prepared source is compared as bytes and is never imported or evaluated. */
export async function runCompatPublisher(input: CompatPublisherInput, api: GithubAPI): Promise<CompatPublisherResult> {
  const data = load(input), base = `/repos/${repository(input.repository)}`;
  const repo = object(await api.request("GET", base));
  if (repo.full_name !== input.repository || repo.default_branch !== "main") fail("default-branch");
  const assertBase = async () => { if (!input.dryRun && await ref(api, base, "main") !== input.sourceBaseSha) fail("main-moved"); };
  await assertBase();
  const main = await snapshot(api, base, input.sourceBaseSha), sourceBytes = await blob(api, base, main, SOURCE), source = sourceBytes.toString("utf8");
  for (const file of [SOURCE, SERVER, PLUGIN]) {
    const leaf = main.leaves.get(file);
    if (!leaf || leaf.type !== "blob" || !["100644", "100755"].includes(leaf.mode)) fail("source-mode");
  }
  const manifestValue = object(parse(await blob(api, base, main, "scripts/compat-receipts/manifest.json")));
  const manifest = object(manifestValue.entries) as unknown as Record<string, PublishManifestEntry>;
  const rows = await inventory(api, `${base}/pulls?state=all`), pulls = rows.map(row => botPull(row, input.repository, manifest)).filter((p): p is BotPull => !!p);
  const args = { manifest, candidates: data.index.watch.candidates, artifacts: data.index.rejectedBatch ? [{}] : data.index.artifacts, dryRun: input.dryRun };
  const baseline = planCompatPublish({ ...args, existingPullRequests: [] }), plan = planCompatPublish({ ...args, existingPullRequests: pulls });
  const baselinePrs = baseline.actions.filter(action => action.kind === "create-pr" || action.kind === "update-pr");
  if (baselinePrs.length !== data.bundles.size) fail("bundle-plan");
  const packageJson = object(parse(await blob(api, base, main, "package.json")));
  identity("package", packageJson.version);
  // Validate every prepared candidate, even if a live newer PR will suppress publication.
  for (const action of baselinePrs) {
    const bundle = data.bundles.get(`${action.id}-${action.version}`); if (!bundle) fail("bundle-plan");
    const descriptor = bundle!.descriptor, files = bundle!.files;
    if (descriptor.originalSourceSha256 !== digest(sourceBytes) || files["compat.ts"]!.toString("utf8") !== patchCompatSource(source, action.id, action.version, descriptor.receiptPath)
      || files["receipt.md"]!.toString("utf8") !== renderPublishedReceipt(action.receipt)) fail("source-patch");
    const plugin = object(parse(files["plugin.json"]!)); if (plugin.name !== "agent-hub" || plugin.version !== packageJson.version) fail("plugin-version");
  }
  const work: { action: Extract<CompatPublishAction, { kind: "create-pr" | "update-pr" }>; bundle: Bundle; pull?: BotPull }[] = [];
  for (const action of plan.actions) {
    if (action.kind !== "create-pr" && action.kind !== "update-pr") continue;
    const rawCollisions = rows.filter(value => { const row = object(value); return row.state === "open" && object(row.head).ref === action.branch; });
    const pull = pulls.find(p => p.state === "open" && p.branch === action.branch), currentRef = await ref(api, base, action.branch);
    if (rawCollisions.length > 1 || rawCollisions.length && !pull || currentRef && !pull || action.kind === "update-pr" && pull?.number !== action.number) fail("branch-collision");
    if (pull) await verifyOwned(api, base, pull);
    work.push({ action, bundle: data.bundles.get(`${action.id}-${action.version}`)!, ...(pull ? { pull } : {}) });
  }
  for (const action of plan.actions) if (action.kind === "supersede-pr") {
    const pull = pulls.find(p => p.number === action.number); if (!pull) fail("supersede-owner"); await verifyOwned(api, base, pull!);
  }
  const beforeIssue = await issue(api, base); if (beforeIssue) receiptBlocks(beforeIssue.body);
  const result: CompatPublisherResult = { dryRun: input.dryRun, sourceBaseSha: input.sourceBaseSha, actions: plan.actions, pullRequests: [] };
  if (input.dryRun || input.validateOnly) return result;
  for (const { action, bundle, pull } of work) {
    await assertBase(); if (await ref(api, base, action.branch) !== pull?.owner.head) fail("branch-moved");
    if (pull) {
      const live = botPull(await api.request("GET", `${base}/pulls/${pull.number}`), input.repository, manifest);
      if (!live || live.state !== "open" || live.owner.head !== pull.owner.head || live.prefix !== pull.prefix || live.suffix !== pull.suffix) fail("pull-moved");
    }
    const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
    for (const [name, file] of [["compat.ts", SOURCE], ["receipt.md", bundle.descriptor.receiptPath], ["server.js", SERVER], ["plugin.json", PLUGIN]] as const) {
      const value = object(await api.request("POST", `${base}/git/blobs`, { content: bundle.files[name]!.toString("base64"), encoding: "base64" }));
      entries.push({ path: file, mode: main.leaves.get(file)?.mode ?? "100644", type: "blob", sha: sha(value.sha) });
    }
    // The fresh-main tree omits an old unmerged receipt. A receipt already on main remains main-owned.
    const tree = sha(object(await api.request("POST", `${base}/git/trees`, { base_tree: main.tree, tree: entries })).sha);
    const parents = [...new Set([...(pull ? [pull.owner.head] : []), input.sourceBaseSha])];
    const head = sha(object(await api.request("POST", `${base}/git/commits`, { message: `chore(compat): verify ${action.id} ${action.version}\n\nRefs #888 and #1248.`, tree, parents })).sha);
    await assertBase(); if (await ref(api, base, action.branch) !== pull?.owner.head) fail("branch-moved");
    // force:false prevents history loss. GitHub's Git Data API is not an expected-old-SHA CAS.
    if (pull) await api.request("PATCH", `${base}/git/refs/heads/${action.branch}`, { sha: head, force: false });
    else await api.request("POST", `${base}/git/refs`, { ref: `refs/heads/${action.branch}`, sha: head });
    const owner: Ownership = { id: action.id, version: action.version, sourceBaseSha: input.sourceBaseSha, head, tree,
      receiptPath: bundle.descriptor.receiptPath, receiptSha256: digest(bundle.files["receipt.md"]!) };
    const body = `${pull?.prefix ?? ""}${managed(owner)}${pull?.suffix ?? ""}`;
    await assertBase();
    if (pull) {
      const current = object(await api.request("GET", `${base}/pulls/${pull.number}`));
      if (current.state !== "open" || current.title !== title(action.id, action.version) || object(current.user).login !== BOT
        || current.body !== `${pull.prefix}${managed(pull.owner)}${pull.suffix}` || object(current.head).sha !== head) fail("pull-moved");
    }
    const pr = object(await api.request(pull ? "PATCH" : "POST", pull ? `${base}/pulls/${pull.number}` : `${base}/pulls`, { title: title(action.id, action.version), body, ...(pull ? {} : { head: action.branch, base: "main" }) }));
    if (!Number.isSafeInteger(pr.number) || Number(pr.number) <= 0) fail("pull-response");
    await api.request("POST", `${base}/actions/workflows/check.yml/dispatches`, { ref: action.branch });
    result.pullRequests.push({ id: action.id, version: action.version, number: pr.number as number, head });
  }
  for (const action of plan.actions) if (action.kind === "supersede-pr") {
    if (!result.pullRequests.some(p => p.id === action.id && p.version === action.replacementVersion)) fail("replacement-not-ready");
    const current = botPull(await api.request("GET", `${base}/pulls/${action.number}`), input.repository, manifest);
    if (!current || current.state !== "open") fail("supersede-owner"); await verifyOwned(api, base, current!); await assertBase();
    await api.request("POST", `${base}/issues/${action.number}/comments`, { body: `Superseded by the successful compatibility candidate ${action.replacementVersion} on \`${action.replacementBranch}\`. Review the replacement PR and its checks. Refs #888.` });
    await api.request("PATCH", `${base}/pulls/${action.number}`, { state: "closed" });
  }
  const changes = new Map<string, string | undefined>();
  for (const action of plan.actions) if (action.kind === "update-drift") changes.set(action.id, driftBlock(action));
  for (const pull of result.pullRequests) changes.set(pull.id, undefined);
  if (changes.size) {
    const current = await issue(api, base);
    if (current?.number !== beforeIssue?.number || current?.body !== beforeIssue?.body) fail("issue-moved");
    const body = replaceRows(current?.body ?? data.index.watch.report, changes); await assertBase();
    if (current && body !== current.body) await api.request("PATCH", `${base}/issues/${current.number}`, { body });
    else if (!current && [...changes.values()].some(Boolean)) await api.request("POST", `${base}/issues`, { title: AGENT_COMPAT_ISSUE_TITLE, body, labels: ["agent-compat"] });
  }
  return result;
}

/** Only the first-party gh executable is run; no repository or downloaded code executes here. */
export function ghRestAPI(): GithubAPI {
  return { request(method, route, body) {
    if (!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|$)/.test(route) || /[\p{Cc}\p{Cf}]/u.test(route)) return Promise.reject(new CompatPublisherError("route"));
    if (!process.env.GITHUB_TOKEN) return Promise.reject(new CompatPublisherError("workflow-token-required"));
    return new Promise((accept, reject) => {
      const args = ["api", "--include", "--method", method, route, ...(body === undefined ? [] : ["--input", "-"])];
      const child = spawn("gh", args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GH_HOST: "github.com", GH_TOKEN: process.env.GITHUB_TOKEN, LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = []; let size = 0, overflow = false;
      const timer = setTimeout(() => { overflow = true; child.kill("SIGKILL"); }, 30_000);
      child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > TOTAL_CAP) { overflow = true; child.kill("SIGKILL"); } else chunks.push(chunk); });
      child.stdin.on("error", () => { /* The child error/close result is authoritative. */ });
      child.once("error", () => { clearTimeout(timer); reject(new CompatPublisherError("github-executable")); });
      child.once("close", code => {
        clearTimeout(timer); if (overflow) { reject(new CompatPublisherError("github-bound")); return; }
        const output = Buffer.concat(chunks).toString("utf8"), split = /\r?\n\r?\n/.exec(output), status = /^HTTP\/[^ ]+ (\d{3})/i.exec(output);
        if (!split || !status) { reject(new CompatPublisherError("github-response")); return; }
        const number = Number(status[1]); if (number < 200 || number >= 300) { reject(new GithubApiError(number)); return; }
        if (code !== 0) { reject(new CompatPublisherError("github-response")); return; }
        const content = output.slice(split.index + split[0].length).trim();
        try { accept(content ? JSON.parse(content) : undefined); } catch { reject(new CompatPublisherError("github-json")); }
      });
      child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
    });
  } };
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2), fields: Record<string, string> = {}; let dryRun = false, validateOnly = false;
    while (args.length) {
      const key = args.shift()!;
      if (key === "--dry-run" && !dryRun) { dryRun = true; continue; }
      if (key === "--validate-only" && !validateOnly) { validateOnly = true; continue; }
      if (!["--prepared", "--repo", "--source-base", "--retain-rows"].includes(key) || fields[key] || !args.length) fail("arguments"); fields[key] = args.shift()!;
    }
    const repo = repository(fields["--repo"] ?? process.env.GITHUB_REPOSITORY ?? ""), api = ghRestAPI();
    if (fields["--retain-rows"]) {
      if (fields["--prepared"] || fields["--source-base"] || validateOnly) fail("arguments");
      const previous = await issue(api, `/repos/${repo}`), file = resolve(fields["--retain-rows"]), original = read(file, JSON_CAP).toString("utf8");
      const merged = retainManagedReceiptRows(original, previous?.body ?? "");
      if (dryRun) console.log(merged);
      else {
        const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = fstatSync(fd); if (!info.isFile() || info.nlink !== 1 || info.size > JSON_CAP || readFileSync(fd).toString("utf8") !== original) fail("report-moved");
          const bytes = Buffer.from(merged); let offset = 0;
          while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) fail("report-write"); offset += count; }
          ftruncateSync(fd, bytes.length);
        } finally { closeSync(fd); }
      }
    } else {
      if (!fields["--prepared"] || !fields["--source-base"]) fail("arguments");
      console.log(JSON.stringify(await runCompatPublisher({ preparedDir: fields["--prepared"]!, repository: repo, sourceBaseSha: fields["--source-base"]!, dryRun, validateOnly }, api)));
    }
  } catch (error) { console.error(error instanceof CompatPublisherError || error instanceof GithubApiError ? error.message : "compat publisher input invalid; inspect the trusted preparation before retrying"); process.exitCode = 1; }
}
