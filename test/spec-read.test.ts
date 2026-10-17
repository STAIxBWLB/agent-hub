import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchSpec, specAvailable, specRefs } from "../src/hub/spec-read.ts";

const repo = "owner/project", dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fake(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-spec-")); dirs.push(dir);
  const file = join(dir, "gh");
  writeFileSync(file, `#!${process.execPath}\n${body}`); chmodSync(file, 0o755);
  return { dir, path: dir };
}
const row = (patch: Record<string, unknown> = {}) => ({ number: 418, title: "A whole contract", state: "open", updated_at: "2026-10-17T00:00:00Z", repository_url: `https://api.github.com/repos/${repo}`, html_url: `https://github.com/${repo}/issues/418`, body: "first line\n\nlast line", ...patch });
const response = (value: unknown) => fake(`process.stdout.write(${JSON.stringify(JSON.stringify(value))});`);
const screen = () => true;

test("spec references are task-bound, deduplicated and capped, including refs (#418)", () => {
  expect(specRefs({ title: "#418 owner/project#418", detail: "#2", refs: { paths: ["#3"] } }, repo)).toEqual([418, 2, 3]);
  expect(specRefs({ title: "no contract", detail: "", refs: {} }, repo)).toEqual([]);
  for (const title of ["foreign/repo#418", "#1 #2 #3 #4"]) expect(() => specRefs({ title, detail: "", refs: {} }, repo)).toThrow();
  expect(() => specRefs({ title: "#418", detail: "", refs: { repo: "foreign/repo" } }, repo)).toThrow("other repository");
  expect(() => specRefs({ title: "#418", detail: "", refs: {} }, "../owner/project")).toThrow("other repository");
});

test("spec fetch uses fixed argv and returns the complete title/body through one screen (#418)", async () => {
  const r = row(), f = fake("");
  const record = join(f.dir, "record.json");
  writeFileSync(join(f.dir, "gh"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2), host:process.env.GH_HOST, prompt:process.env.GH_PROMPT_DISABLED, update:process.env.GH_NO_UPDATE_NOTIFIER})); process.stdout.write(${JSON.stringify(JSON.stringify(r))});`);
  const seen: string[] = [];
  const result = await fetchSpec(repo, 418, { ...f, screen: text => { seen.push(text); return true; } });
  expect(result.body).toBe(r.body);
  expect(seen).toEqual([`${r.title}\n${r.body}`]);
  expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ args: ["api", "-X", "GET", "repos/owner/project/issues/418"], host: "github.com", prompt: "1", update: "1" });
});

test("spec fetch refuses transferred issues, wrong numbers and malformed responses (#418)", async () => {
  for (const patch of [{ repository_url: "https://api.github.com/repos/foreign/repo" }, { html_url: "https://github.com/foreign/repo/issues/418" }, { html_url: `https://github.com/${repo}/issues/418?token=secret` }]) {
    await expect(fetchSpec(repo, 418, { ...response(row(patch)), screen })).rejects.toThrow("other repository");
  }
  for (const patch of [{ number: 419 }, { title: undefined }, { body: 42 }]) await expect(fetchSpec(repo, 418, { ...response(row(patch)), screen })).rejects.toThrow("not found");
  expect((await fetchSpec(repo, 418, { ...response(row({ body: null, html_url: `https://github.com/${repo}/pull/418` })), screen })).body).toBe("");
});

test("spec caps count UTF-8 bytes and whole serialized output without truncating (#418)", async () => {
  const body = "가".repeat(21846);
  await expect(fetchSpec(repo, 418, { ...response(row({ body })), screen })).rejects.toThrow("spec too large (65538 > 65536)");
  await expect(fetchSpec(repo, 418, { ...response(row({ body: "\n".repeat(45000) })), screen })).rejects.toThrow("too large");
  expect((await fetchSpec(repo, 418, { ...response(row({ body: "x".repeat(65536) })), screen })).body.length).toBe(65536);
});

test("policy denial and failure withhold the whole spec and leak no remote text (#418)", async () => {
  for (const policy of [() => false, () => { throw new Error("private policy marker"); }]) {
    await expect(fetchSpec(repo, 418, { ...response(row({ body: "secret remote marker" })), screen: policy })).rejects.toThrow("spec withheld by privacy policy");
  }
});

test("gh failures are bounded and neutral, with no retries or raw stderr (#418)", async () => {
  const missing = mkdtempSync(join(tmpdir(), "ahub-spec-missing-")); dirs.push(missing);
  await expect(fetchSpec(repo, 418, { path: missing, screen })).rejects.toThrow("gh unavailable");
  const auth = fake(`process.stderr.write('token marker'); process.exit(4);`);
  await expect(fetchSpec(repo, 418, { ...auth, screen })).rejects.toThrow("unauthenticated");
  const notFound = fake(`process.stderr.write('token marker'); process.stdout.write('{"status":404}'); process.exit(1);`);
  await expect(fetchSpec(repo, 418, { ...notFound, screen })).rejects.toThrow("not found");
  const hanging = fake(`setInterval(()=>{},1000);`);
  await expect(fetchSpec(repo, 418, { ...hanging, timeoutMs: 20, screen })).rejects.toThrow("timeout");
  const overflow = fake(`process.stdout.write('x'.repeat(512*1024+1));`);
  await expect(fetchSpec(repo, 418, { ...overflow, screen })).rejects.toThrow("too large");
});

test("spec availability is a bounded fixed auth query with neutral reasons (#418)", async () => {
  const f = fake(`if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['auth','status','--hostname','github.com']))process.exit(1);`);
  expect(await specAvailable(f)).toEqual({ available: true });
  expect(await specAvailable(fake("process.exit(1);"))).toEqual({ available: false, reason: "gh unauthenticated" });
  expect(await specAvailable({ ...fake("setInterval(()=>{},1000);"), timeoutMs: 20 })).toEqual({ available: false, reason: "timeout" });
});


test("spec host boundary refuses project PATH shims, including external symlinks into project (#418)", async () => {
  const shim = fake("throw new Error('a repo shim must never execute');"), outside = fake("");
  await expect(fetchSpec(repo, 418, { ...shim, projectDir: shim.dir, screen })).rejects.toThrow("gh unavailable");
  rmSync(join(outside.dir, "gh")); symlinkSync(join(shim.dir, "gh"), join(outside.dir, "gh"));
  await expect(fetchSpec(repo, 418, { ...outside, projectDir: shim.dir, screen })).rejects.toThrow("gh unavailable");
  expect(await specAvailable({ ...shim, projectDir: shim.dir })).toEqual({ available: false, reason: "gh unavailable" });
});

test("fake gh PATH seam receives no host authentication tokens or config directory (#418)", async () => {
  const keys = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
  const saved = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "fixture-only-token-marker";
    const f = fake("");
    writeFileSync(join(f.dir, "gh"), `#!${process.execPath}\nif (${JSON.stringify(keys)}.some(key => process.env[key] !== undefined)) process.exit(9); if (process.env.GH_CONFIG_DIR !== ${JSON.stringify(f.dir)}) process.exit(10);`);
    expect(await specAvailable(f)).toEqual({ available: true });
  } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  }
});
