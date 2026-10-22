import { expect, test } from "bun:test";
import { ReleaseAuthorizations, type ReleaseAuthorization } from "../src/hub/sdlc-release-authorization.ts";
import type { DocEvidence, ReleaseGit, ReleaseReadiness } from "../src/hub/sdlc-release.ts";
import type { ReleasePushUpdate } from "../src/cli/sdlc-release-guard.ts";

const A = "a".repeat(40), B = "b".repeat(40), OBJECT = "c".repeat(40), ZERO = "0".repeat(40);
const URL = "https://github.com/example/repo.git";
const fresh = (head = A, version = "1.2.3"): DocEvidence => ({ schemaVersion: 1, head, version, fresh: true, errors: 0, documents: [{ path: "README.md", state: "fresh", verifiedAgainst: head, commits: 0, dirty: false }] });
function fixture() {
  const state = {
    head: A, tagCommit: A, tagOid: A, push: [URL], fetch: [URL], docs: fresh() as DocEvidence | undefined,
    versions: new Map([[A, "1.2.3"], [B, "1.2.4"]]), live: true, audit: true, dirty: "",
    remoteTag: A as string | null, ghCode: 0, ghErrors: false,
  };
  const reads: string[][] = [], remoteReads: string[][] = [], recorded: ReleaseAuthorization[] = [];
  let docsRead: () => Promise<DocEvidence | undefined> = async () => state.docs;
  const git: ReleaseGit = args => {
    reads.push([...args]);
    if (args[0] === "status") return { code: 0, stdout: state.dirty };
    if (args[0] === "remote") return { code: 0, stdout: (args.includes("--push") ? state.push : state.fetch).join("\n") };
    if (args[0] === "show") {
      const commit = args[1]?.split(":")[0] ?? "", version = state.versions.get(commit);
      return version ? { code: 0, stdout: JSON.stringify({ version }) } : { code: 1, stdout: "" };
    }
    if (args[0] === "rev-parse") {
      const selector = args.at(-1)!;
      const peeled = selector.endsWith("^{commit}"), ref = peeled ? selector.slice(0, -9) : selector;
      let value: string | undefined;
      if (ref === "HEAD") value = state.head;
      else if (ref === "v1.2.3" || ref === "refs/tags/v1.2.3") value = peeled ? state.tagCommit : state.tagOid;
      else if (ref === OBJECT && peeled) value = A;
      else if (state.versions.has(ref)) value = ref;
      return value ? { code: 0, stdout: value } : { code: 1, stdout: "" };
    }
    throw new Error("unexpected Git fixture operation: " + args.join(" "));
  };
  const ports = {
    git, now: () => 1234, current: () => state.live,
    docs: () => docsRead(),
    record: (receipt: ReleaseAuthorization) => { recorded.push(receipt); return state.audit; },
    gh: async (args: string[]) => {
      remoteReads.push([...args]);
      return { code: state.ghCode, stdout: JSON.stringify({ ...(state.ghErrors ? { errors: [{ message: "unavailable" }] } : {}), data: { repository: { ref: state.remoteTag === null ? null : { target: { oid: state.remoteTag } } } } }) };
    },
  };
  const host = new ReleaseAuthorizations("/fixture/project", ports);
  const update = (): ReleasePushUpdate => ({ localRef: "refs/tags/v1.2.3", localOid: state.tagOid, remoteRef: "refs/tags/v1.2.3", remoteOid: ZERO, version: "1.2.3" });
  const report = (): ReleaseReadiness => ({ repo: "example/repo", head: A, version: "1.2.3", commits: [], mergedPrs: [], documents: fresh(), liveIssues: [], blockers: ["native acceptance and person release decision unverified"], sourceReady: true, native: "unverified", ready: false });
  return { host, state, reads, remoteReads, recorded, ports, update, report, docsRead: (read: typeof docsRead) => { docsRead = read; } };
}

test("S6 authorization is person-only before any evidence or audit read", async () => {
  const f = fixture();
  await expect(f.host.authorize("codex", "1.2.3", A)).rejects.toThrow("only the person");
  expect(f.reads).toEqual([]); expect(f.remoteReads).toEqual([]); expect(f.recorded).toEqual([]);
  await expect(f.host.authorize("user", "1.2.3", "short")).rejects.toThrow();
  expect(f.reads).toEqual([]);
});

