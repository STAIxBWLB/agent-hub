import { releaseTrackedClean } from "./release-worktree.ts";
import { createHash, randomUUID } from "node:crypto";
import { USER, type PeerId } from "./envelope.ts";
import { hubGitEnv, hubGitSync } from "./git.ts";
import { readDocEvidenceDetailed, type DocEvidence, type ReleaseGit, type ReleaseReadiness, type ReleaseReportPolicy } from "./sdlc-release.ts";
import { DEFAULT_RELEASE_POLICY, hasCommittedReleaseNotes, type ReleasePolicy } from "./sdlc-release-policy.ts";
import type { SdlcGh } from "./sdlc.ts";
import type { ReleaseGuardRequest, ReleasePushUpdate } from "../cli/sdlc-release-guard.ts";

class ReleaseAuthorizationError extends Error {}
export const releaseAuthorizationError = (error: unknown): string => error instanceof ReleaseAuthorizationError ? error.message : "release authorization evidence unavailable";

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const validReleaseVersion = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && VERSION.test(value);
export interface ReleaseDocsVerdict { fresh: true; errors: 0; documents: number; digest: string }
export type ReleaseDocsReceipt = ReleaseDocsVerdict | ({ source: "none" } & { fresh?: never; errors?: never; documents?: never; digest?: never });
export interface ReleaseAuthorization { schemaVersion: 1; id: string; by: PeerId; commit: string; version: string; at: number; docs: ReleaseDocsReceipt }
export interface ReleaseAuthorizationPorts {
  git?: ReleaseGit;
  /** Host reader for policy committed at the candidate; absence preserves legacy package/checker policy for existing callers. */
  policy?: (commit: string, git: ReleaseGit) => ReleasePolicy;
  docs?: (root: string) => Promise<DocEvidence | undefined>;
  /** Test seam: the checker program the default reader spawns (#1120). Never set from configuration. */
  checker?: string;
  gh?: SdlcGh;
  now?: () => number;
  current?: () => boolean;
  /** Host-only current eligible conductor; absent keeps non-person authorization refused. */
  conductor?: () => PeerId | undefined;
  record: (receipt: ReleaseAuthorization) => boolean;
}
export type ReleaseGuardVerdict = { ok: true; receipts: ReleaseAuthorization[] } | { ok: false; error: string };
interface Origin { hash: string; urls: string[]; repo?: string }
interface Entry { receipt: ReleaseAuthorization; origin: Origin; policy: ReleasePolicy; order: number }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function docsVerdict(value: DocEvidence | undefined, commit: string, version: string): ReleaseDocsVerdict | undefined {
  if (!value || value.schemaVersion !== 1 || value.head !== commit || value.version !== version || value.fresh !== true || value.errors !== 0
    || !Array.isArray(value.documents) || value.documents.length > 128 || value.documents.some(row => row.state !== "fresh" || row.dirty === true)) return;
  // Paths may be withheld in a public release report; the commit binds their identities, not this projection.
  const rows = value.documents.map(({ state, verifiedAgainst, commits, dirty }) => ({ state, verifiedAgainst, commits, dirty })).map(row => JSON.stringify(row)).sort();
  return { fresh: true, errors: 0, documents: rows.length, digest: digest({ commit, version, rows }) };
}
function githubRepo(url: string): string | undefined {
  const match = url.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return match?.[1];
}

