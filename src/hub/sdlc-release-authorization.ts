import { releaseTrackedClean } from "./release-worktree.ts";
import { createHash, randomUUID } from "node:crypto";
import { USER } from "./envelope.ts";
import { hubGitEnv, hubGitSync } from "./git.ts";
import { readDocEvidence, type DocEvidence, type ReleaseGit, type ReleaseReadiness } from "./sdlc-release.ts";
import type { SdlcGh } from "./sdlc.ts";
import type { ReleaseGuardRequest, ReleasePushUpdate } from "../cli/sdlc-release-guard.ts";

class ReleaseAuthorizationError extends Error {}
export const releaseAuthorizationError = (error: unknown): string => error instanceof ReleaseAuthorizationError ? error.message : "release authorization evidence unavailable";

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const validReleaseVersion = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && VERSION.test(value);
export interface ReleaseDocsVerdict { fresh: true; errors: 0; documents: number; digest: string }
export interface ReleaseAuthorization { schemaVersion: 1; id: string; by: typeof USER; commit: string; version: string; at: number; docs: ReleaseDocsVerdict }
export interface ReleaseAuthorizationPorts {
  git?: ReleaseGit;
  docs?: (root: string) => Promise<DocEvidence | undefined>;
  gh?: SdlcGh;
  now?: () => number;
  current?: () => boolean;
  record: (receipt: ReleaseAuthorization) => boolean;
}
export type ReleaseGuardVerdict = { ok: true; receipts: ReleaseAuthorization[] } | { ok: false; error: string };
interface Origin { hash: string; urls: string[]; repo?: string }
interface Entry { receipt: ReleaseAuthorization; origin: Origin }
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
  constructor(private readonly root: string, private readonly ports: ReleaseAuthorizationPorts) {}
  private current(): void { if (this.ports.current?.() === false) throw new ReleaseAuthorizationError("release authorization unavailable during lifecycle transition"); }
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
  private version(git: ReleaseGit, commit: string): string {
    if (!SHA.test(commit)) throw new ReleaseAuthorizationError("invalid release commit");
    let value: unknown;
    try { value = JSON.parse(this.read(git, ["show", `${commit}:package.json`])).version; } catch { throw new ReleaseAuthorizationError("committed package version unavailable"); }
    if (!validReleaseVersion(value)) throw new ReleaseAuthorizationError("committed package version unavailable");
    return value;
  }
  async authorize(by: string, version: unknown, expectedCommit: unknown): Promise<ReleaseAuthorization> {
    if (by !== USER) throw new ReleaseAuthorizationError("only the person may authorize a release");
    if (!validReleaseVersion(version) || typeof expectedCommit !== "string" || !SHA.test(expectedCommit)) throw new ReleaseAuthorizationError("authorization needs an exact version and candidate commit");
    this.current();
    const git = this.git(), commit = this.commit(git, "HEAD"), origin = this.origin(git);
    if (commit !== expectedCommit || this.version(git, commit) !== version) throw new ReleaseAuthorizationError("candidate commit or version differs from the person's request");
    const docs = docsVerdict(await (this.ports.docs ?? readDocEvidence)(this.root), commit, version);
    if (!docs) throw new ReleaseAuthorizationError("release authorization requires fresh committed documentation evidence");
    this.current();
    if (this.commit(git, "HEAD") !== commit || this.version(git, commit) !== version || this.origin(git).hash !== origin.hash) throw new ReleaseAuthorizationError("release candidate changed during authorization");
    const receipt: ReleaseAuthorization = { schemaVersion: 1, id: randomUUID(), by: USER, commit, version, at: (this.ports.now ?? Date.now)(), docs };
    if (!this.ports.record(structuredClone(receipt))) throw new ReleaseAuthorizationError("release approval audit could not be recorded");
    const entry = { receipt, origin };
    this.entries.set(`${version}:${commit}`, entry); this.latest = entry;
    // ponytail: retain at most 64 approvals in this daemon generation; older candidates need a new person approval.
    if (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
    return structuredClone(receipt);
  }
  private matched(git: ReleaseGit, version: string, commit: string, remote?: string, url?: string): ReleaseAuthorization {
    this.current();
    const entry = this.entries.get(`${version}:${commit}`);
    if (!entry || this.version(git, commit) !== version) throw new ReleaseAuthorizationError("no matching person release authorization; ask the person to authorize this commit and version");
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
        const commit = this.commit(git, "HEAD"), version = this.version(git, commit);
        const receipt = this.matched(git, version, commit);
        const docs = docsVerdict(await (this.ports.docs ?? readDocEvidence)(this.root), commit, version);
        this.current();
        if (!docs || docs.digest !== receipt.docs.digest || this.commit(git, "HEAD") !== commit || !releaseTrackedClean(this.root, git)) throw new ReleaseAuthorizationError("publish checkout or documentation evidence changed");
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
    if (!this.latest) return report;
    const entry = this.entries.get(`${report.version}:${report.head}`), verdict = report.head && report.version ? docsVerdict(report.documents, report.head, report.version) : undefined;
    let matched = !!entry && !!entry.origin.repo && entry.origin.repo.toLowerCase() === report.repo.toLowerCase() && !!verdict && verdict.digest === entry.receipt.docs.digest;
    try { matched &&= this.origin(this.git()).hash === entry!.origin.hash; } catch { matched = false; }
    const receipt = structuredClone((matched ? entry! : this.latest).receipt);
    const blockers = matched ? report.blockers.map(item => item === "native acceptance and person release decision unverified" ? "native acceptance unverified" : item) : report.blockers;
    return { ...report, blockers, authorization: { state: matched ? "matched" : "stale", receipt } };
  }
}