test("S6 a fresh authorization binds exact commit, version, docs verdict and daemon generation", async () => {
  const f = fixture(), receipt = await f.host.authorize("user", "1.2.3", A);
  expect(receipt).toMatchObject({ schemaVersion: 1, by: "user", commit: A, version: "1.2.3", at: 1234, docs: { fresh: true, errors: 0, documents: 1 } });
  expect(receipt.docs.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(f.host.guardPush("origin", URL, [f.update()])).toMatchObject({ ok: true });
  expect(await f.host.guardRequest({ kind: "npm-publish" })).toMatchObject({ ok: true });
  const restarted = new ReleaseAuthorizations("/fixture/project", f.ports);
  expect(restarted.guardPush("origin", URL, [f.update()])).toMatchObject({ ok: false });
  expect(restarted.report(f.report()).authorization).toBeUndefined();
});

test("S6 commit and version mismatches cannot create or match authorization", async () => {
  const f = fixture();
  await expect(f.host.authorize("user", "1.2.3", B)).rejects.toThrow("differs");
  await expect(f.host.authorize("user", "1.2.4", A)).rejects.toThrow("differs");
  expect(f.recorded).toEqual([]);
  await f.host.authorize("user", "1.2.3", A);
  expect(await f.host.guardRequest({ kind: "tag-push", remote: "origin", sourceRef: "v1.2.3", tag: "v1.2.4", version: "1.2.4" })).toMatchObject({ ok: false });
  f.state.head = B;
  expect(await f.host.guardRequest({ kind: "npm-publish" })).toMatchObject({ ok: false });
});

for (const invalid of [undefined, { ...fresh(), fresh: false }, { ...fresh(), errors: 1 }, fresh(B), fresh(A, "1.2.4"), { ...fresh(), documents: [{ state: "stale" as const }] }, { ...fresh(), documents: [{ state: "fresh" as const, dirty: true }] }]) {
  test("S6 authorization refuses unavailable, stale, dirty or mismatched docs: " + JSON.stringify(invalid), async () => {
    const f = fixture(); f.state.docs = invalid;
    await expect(f.host.authorize("user", "1.2.3", A)).rejects.toThrow("fresh committed documentation");
    expect(f.recorded).toEqual([]);
  });
}

test("S6 hook checks the exact captured object identity before peeling an annotated tag", async () => {
  const f = fixture(); await f.host.authorize("user", "1.2.3", A);
  f.state.tagOid = OBJECT;
  const captured = f.update();
  expect(f.host.guardPush("origin", URL, [captured])).toMatchObject({ ok: true });
  f.state.tagOid = A; // Same peeled commit, different object than Git captured.
  expect(f.host.guardPush("origin", URL, [captured])).toMatchObject({ ok: false, error: expect.stringContaining("changed after Git captured") });
  expect(f.host.guardPush("origin", URL, [{ ...captured, localOid: ZERO }])).toMatchObject({ ok: false });
});

for (const field of ["push", "fetch"] as const) {
  test(`S6 authorization refuses ${field} origin drift`, async () => {
    const f = fixture(); await f.host.authorize("user", "1.2.3", A);
    f.state[field] = ["https://github.com/other/repo.git"];
    expect(f.host.guardPush("origin", URL, [f.update()])).toMatchObject({ ok: false });
    expect(f.host.report(f.report()).authorization?.state).toBe("stale");
  });
}

test("S6 hook destination URL must be one of the authorized push URLs", async () => {
  const f = fixture(); await f.host.authorize("user", "1.2.3", A);
  expect(f.host.guardPush("origin", "https://github.com/other/repo.git", [f.update()])).toMatchObject({ ok: false });
});

test("S6 authorization rechecks candidate and lifecycle identity after awaiting docs", async () => {
  const f = fixture();
  let release!: (docs: DocEvidence) => void;
  f.docsRead(() => new Promise(resolve => { release = resolve; }));
  const pending = f.host.authorize("user", "1.2.3", A);
  f.state.head = B; release(fresh());
  await expect(pending).rejects.toThrow("changed during authorization");
  expect(f.recorded).toEqual([]);
  f.state.head = A;
  const pendingLifecycle = f.host.authorize("user", "1.2.3", A);
  f.state.live = false; release(fresh());
  await expect(pendingLifecycle).rejects.toThrow("lifecycle transition");
  expect(f.recorded).toEqual([]);
});

test("S6 npm publish rechecks docs and origin after its asynchronous readback", async () => {
  const f = fixture(); await f.host.authorize("user", "1.2.3", A);
  let release!: (docs: DocEvidence) => void;
  f.docsRead(() => new Promise(resolve => { release = resolve; }));
  const dirty = f.host.guardRequest({ kind: "npm-publish" });
  release({ ...fresh(), fresh: false });
  expect(await dirty).toMatchObject({ ok: false });
  const drift = f.host.guardRequest({ kind: "npm-publish" });
  f.state.fetch = ["https://github.com/other/repo.git"]; release(fresh());
  expect(await drift).toMatchObject({ ok: false });
});

test("S6 failed approval audit leaves no usable authorization", async () => {
  const f = fixture(); f.state.audit = false;
  await expect(f.host.authorize("user", "1.2.3", A)).rejects.toThrow("audit could not be recorded");
  expect(f.host.guardPush("origin", URL, [f.update()])).toMatchObject({ ok: false });
  expect(f.host.report(f.report()).authorization).toBeUndefined();
});

test("S6 returned and audited receipts are clones, including nested docs", async () => {
  const f = fixture(), returned = await f.host.authorize("user", "1.2.3", A);
  const original = structuredClone(returned);
  returned.version = "9.9.9"; returned.docs.digest = "changed";
  f.recorded[0]!.commit = B; f.recorded[0]!.docs.documents = 999;
  const verdict = f.host.guardPush("origin", URL, [f.update()]);
  expect(verdict).toEqual({ ok: true, receipts: [original] });
  if (verdict.ok) verdict.receipts[0]!.docs.digest = "changed again";
  const report = f.host.report(f.report());
  expect(report.authorization).toEqual({ state: "matched", receipt: original });
  expect(report.blockers).toEqual(["native acceptance unverified"]);
  report.authorization!.receipt.version = "8.8.8";
  expect(f.host.report(f.report()).authorization!.receipt).toEqual(original);
});

test("S6 GitHub release uses the actual remote tag, not local HEAD", async () => {
  const f = fixture(); await f.host.authorize("user", "1.2.3", A);
  f.state.head = B;
  expect(await f.host.guardRequest({ kind: "gh-release", tag: "v1.2.3", version: "1.2.3" })).toMatchObject({ ok: true, receipts: [{ commit: A }] });
  expect(f.remoteReads[0]).toContain("ref=refs/tags/v1.2.3");
  expect(f.remoteReads[0]).toContain("--hostname");
  f.state.head = A; f.state.remoteTag = B;
  expect(await f.host.guardRequest({ kind: "gh-release", tag: "v1.2.3", version: "1.2.3" })).toMatchObject({ ok: false });
});

test("S6 a missing remote tag requires an authorized explicit full commit target", async () => {
  const f = fixture(); await f.host.authorize("user", "1.2.3", A); f.state.remoteTag = null;
  expect(await f.host.guardRequest({ kind: "gh-release", tag: "v1.2.3", version: "1.2.3" })).toMatchObject({ ok: false });
  expect(await f.host.guardRequest({ kind: "gh-release", tag: "v1.2.3", version: "1.2.3", target: "main" })).toMatchObject({ ok: false });
  expect(await f.host.guardRequest({ kind: "gh-release", tag: "v1.2.3", version: "1.2.3", target: A })).toMatchObject({ ok: true });
  expect(await f.host.guardRequest({ kind: "gh-release", tag: "v1.2.3", version: "1.2.3", target: B })).toMatchObject({ ok: false });
  f.state.ghCode = 1;
  expect(await f.host.guardRequest({ kind: "gh-release", tag: "v1.2.3", version: "1.2.3", target: A })).toMatchObject({ ok: false });
});

for (const field of ["push", "fetch"] as const) {
  test(`S6 ${field} origin drift during the authorization docs await refuses before audit`, async () => {
    const f = fixture();
    let release!: (docs: DocEvidence) => void;
    f.docsRead(() => new Promise(resolve => { release = resolve; }));
    const pending = f.host.authorize("user", "1.2.3", A);
    f.state[field] = ["https://github.com/other/repo.git"]; release(fresh());
    await expect(pending).rejects.toThrow("changed during authorization");
    expect(f.recorded).toEqual([]);
  });
}

test("S6 changed documentation verdict invalidates publish and report without changing HEAD", async () => {
  const f = fixture(); await f.host.authorize("user", "1.2.3", A);
  const changed = fresh(); changed.documents[0]!.verifiedAgainst = B;
  f.state.docs = changed;
  expect(await f.host.guardRequest({ kind: "npm-publish" })).toMatchObject({ ok: false });
  const report = f.report(); report.documents = changed;
  expect(f.host.report(report).authorization?.state).toBe("stale");
});


test("S6 authorization report is bound to its known GitHub repository ignoring case", async () => {
  const f = fixture(); await f.host.authorize("user", "1.2.3", A);
  expect(f.host.report({ ...f.report(), repo: "EXAMPLE/REPO" }).authorization?.state).toBe("matched");
  const foreign = f.host.report({ ...f.report(), repo: "other/repo" });
  expect(foreign.authorization?.state).toBe("stale");
  expect(foreign.blockers).toContain("native acceptance and person release decision unverified");
  f.state.fetch = f.state.push = ["https://example.test/repo.git"];
  await f.host.authorize("user", "1.2.3", A);
  expect(f.host.report(f.report()).authorization?.state).toBe("stale");
});

test("S6 npm preflight refuses tracked changes at the same HEAD before and after docs read", async () => {
  const f = fixture(); await f.host.authorize("user", "1.2.3", A);
  f.state.dirty = " M src/index.ts";
  expect(await f.host.guardRequest({ kind: "npm-publish" })).toMatchObject({ ok: false, error: expect.stringContaining("clean tracked worktree") });
  f.state.dirty = "";
  f.docsRead(async () => { f.state.dirty = " M src/index.ts"; return fresh(); });
  expect(await f.host.guardRequest({ kind: "npm-publish" })).toMatchObject({ ok: false });
});