/** Host-owned consent, never imported from a task receipt or an agent-writable file. Restart revokes it. */
export class ReleaseAuthorizations {
  private readonly entries = new Map<string, Entry>();
  private latest?: Entry;
  private authorizationOrder = 0;
  constructor(private readonly root: string, private readonly ports: ReleaseAuthorizationPorts) {}
  private current(): void { if (this.ports.current?.() === false) throw new ReleaseAuthorizationError("release authorization unavailable during lifecycle transition"); }
  /** #1120: a checker that is missing or failed is its own refusal; only evidence that is read and not fresh is "stale documentation". An injected reader keeps its undefined meaning (no evidence). */
  private async docs(commit: string, version: string): Promise<ReleaseDocsVerdict | undefined> {
    if (this.ports.docs) return docsVerdict(await this.ports.docs(this.root), commit, version);
    const read = await readDocEvidenceDetailed(this.root, undefined, this.ports.checker);
    if ("unavailable" in read) throw new ReleaseAuthorizationError(`release authorization needs the documentation checker: ${read.unavailable}`);
    return docsVerdict(read.evidence, commit, version);
  }
  private actor(by: PeerId): void {
    if (by !== USER && (typeof by !== "string" || !by.trim() || this.ports.conductor?.() !== by)) throw new ReleaseAuthorizationError("only the person or the configured conductor may authorize a release");
  }
  private git(): ReleaseGit {
    let remaining = 5000;
    return args => {
      if (remaining <= 0) return { code: 1, stdout: "" };
      const start = performance.now();
      try {
        if (this.ports.git) return this.ports.git(args);
        const result = hubGitSync(args, { cwd: this.root, env: hubGitEnv(process.env, { repositoryIsolation: true }), encoding: "utf8", timeout: Math.max(1, Math.min(1000, remaining)), maxBuffer: 256 * 1024 });
        return { code: result.status ?? 1, stdout: result.stdout ?? "" };
      } finally { remaining -= performance.now() - start; }
    };
  }
  private read(git: ReleaseGit, args: string[]): string {
    const result = git(args);
    if (result.code !== 0 || Buffer.byteLength(result.stdout) > 256 * 1024) throw new ReleaseAuthorizationError("release target evidence unavailable");
    return result.stdout.trim();
  }
  private policy(git: ReleaseGit, commit: string): ReleasePolicy {
    try { return structuredClone(this.ports.policy ? this.ports.policy(commit, git) : DEFAULT_RELEASE_POLICY); }
    catch (error) {
      const detail = error instanceof Error && error.message.length <= 300 ? `: ${error.message}` : "";
      throw new ReleaseAuthorizationError(`committed release policy unavailable${detail}`);
    }
  }
  private origin(git: ReleaseGit, remote = "origin"): Origin {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(remote) || remote.startsWith("-")) throw new ReleaseAuthorizationError("release guard requires a configured named remote");
    const urls = this.read(git, ["remote", "get-url", "--push", "--all", remote]).split("\n");
    if (!urls.length || urls.length > 8 || urls.some(url => !url || url.length > 4096 || /[\p{Cc}]/u.test(url))) throw new ReleaseAuthorizationError("release remote identity unavailable");
    const sorted = [...new Set(urls)].sort();
    const fetch = this.read(git, ["remote", "get-url", "--all", remote]).split("\n");
    if (!fetch.length || fetch.length > 8 || fetch.some(url => !url || url.length > 4096 || /[\p{Cc}]/u.test(url))) throw new ReleaseAuthorizationError("release remote identity unavailable");
    const repos = [...sorted, ...fetch].map(githubRepo);
    return { hash: digest({ push: sorted, fetch: [...new Set(fetch)].sort() }), urls: sorted, ...(repos[0] && repos.every(repo => repo === repos[0]) ? { repo: repos[0] } : {}) };
  }
  private commit(git: ReleaseGit, ref: string): string {
    if (!ref || ref.length > 256 || ref.startsWith("-") || /[\s\p{Cc}]/u.test(ref)) throw new ReleaseAuthorizationError("invalid release source ref");
    const commit = this.read(git, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    if (!SHA.test(commit)) throw new ReleaseAuthorizationError("release commit unavailable");
    return commit;
  }
  private packageVersion(git: ReleaseGit, commit: string, policy?: ReleasePolicy, purpose: "authorization" | "npm" = "authorization"): string {
    if (!SHA.test(commit)) throw new ReleaseAuthorizationError("invalid release commit");
    let value: unknown;
    try { value = JSON.parse(this.read(git, ["show", `${commit}:package.json`])).version; } catch {
      if (!this.ports.policy) throw new ReleaseAuthorizationError("committed package version unavailable");
      throw new ReleaseAuthorizationError(purpose === "npm"
        ? "npm publish needs a committed package.json version to identify its target; add package.json with the target version"
        : `committed package version unavailable; set release.version to release-notes or none in .agenthub/config.json and commit it${policy ? ` (current source: ${policy.version.source})` : ""}`);
    }
    if (!validReleaseVersion(value)) {
      if (!this.ports.policy) throw new ReleaseAuthorizationError("committed package version unavailable");
      throw new ReleaseAuthorizationError(purpose === "npm"
        ? "npm publish needs a valid committed package.json version to identify its target; add package.json with the target version"
        : "committed package version unavailable; set release.version to release-notes or none in .agenthub/config.json and commit it");
    }
    return value;
  }
  private version(git: ReleaseGit, commit: string, policy: ReleasePolicy, requested?: string): string {
    if (policy.version.source === "package.json") return this.packageVersion(git, commit, policy);
    if (policy.version.source === "none") {
      if (!requested || !validReleaseVersion(requested)) throw new ReleaseAuthorizationError("release.version is none; provide the requested semantic version and exact candidate commit");
      return requested;
    }
    if (!requested || !validReleaseVersion(requested)) throw new ReleaseAuthorizationError("release.version is release-notes; provide the requested semantic version and exact candidate commit");
    const path = policy.version.notesPath.replace("{version}", requested);
    if (!hasCommittedReleaseNotes(git, commit, path)) throw new ReleaseAuthorizationError(`committed release notes missing: ${path}; add ${path} at the candidate commit`);
    return requested;
  }
  private docsPolicy(commit: string, policy: ReleasePolicy, version: string): Promise<ReleaseDocsReceipt | undefined> {
    return policy.docs.source === "none" ? Promise.resolve({ source: "none" }) : this.docs(commit, version);
  }
  async authorize(by: string, version: unknown, expectedCommit: unknown): Promise<ReleaseAuthorization> {
    this.actor(by);
    if (!validReleaseVersion(version) || typeof expectedCommit !== "string" || !SHA.test(expectedCommit)) throw new ReleaseAuthorizationError("authorization needs an exact version and candidate commit");
    this.current();
    const git = this.git(), commit = this.commit(git, "HEAD"), origin = this.origin(git), policy = this.policy(git, commit);
    if (commit !== expectedCommit) throw new ReleaseAuthorizationError("candidate commit differs from the person's request");
    const sourceVersion = this.version(git, commit, policy, version);
    if (sourceVersion !== version) throw new ReleaseAuthorizationError(policy.version.source === "package.json" && this.ports.policy
      ? `committed package.json version is ${sourceVersion}, not ${version}; set release.version in .agenthub/config.json to release-notes or none, or update package.json and commit it`
      : "candidate version differs from the person's request for the configured source");
    const docs = await this.docsPolicy(commit, policy, version);
    if (!docs) throw new ReleaseAuthorizationError("release authorization requires fresh committed documentation evidence: run `node scripts/check-docs.mjs --committed` in the candidate checkout, restamp the stale documents in a committed change, then authorize again");
    this.current(); this.actor(by);
    const currentPolicy = this.policy(git, commit);
    if (this.commit(git, "HEAD") !== commit || JSON.stringify(currentPolicy) !== JSON.stringify(policy) || this.version(git, commit, currentPolicy, version) !== version || this.origin(git).hash !== origin.hash) throw new ReleaseAuthorizationError("release candidate or committed release policy changed during authorization");
    this.current(); this.actor(by);
    const receipt: ReleaseAuthorization = { schemaVersion: 1, id: randomUUID(), by, commit, version, at: (this.ports.now ?? Date.now)(), docs };
    if (!this.ports.record(structuredClone(receipt))) throw new ReleaseAuthorizationError("release approval audit could not be recorded");
    const entry = { receipt, origin, policy: structuredClone(policy), order: ++this.authorizationOrder };
    this.entries.set(`${version}:${commit}`, entry); this.latest = entry;
    // ponytail: retain at most 64 approvals in this daemon generation; older candidates need a new person approval.
    if (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
    return structuredClone(receipt);
  }
  /** Host-only report source selector. It reads no caller-selected version and never writes the ledger. */
  reportPolicy(head: string, repo: string): ReleaseReportPolicy | undefined {
    const unavailable = (versionSource: ReleaseReportPolicy["versionSource"] = "unknown", docsSource: ReleaseReportPolicy["docsSource"] = "unknown"): ReleaseReportPolicy => ({ versionSource, docsSource, authorization: "unavailable" });
    if (!SHA.test(head) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return unavailable();
    const git = this.git();
    let policy: ReleasePolicy;
    try { policy = this.policy(git, head); } catch { return unavailable(); }
    if (policy.version.source === "package.json" && policy.docs.source === "checker") return;
    let packageVersion: string | undefined;
    if (policy.version.source === "package.json") {
      try { packageVersion = this.packageVersion(git, head, policy); } catch { return unavailable(policy.version.source, policy.docs.source); }
    }
    let origin: Origin;
    try {
      if (this.commit(git, "HEAD") !== head) return { versionSource: policy.version.source, docsSource: policy.docs.source, authorization: "stale", ...(packageVersion ? { version: packageVersion } : {}) };
      origin = this.origin(git);
    } catch { return unavailable(policy.version.source, policy.docs.source); }
    const candidates = [...this.entries.values()].filter(entry => entry.receipt.commit === head
      && entry.origin.hash === origin.hash && entry.origin.repo?.toLowerCase() === repo.toLowerCase()
      && JSON.stringify(entry.policy) === JSON.stringify(policy)
      && (packageVersion === undefined || entry.receipt.version === packageVersion));
    const entry = candidates.reduce<Entry | undefined>((latest, current) => !latest || current.order > latest.order ? current : latest, undefined);
    if (!entry) return { versionSource: policy.version.source, docsSource: policy.docs.source, authorization: "missing", ...(packageVersion ? { version: packageVersion } : {}) };
    const version = policy.version.source === "package.json" ? packageVersion : entry.receipt.version;
    if (!version || !validReleaseVersion(version) || entry.receipt.version !== version) return { versionSource: policy.version.source, docsSource: policy.docs.source, authorization: "stale" };
    if (policy.version.source === "release-notes") {
      const notes = policy.version.notesPath.replace("{version}", version);
      if (!hasCommittedReleaseNotes(git, head, notes)) return { versionSource: policy.version.source, docsSource: policy.docs.source, authorization: "stale" };
    }
    if (policy.docs.source === "none" ? !("source" in entry.receipt.docs) : !("digest" in entry.receipt.docs)) {
      return { versionSource: policy.version.source, docsSource: policy.docs.source, authorization: "stale" };
    }
    try {
      if (this.commit(git, "HEAD") !== head || this.origin(git).hash !== origin.hash) return { versionSource: policy.version.source, docsSource: policy.docs.source, authorization: "stale" };
    } catch { return unavailable(policy.version.source, policy.docs.source); }
    return { versionSource: policy.version.source, docsSource: policy.docs.source, authorization: "matched", version };
  }
  private matched(git: ReleaseGit, version: string, commit: string, remote?: string, url?: string): ReleaseAuthorization {
    this.current();
    const entry = this.entries.get(`${version}:${commit}`);
    if (!entry) throw new ReleaseAuthorizationError("no matching person release authorization; ask the person to authorize this commit and version");
    const policy = this.policy(git, commit);
    if (JSON.stringify(policy) !== JSON.stringify(entry.policy)) throw new ReleaseAuthorizationError("committed release policy differs from the authorized candidate");
    const candidateVersion = this.version(git, commit, policy, version);
    if (candidateVersion !== version) {
      if (!this.ports.policy) throw new ReleaseAuthorizationError("no matching person release authorization; ask the person to authorize this commit and version");
      throw new ReleaseAuthorizationError(policy.version.source === "package.json"
        ? `committed package.json version is ${candidateVersion}, not ${version}; update package.json and commit the requested release version`
        : `committed ${policy.version.source} source identifies ${candidateVersion}, not ${version}; update the committed release source`);
    }
    const origin = this.origin(git);
    if (origin.hash !== entry.origin.hash || remote && this.origin(git, remote).hash !== origin.hash || url !== undefined && !origin.urls.includes(url)) throw new ReleaseAuthorizationError("release remote differs from the authorized project");
    return structuredClone(entry.receipt);
  }
  async guardRequest(request: ReleaseGuardRequest): Promise<ReleaseGuardVerdict> {
    try {
      this.current(); const git = this.git();
      if (request.kind === "tag-push") {
        const commit = this.commit(git, request.sourceRef);
        return { ok: true, receipts: [this.matched(git, request.version, commit, request.remote)] };
      }
      if (request.kind === "npm-publish") {
        if (!releaseTrackedClean(this.root, git)) throw new ReleaseAuthorizationError("npm publish requires a clean tracked worktree");
        const commit = this.commit(git, "HEAD"), version = this.packageVersion(git, commit, undefined, "npm");
        const receipt = this.matched(git, version, commit);
        const policy = this.policy(git, commit), docs = await this.docsPolicy(commit, policy, version);
        this.current();
        const docsMatch = !!docs && ("source" in docs ? "source" in receipt.docs && receipt.docs.source === "none"
          : "digest" in receipt.docs && docs.digest === receipt.docs.digest);
        if (!docsMatch || this.commit(git, "HEAD") !== commit || JSON.stringify(this.policy(git, commit)) !== JSON.stringify(policy) || !releaseTrackedClean(this.root, git)) throw new ReleaseAuthorizationError("publish checkout, release policy or documentation evidence changed");
        return { ok: true, receipts: [this.matched(git, version, commit)] };
      }
      const origin = this.origin(git), repo = origin.repo;
      if (!repo || !this.ports.gh) throw new ReleaseAuthorizationError("GitHub release target evidence unavailable");
      const [owner, name] = repo.split("/");
      const query = "query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{... on Commit{oid} ... on Tag{target{... on Commit{oid}}}}}}}";
      const result = await this.ports.gh(["api", "graphql", "--hostname", "github.com", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `ref=refs/tags/${request.tag}`], 10000);
      let commit: string;
      try {
        const body = JSON.parse(result.stdout), repository = body?.data?.repository;
        if (result.code !== 0 || body.errors || !repository || !Object.hasOwn(repository, "ref")) throw new ReleaseAuthorizationError();
        if (repository.ref === null) {
          if (!request.target || !SHA.test(request.target)) throw new ReleaseAuthorizationError();
          commit = this.commit(git, request.target);
        } else {
          commit = repository.ref.target?.oid ?? repository.ref.target?.target?.oid;
          if (!SHA.test(commit)) throw new ReleaseAuthorizationError();
        }
      } catch { throw new ReleaseAuthorizationError("GitHub tag unknown, or a new release lacks an explicit full commit target"); }
      this.current();
      if (this.origin(git).hash !== origin.hash) throw new ReleaseAuthorizationError("release remote changed during readback");
      return { ok: true, receipts: [this.matched(git, request.version, commit)] };
    } catch (error) { return { ok: false, error: releaseAuthorizationError(error) }; }
  }
  guardPush(remoteName: string, remoteUrl: string, updates: readonly ReleasePushUpdate[]): ReleaseGuardVerdict {
    try {
      this.current(); const git = this.git(), receipts: ReleaseAuthorization[] = [];
      if (updates.length > 128) throw new ReleaseAuthorizationError("release push inventory exceeds the guard bound");
      for (const update of updates) {
        if (!validReleaseVersion(update.version) || update.remoteRef !== `refs/tags/v${update.version}` || !SHA.test(update.localOid) || /^0+$/.test(update.localOid)) throw new ReleaseAuthorizationError("release push target is invalid or deleted");
        if (this.read(git, ["rev-parse", "--verify", "--end-of-options", update.localRef]) !== update.localOid) throw new ReleaseAuthorizationError("release tag changed after Git captured the push");
        const commit = this.commit(git, update.localOid);
        receipts.push(this.matched(git, update.version, commit, remoteName, remoteUrl));
      }
      return { ok: true, receipts };
    } catch (error) { return { ok: false, error: releaseAuthorizationError(error) }; }
  }
  report<T extends ReleaseReadiness>(report: T): T & { authorization?: { state: "matched" | "stale"; receipt: ReleaseAuthorization } } {
    if (report.releasePolicy) {
      const policy = report.releasePolicy;
      if (policy.authorization !== "matched" || !report.head || !report.version) return report;
      let current: ReleaseReportPolicy | undefined;
      try { current = this.reportPolicy(report.head, report.repo); }
      catch { current = { versionSource: policy.versionSource, docsSource: policy.docsSource, authorization: "unavailable" }; }
      const entry = this.entries.get(`${report.version}:${report.head}`);
      let matched = !!entry && current?.authorization === "matched" && current.version === report.version
        && current.versionSource === policy.versionSource && current.docsSource === policy.docsSource;
      try {
        if (matched) {
          const git = this.git(), candidatePolicy = this.policy(git, entry!.receipt.commit);
          const verdict = report.documents ? docsVerdict(report.documents, report.head, report.version) : undefined;
          matched = JSON.stringify(candidatePolicy) === JSON.stringify(entry!.policy)
            && ("source" in entry!.receipt.docs ? candidatePolicy.docs.source === "none" : !!verdict && verdict.digest === entry!.receipt.docs.digest)
            && this.origin(git).hash === entry!.origin.hash;
        }
      } catch { matched = false; }
      const releasePolicy = { ...policy, authorization: matched ? "matched" as const : "stale" as const };
      if (!matched) return { ...report, releasePolicy, sourceReady: false, ready: false,
        blockers: [...new Set([...report.blockers, "release authorization source is stale; authorize the exact candidate version again"])],
        ...(entry ? { authorization: { state: "stale" as const, receipt: structuredClone(entry.receipt) } } : {}) };
      const blockers = report.blockers.map(item => item === "native acceptance and person release decision unverified" ? "native acceptance unverified" : item);
      return { ...report, releasePolicy, blockers, authorization: { state: "matched", receipt: structuredClone(entry!.receipt) } };
    }
    if (!this.latest) return report;
    const entry = this.entries.get(`${report.version}:${report.head}`), verdict = report.head && report.version ? docsVerdict(report.documents, report.head, report.version) : undefined;
    let matched = !!entry && !!entry.origin.repo && entry.origin.repo.toLowerCase() === report.repo.toLowerCase();
    try {
      if (matched) {
        const git = this.git(), policy = this.policy(git, entry!.receipt.commit);
        matched = JSON.stringify(policy) === JSON.stringify(entry!.policy)
          && this.version(git, entry!.receipt.commit, policy, report.version) === report.version
          && ("source" in entry!.receipt.docs ? policy.docs.source === "none" : !!verdict && verdict.digest === entry!.receipt.docs.digest)
          && this.origin(git).hash === entry!.origin.hash;
      }
    } catch { matched = false; }
    const receipt = structuredClone((matched ? entry! : this.latest).receipt);
    const blockers = matched ? report.blockers.map(item => item === "native acceptance and person release decision unverified" ? "native acceptance unverified" : item) : report.blockers;
    return { ...report, blockers, authorization: { state: matched ? "matched" : "stale", receipt } };
  }
}
