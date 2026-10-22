import { expect, test } from "bun:test";
import { parseReleaseGuardArgv, parseReleasePushUpdates } from "../src/cli/sdlc-release-guard.ts";

const a = "a".repeat(40), b = "b".repeat(40), zero = "0".repeat(40);

test("release command preflight selects only literal single targets", () => {
  expect(parseReleaseGuardArgv(["git", "push", "origin", "v1.2.3"])).toEqual({ ok: true, request: { kind: "tag-push", version: "1.2.3", tag: "v1.2.3", sourceRef: "v1.2.3", remote: "origin" } });
  expect(parseReleaseGuardArgv(["git", "push", "origin", "HEAD:refs/tags/v1.2.3"])).toEqual({ ok: true, request: { kind: "tag-push", version: "1.2.3", tag: "v1.2.3", sourceRef: "HEAD", remote: "origin" } });
  expect(parseReleaseGuardArgv(["git", "push", "origin", "refs/tags/v1.2.3"])).toMatchObject({ ok: true, request: { sourceRef: "refs/tags/v1.2.3", tag: "v1.2.3" } });
  expect(parseReleaseGuardArgv(["gh", "release", "create", "v1.2.3", "--target", a, "--generate-notes", "--title", "Release 1.2.3"])).toMatchObject({ ok: true, request: { kind: "gh-release", version: "1.2.3", target: a } });
  expect(parseReleaseGuardArgv(["npm", "publish", "--access", "public", "--provenance"])).toEqual({ ok: true, request: { kind: "npm-publish" } });
});

for (const argv of [
  ["git", "push", "origin", "--tags"], ["git", "push", "origin", "--follow-tags"],
  ["git", "push", "origin", "v1.2.3", "v2.0.0"], ["git", "push", "origin", ":refs/tags/v1.2.3"],
  ["git", "push", "origin", "+v1.2.3"], ["git", "push", "origin", "refs/tags/v*:refs/tags/v*"],
  ["git", "-C", "/other", "push", "origin", "v1.2.3"], ["git", "push", "https://example.test/repo", "v1.2.3"],
  ["git push origin v1.2.3"], ["sh", "-c", "git push origin v1.2.3"],
  ["gh", "release", "create", "v1.2.3", "--repo", "other/repo"], ["gh", "release", "create", "v1.2.3", "--target", "$BRANCH"],
  ["npm", "publish", "../other"], ["npm", "publish", "--registry", "https://example.test"], ["npm", "publish", "--workspace", "other"],
]) {
  test(`release command preflight refuses ambiguous scope: ${argv.join(" ")}`, () => expect(parseReleaseGuardArgv(argv).ok).toBe(false));
}

test("release parser bounds both argv and hook input", () => {
  expect(parseReleaseGuardArgv(Array(129).fill("arg")).ok).toBe(false);
  expect(parseReleaseGuardArgv(["npm", "publish", "x".repeat(16_385)]).ok).toBe(false);
  expect(parseReleasePushUpdates("origin", "https://example.test/repo", "x".repeat(128 * 1024 + 1)).ok).toBe(false);
  expect(parseReleasePushUpdates("origin", "https://example.test/repo", `refs/heads/main ${a} refs/heads/main ${b}\n`.repeat(129)).ok).toBe(false);
});

test("pre-push parsing validates every row and preserves exact stdin", () => {
  const stdin = `refs/heads/main ${a} refs/heads/main ${b}\nrefs/tags/v1.2.3 ${a} refs/tags/v1.2.3 ${zero}\n`;
  expect(parseReleasePushUpdates("origin", "git@example.test:org/repo.git", stdin)).toEqual({ ok: true, remoteName: "origin", remoteUrl: "git@example.test:org/repo.git", stdin, updates: [{ localRef: "refs/tags/v1.2.3", localOid: a, remoteRef: "refs/tags/v1.2.3", remoteOid: zero, version: "1.2.3" }] });
  expect(parseReleasePushUpdates("origin", "https://example.test/repo", "")).toMatchObject({ ok: true, stdin: "", updates: [] });
  expect(parseReleasePushUpdates("origin", "https://example.test/repo", `refs/heads/main ${a} refs/heads/main ${zero}`)).toMatchObject({ ok: true, updates: [] });
});

for (const stdin of [
  `(delete) ${zero} refs/tags/v1.2.3 ${a}\n`,
  `refs/tags/vbad ${a} refs/tags/vbad ${zero}\n`,
  `refs/heads/main broken refs/heads/main ${a}\n`,
  `refs/heads/main ${a} refs/heads/main ${b} extra\n`,
  `refs/heads/main ${a} refs/heads/../bad ${b}\n`,
]) test("pre-push refuses malformed or deleted version-tag update: " + stdin.trim(), () => expect(parseReleasePushUpdates("origin", "https://example.test/repo", stdin).ok).toBe(false));


test("branch-only hook data preserves Unicode refs and remote paths with spaces", () => {
  const stdin = `refs/heads/한국어$자료\`원문 ${a} refs/heads/한국어$자료\`원문 ${b}\n`;
  expect(parseReleasePushUpdates("원격 이름", "/tmp/내 저장소.git", stdin)).toEqual({ ok: true, remoteName: "원격 이름", remoteUrl: "/tmp/내 저장소.git", stdin, updates: [] });
});
