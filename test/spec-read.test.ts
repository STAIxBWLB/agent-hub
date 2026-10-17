import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { PiToolReceipts } from "../src/pi/tool-receipts.ts";
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

test("spec references are task-bound, deduplicated and capped (#418)", () => {
  expect(specRefs({ title: "#418 owner/project#418 #2 #3", detail: "#80", refs: { paths: ["#99"] } }, repo)).toEqual([418, 2, 3]);
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

test("imported GitHub task identity supplies its full spec without textual references (#418)", () => {
  const imported = { title: "Fix the workflow", detail: "Implement the contract", refs: {}, external: { provider: "github" as const, repo, issue: 418, url: `https://github.com/${repo}/issues/418` } };
  expect(specRefs(imported, repo)).toEqual([418]);
  expect(specRefs({ ...imported, title: "#418 #2 #3" }, repo)).toEqual([418, 2, 3]);
  expect(() => specRefs({ ...imported, title: "#2 #3 #4" }, repo)).toThrow("too many spec references");
  expect(() => specRefs({ ...imported, external: { ...imported.external, repo: "foreign/repo" } }, repo)).toThrow("other repository");
  for (const external of [
    { ...imported.external, issue: 0 }, { ...imported.external, issue: Number.MAX_SAFE_INTEGER + 1 },
    { ...imported.external, url: "https://github.com/foreign/repo/issues/418" },
  ]) expect(() => specRefs({ ...imported, external }, repo)).toThrow();
});

test("bare hub task references in detail and paths do not expand a title issue (#418)", () => {
  expect(specRefs({ title: "#418 implement bounded Pi capabilities", detail: "after #80/#81/#83", refs: { paths: ["#99"] } }, repo)).toEqual([418]);
  expect(specRefs({ title: "ordinary work", detail: "after #80/#81/#83", refs: { paths: ["#418"] } }, repo)).toEqual([]);
});

test("qualified and canonical URL issue references in detail use the same origin guard and cap (#418)", () => {
  const base = { title: "work", detail: `owner/project#418 https://github.com/owner/project/issues/2 owner/project#3`, refs: {} };
  expect(specRefs(base, repo)).toEqual([418, 2, 3]);
  for (const detail of ["foreign/repo#418", "https://github.com/foreign/repo/issues/418"]) expect(() => specRefs({ ...base, detail }, repo)).toThrow("other repository");
  expect(() => specRefs({ ...base, detail: base.detail + " https://github.com/owner/project/issues/4" }, repo)).toThrow("too many spec references");
});


test("file paths with issue-like suffixes are not qualified references (#418 rework)", () => {
  for (const text of ["src/hub/tasks.ts#12", "/owner/project#12", "prefix/https://github.com/owner/project/issues/12"]) {
    expect(specRefs({ title: text, detail: text, refs: {} }, repo)).toEqual([]);
  }
  expect(specRefs({ title: "#418 contract", detail: "owner/project#12", refs: {} }, repo)).toEqual([418, 12]);
  expect(() => specRefs({ title: "work", detail: "foreign/repo#12", refs: {} }, repo)).toThrow("other repository");
});


test("deterministic spec withholding settles Pi receipts, while transport failures stay uncertain (#141)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-spec-refusal-")); dirs.push(dir);
  let ledger = new PiToolReceipts(join(dir, "hub.db"));
  try {
    for (const [id, perform, message] of [
      ["foreign", async () => { specRefs({ title: "foreign/repo#418", detail: "", refs: {} }, repo); return "unexpected"; }, "other repository"],
      ["cap", async () => { specRefs({ title: "#1 #2 #3 #4", detail: "", refs: {} }, repo); return "unexpected"; }, "too many spec references"],
      ["size", () => fetchSpec(repo, 418, { ...response(row({ body: "x".repeat(65537) })), screen }).then(JSON.stringify), "spec too large (65537 > 65536); ask the reviewer to put the contract in the repo"],
      ["policy", () => fetchSpec(repo, 418, { ...response(row()), screen: () => false }).then(JSON.stringify), "spec withheld by privacy policy"],
    ] as const) {
      const result = await ledger.execute("spec-session", id, "hub_task_spec", {}, perform);
      expect(result).toBe(`error: ${message}`);
      expect(await ledger.execute("spec-session", id, "hub_task_spec", {}, async () => { throw new Error("must not replay"); })).toBe(result);
    }
    await ledger.close(); ledger = new PiToolReceipts(join(dir, "hub.db"));
    expect(await ledger.execute("spec-session", "foreign", "hub_task_spec", {}, async () => { throw new Error("must not replay after restart"); })).toBe("error: other repository");
    await expect(fetchSpec(repo, 0, { screen })).rejects.toBeInstanceOf(PreEffectToolRefusal);
    const malformed = fake("process.stdout.write('malformed');");
    await expect(fetchSpec(repo, 418, { ...malformed, screen })).rejects.not.toBeInstanceOf(PreEffectToolRefusal);
    const result = await ledger.execute("spec-session", "transport", "hub_task_spec", {}, () => fetchSpec(repo, 418, { path: "/missing-gh-fixture", screen }).then(JSON.stringify));
    expect(result).toContain("outcome is uncertain");
    expect(ledger.unsettled).toBe(true);
  } finally { await ledger.close(); }
});
