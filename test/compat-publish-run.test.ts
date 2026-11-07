import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubApiError, runCompatPublisher, retainManagedReceiptRows, type GithubAPI } from "../scripts/compat-publish-run.ts";
import { planCompatPublish, type PublishManifestEntry } from "../scripts/compat-publish.ts";
import { patchCompatSource, renderPublishedReceipt } from "../scripts/compat-publish-files.ts";
import { AGENT_COMPAT_ISSUE_TITLE } from "../scripts/agent-compat-issue.ts";

const SOURCE = "src/adapters/compat.ts", SERVER = "plugins/agent-hub/server.js", PLUGIN = "plugins/agent-hub/.claude-plugin/plugin.json";
const BASE = "a".repeat(40), REPO = "example/agent-hub", PREFIX = `/repos/${REPO}`;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const gitHash = (value: Buffer) => createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
type Leaf = { path: string; sha: string; type: string; mode: string };
type Pull = { number: number; title: string; body: string; state: string; merged_at: null; user: { login: string; type: string }; head: { ref: string; sha: string; repo: { full_name: string } }; base: { ref: string } };
class FakeGithub implements GithubAPI {
  calls: { method: string; route: string; body: unknown }[] = [];
  blobs = new Map<string, Buffer>(); trees = new Map<string, Map<string, Leaf>>(); commits = new Map<string, { tree: string; parents: string[] }>(); refs = new Map<string, string>();
  pulls: Pull[] = []; issues: { number: number; title: string; body: string; state: string }[] = [];
  next = 100; dispatchFails = false; beforeWrite?: () => void;
  token(): string { return createHash("sha1").update(String(this.next++)).digest("hex"); }
  store(value: string | Buffer): string { const bytes = Buffer.from(value); const sha = gitHash(bytes); this.blobs.set(sha, bytes); return sha; }
  addCommit(sha: string, files: Record<string, string>, parents: string[] = []): void {
    const tree = this.token(); this.trees.set(tree, new Map(Object.entries(files).map(([path, bytes]) => [path, { path, mode: "100644", type: "blob", sha: this.store(bytes) }]))); this.commits.set(sha, { tree, parents });
  }
  files(sha: string): Record<string, string> { return Object.fromEntries([...this.trees.get(this.commits.get(sha)!.tree)!].map(([path, row]) => [path, this.blobs.get(row.sha)!.toString("utf8")])); }
  get writes() { return this.calls.filter(row => row.method !== "GET"); }
  async request(method: "GET" | "POST" | "PATCH", route: string, value?: unknown): Promise<unknown> {
    this.calls.push({ method, route, body: value });
    if (method !== "GET") this.beforeWrite?.();
    if (!route.startsWith(PREFIX)) throw Error("unexpected repository");
    const url = route.slice(PREFIX.length), body = value as Record<string, any>;
    if (method === "GET") {
      if (!url) return { full_name: REPO, default_branch: "main" };
      if (url.startsWith("/git/ref/heads/")) { const sha = this.refs.get(url.slice(15)); if (!sha) throw new GithubApiError(404); return { object: { sha } }; }
      if (url.startsWith("/git/commits/")) { const sha = url.slice(13), row = this.commits.get(sha); if (!row) throw new GithubApiError(404); return { sha, tree: { sha: row.tree }, parents: row.parents.map(sha => ({ sha })) }; }
      if (url.startsWith("/git/trees/")) { const sha = url.slice(11).split("?")[0]!, tree = this.trees.get(sha); if (!tree) throw new GithubApiError(404); return { sha, truncated: false, tree: [...tree.values()] }; }
      if (url.startsWith("/git/blobs/")) { const sha = url.slice(11), bytes = this.blobs.get(sha); if (!bytes) throw new GithubApiError(404); return { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64") }; }
      if (url.startsWith("/pulls?")) return this.pulls.map(p => structuredClone(p));
      if (url.startsWith("/issues?")) return this.issues.filter(i => i.state === "open").map(i => structuredClone(i));
      if (/^\/pulls\/\d+$/.test(url)) { const row = this.pulls.find(p => p.number === Number(url.split("/")[2])); if (!row) throw new GithubApiError(404); return structuredClone(row); }
      if (/^\/issues\/\d+$/.test(url)) { const row = this.issues.find(p => p.number === Number(url.split("/")[2])); if (!row) throw new GithubApiError(404); return structuredClone(row); }
    } else {
      if (method === "POST" && url === "/git/blobs") return { sha: this.store(Buffer.from(body.content, "base64")) };
      if (method === "POST" && url === "/git/trees") {
        const tree = new Map(this.trees.get(body.base_tree)!);
        for (const row of body.tree as Leaf[]) { if (row.sha === null) tree.delete(row.path); else tree.set(row.path, row); }
        const sha = this.token(); this.trees.set(sha, tree); return { sha };
      }
      if (method === "POST" && url === "/git/commits") { const sha = this.token(); this.commits.set(sha, { tree: body.tree, parents: body.parents }); return { sha }; }
      if (method === "POST" && url === "/git/refs") { const branch = body.ref.slice("refs/heads/".length); if (this.refs.has(branch)) throw new GithubApiError(422); this.refs.set(branch, body.sha); return {}; }
      if (method === "PATCH" && url.startsWith("/git/refs/heads/")) {
        expect(body.force).toBe(false); const branch = url.slice(16), previous = this.refs.get(branch);
        if (!this.commits.get(body.sha)?.parents.includes(previous!)) throw new GithubApiError(422);
        this.refs.set(branch, body.sha); for (const pull of this.pulls) if (pull.head.ref === branch) pull.head.sha = body.sha; return {};
      }
      if (method === "POST" && url === "/pulls") {
        const pull: Pull = { number: this.next++, title: body.title, body: body.body, state: "open", merged_at: null, user: { login: "github-actions[bot]", type: "Bot" }, head: { ref: body.head, sha: this.refs.get(body.head)!, repo: { full_name: REPO } }, base: { ref: body.base } };
        this.pulls.push(pull); return structuredClone(pull);
      }
      if (method === "PATCH" && /^\/pulls\/\d+$/.test(url)) { const pull = this.pulls.find(p => p.number === Number(url.split("/")[2]))!; Object.assign(pull, body); return structuredClone(pull); }
      if (method === "POST" && url === "/actions/workflows/check.yml/dispatches") { if (this.dispatchFails) throw new GithubApiError(403); return; }
      if (method === "POST" && /^\/issues\/\d+\/comments$/.test(url)) return {};
      if (method === "PATCH" && /^\/issues\/\d+$/.test(url)) { const row = this.issues.find(p => p.number === Number(url.split("/")[2]))!; Object.assign(row, body); return structuredClone(row); }
      if (method === "POST" && url === "/issues") { const issue = { number: this.next++, title: body.title, body: body.body, state: "open" }; this.issues.push(issue); return structuredClone(issue); }
    }
    throw Error(`unhandled fake REST ${method} ${url}`);
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-publisher-test-")); chmodSync(root, 0o700);
  const api = new FakeGithub(), source = readFileSync(new URL("../src/adapters/compat.ts", import.meta.url), "utf8");
  const entry: PublishManifestEntry = { receipt: "docs/verification/2026-11-07-fixture.md", runnerOS: ["macos"], nativePlatform: "macos-arm64", autoAdmit: true,
    install: { method: "npm-exact" }, legs: [{ id: "identity", category: "macos-runner", runnerOS: ["macos"], requiredForAdmission: true }] };
  const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
  const summary = (version: string) => ({ schemaVersion: 1, id: "pi", version, procedureReceipt: entry.receipt, runnerOS: "macos", architecture: "arm64", generatedAt: "2026-11-07T00:00:00.000Z",
    bounds: { totalMs: 100, legMs: 50, cleanupMs: 10, outputMs: 10 }, elapsedMs: 1, ownedStopConfirmed: true, processCleanup: "unproven", processCleanupReason: "",
    containment: "disposable-runner-lifetime", autoAdmit: true, eligible: false, outcome: "pass", artifact: { method: "npm-exact", integrity }, integrity,
    installation: { status: "pass", cause: "ok", reason: "", nextStep: "" }, legs: [{ id: "identity", category: "macos-runner", requiredForAdmission: true, status: "pass", cause: "ok", reason: "", nextStep: "" }] });
  const baseFiles = { [SOURCE]: source, [SERVER]: "trusted old bundle", [PLUGIN]: JSON.stringify({ name: "agent-hub", version: "0.34.1" }), "package.json": JSON.stringify({ version: "0.34.1" }), "scripts/compat-receipts/manifest.json": JSON.stringify({ entries: { pi: entry } }), "unrelated.txt": "keep this main-owned content" };
  api.addCommit(BASE, baseFiles); api.refs.set("main", BASE);
  function prepare(version = "99.0.0", baseSha = BASE, raw: unknown[] = [summary(version)], date = "2026-11-07") {
    const directory = join(root, `prepared-${api.next++}`); mkdirSync(directory, { mode: 0o700 });
    const mainSource = api.files(baseSha)[SOURCE]!, candidates = [{ id: "pi", version }], plan = planCompatPublish({ manifest: { pi: entry }, candidates, artifacts: raw, existingPullRequests: [], dryRun: false });
    const bundles: unknown[] = [];
    for (const action of plan.actions) if (action.kind === "create-pr" || action.kind === "update-pr") {
      const bundleName = `pi-${version}`, target = join(directory, bundleName); mkdirSync(target, { mode: 0o700 });
      const receiptPath = `docs/verification/${date}-compat-pi-${version}.md`;
      // The bundle is executable-looking data. A privileged publisher must never execute it.
      const contents = { "compat.ts": patchCompatSource(mainSource, "pi", version, receiptPath), "receipt.md": renderPublishedReceipt(action.receipt), "server.js": "throw new Error('PREPARED_CODE_MUST_NEVER_EXECUTE');", "plugin.json": baseFiles[PLUGIN] };
      const files = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => { writeFileSync(join(target, name), bytes, { mode: 0o600 }); return [name, { size: Buffer.byteLength(bytes), sha256: hash(bytes) }]; }));
      const descriptor = JSON.stringify({ schemaVersion: 1, id: "pi", version, sourceBaseSha: baseSha, originalSourceSha256: hash(mainSource), receiptPath, files });
      writeFileSync(join(target, "descriptor.json"), descriptor, { mode: 0o600 }); bundles.push({ id: "pi", version, directory: bundleName, descriptorSha256: hash(descriptor), descriptorSize: Buffer.byteLength(descriptor) });
    }
    const index = { schemaVersion: 1, sourceBaseSha: baseSha, dryRun: false, watch: { code: 3, report: "Published agent CLI versions ahead of their verified set (`src/adapters/compat.ts`).\n", candidates, verified: [] as string[] }, artifacts: raw, rejectedBatch: false, plan, projections: plan.actions, bundles };
    writeFileSync(join(directory, "index.json"), JSON.stringify(index), { mode: 0o600 });
    return { input: { preparedDir: directory, repository: REPO, sourceBaseSha: baseSha, dryRun: false }, index, directory };
  }
  return { api, entry, source, summary, prepare, baseFiles, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("publisher publishes exact data, opens the bot PR, then dispatches checks without executing the prepared bundle", async () => {
  const f = fixture(); try {
    const p = f.prepare(), result = await runCompatPublisher(p.input, f.api);
    expect(result.pullRequests).toHaveLength(1); const published = result.pullRequests[0]!;
    expect(f.api.refs.get("main")).toBe(BASE); expect(f.api.commits.get(published.head)!.parents).toEqual([BASE]);
    expect(f.api.files(published.head)["unrelated.txt"]).toBe(f.baseFiles["unrelated.txt"]);
    expect(f.api.files(published.head)[SOURCE]).toContain('"99.0.0"');
    expect(f.api.writes.at(-1)!.route).toEndWith("/actions/workflows/check.yml/dispatches");
    expect(f.api.pulls[0]!.body).toContain("Refs #888 and #1248");
    expect(f.api.writes.some(row => row.route.endsWith("/merges"))).toBe(false);
  } finally { f.cleanup(); }
});

test("dry run accepts a feature source while validate-only enforces live main, and neither writes", async () => {
  const f = fixture(); try {
    const feature = "b".repeat(40); f.api.addCommit(feature, f.baseFiles, [BASE]); const p = f.prepare("99.0.0", feature);
    const before = readFileSync(join(p.directory, "index.json"));
    expect((await runCompatPublisher({ ...p.input, dryRun: true }, f.api)).actions[0]!.kind).toBe("create-pr");
    expect(f.api.writes).toHaveLength(0); expect(readFileSync(join(p.directory, "index.json"))).toEqual(before);
    await expect(runCompatPublisher({ ...p.input, validateOnly: true }, f.api)).rejects.toThrow("main-moved");
    const normal = f.prepare(); await runCompatPublisher({ ...normal.input, validateOnly: true }, f.api); expect(f.api.writes).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("report headings are opaque to publication while unsafe report characters remain refused", async () => {
  const f = fixture(); try {
    const p = f.prepare(), baseline = await runCompatPublisher({ ...p.input, dryRun: true }, f.api);
    p.index.watch.report = "A different plain heading.\nStructured watch state still controls publication.\n";
    writeFileSync(join(p.directory, "index.json"), JSON.stringify(p.index));
    const changed = await runCompatPublisher({ ...p.input, dryRun: true }, f.api);
    expect(changed.actions).toEqual(baseline.actions); expect(f.api.writes).toHaveLength(0);
    for (const unsafe of ["<untrusted>", "```untrusted", "tab\tcharacter"]) {
      p.index.watch.report = unsafe; writeFileSync(join(p.directory, "index.json"), JSON.stringify(p.index)); f.api.calls = [];
      await expect(runCompatPublisher({ ...p.input, dryRun: true }, f.api)).rejects.toThrow("watch-report"); expect(f.api.writes).toHaveLength(0);
    }
  } finally { f.cleanup(); }
});

test("tampered bytes, symlinks, source patches and version mismatch are refused before GitHub writes", async () => {
  for (const change of ["bytes", "symlink", "patch", "version"] as const) {
    const f = fixture(); try {
      const p = f.prepare(), dir = join(p.directory, "pi-99.0.0"), descriptorFile = join(dir, "descriptor.json");
      const descriptor = JSON.parse(readFileSync(descriptorFile, "utf8"));
      if (change === "bytes") writeFileSync(join(dir, "server.js"), "tampered");
      if (change === "symlink") { rmSync(join(dir, "receipt.md")); symlinkSync(join(dir, "server.js"), join(dir, "receipt.md")); }
      if (change === "patch" || change === "version") {
        const name = change === "patch" ? "compat.ts" : "plugin.json", bytes = change === "patch" ? readFileSync(join(dir, name), "utf8") + "\n// MANUAL UNOWNED SOURCE" : JSON.stringify({ name: "agent-hub", version: "999.0.0" });
        writeFileSync(join(dir, name), bytes); descriptor.files[name] = { size: Buffer.byteLength(bytes), sha256: hash(bytes) };
        const encoded = JSON.stringify(descriptor); writeFileSync(descriptorFile, encoded); p.index.bundles[0] = { ...p.index.bundles[0] as object, descriptorSha256: hash(encoded), descriptorSize: Buffer.byteLength(encoded) }; writeFileSync(join(p.directory, "index.json"), JSON.stringify(p.index));
      }
      await expect(runCompatPublisher(p.input, f.api)).rejects.toThrow(); expect(f.api.writes).toHaveLength(0);
    } finally { f.cleanup(); }
  }
});

test("unknown branch and non-bot PR collisions refuse before any writes", async () => {
  for (const hasPr of [false, true]) {
    const f = fixture(); try {
      const p = f.prepare(); f.api.refs.set("compat/pi-99.0.0", BASE);
      if (hasPr) f.api.pulls.push({ number: 42, title: "person's branch", body: "person text", state: "open", merged_at: null, user: { login: "a-person", type: "User" }, head: { ref: "compat/pi-99.0.0", sha: BASE, repo: { full_name: REPO } }, base: { ref: "main" } });
      await expect(runCompatPublisher(p.input, f.api)).rejects.toThrow("branch-collision"); expect(f.api.writes).toHaveLength(0);
    } finally { f.cleanup(); }
  }
});

test("same-version refresh preserves human prose and merges fresh main with both parents", async () => {
  const f = fixture(); try {
    const first = await runCompatPublisher(f.prepare().input, f.api), oldHead = first.pullRequests[0]!.head;
    f.api.pulls[0]!.body = `Human introduction.\n${f.api.pulls[0]!.body}\nHuman follow-up.`;
    const newMain = "b".repeat(40); f.api.addCommit(newMain, { ...f.baseFiles, "new-main.txt": "keep new main", [SOURCE]: `${f.source}\n// main-only change\n` }, [BASE]); f.api.refs.set("main", newMain);
    const p = f.prepare("99.0.0", newMain, undefined, "2026-11-08"), result = await runCompatPublisher(p.input, f.api), head = result.pullRequests[0]!.head;
    expect(result.pullRequests[0]!.number).toBe(first.pullRequests[0]!.number); expect(f.api.commits.get(head)!.parents).toEqual([oldHead, newMain]);
    const files = f.api.files(head); expect(files["new-main.txt"]).toBe("keep new main"); expect(files[SOURCE]).toContain("main-only change");
    const oldReceipt = "docs/verification/2026-11-07-compat-pi-99.0.0.md", newReceipt = "docs/verification/2026-11-08-compat-pi-99.0.0.md";
    expect(Object.hasOwn(files, oldReceipt)).toBe(false); expect(Object.hasOwn(files, newReceipt)).toBe(true);
    expect(files[newReceipt]).toBe(readFileSync(join(p.directory, "pi-99.0.0", "receipt.md"), "utf8"));
    expect(f.api.pulls[0]!.body.startsWith("Human introduction.\n")).toBe(true); expect(f.api.pulls[0]!.body.endsWith("\nHuman follow-up.")).toBe(true);
  } finally { f.cleanup(); }
});

test("manual edits to bot head, marker, title or unrelated tree refuse before a subsequent write", async () => {
  for (const change of ["head", "marker", "title", "files"] as const) {
    const f = fixture(); try {
      await runCompatPublisher(f.prepare().input, f.api); const p = f.prepare();
      if (change === "head") f.api.refs.set("compat/pi-99.0.0", BASE);
      if (change === "marker") f.api.pulls[0]!.body = f.api.pulls[0]!.body.replace("Model-free", "Manually altered");
      if (change === "title") f.api.pulls[0]!.title = "Manual changed title";
      if (change === "files") {
        const head = f.api.pulls[0]!.head.sha, tree = f.api.trees.get(f.api.commits.get(head)!.tree)!;
        tree.set("manual.txt", { path: "manual.txt", mode: "100644", type: "blob", sha: f.api.store("manual") });
      }
      f.api.calls = []; await expect(runCompatPublisher(p.input, f.api)).rejects.toThrow(); expect(f.api.writes).toHaveLength(0);
    } finally { f.cleanup(); }
  }
});

test("superseding closes the older PR only after replacement dispatch succeeds", async () => {
  for (const dispatchFails of [false, true]) {
    const f = fixture(); try {
      await runCompatPublisher(f.prepare("98.0.0").input, f.api); const old = f.api.pulls[0]!, p = f.prepare(); f.api.dispatchFails = dispatchFails; f.api.calls = [];
      if (dispatchFails) await expect(runCompatPublisher(p.input, f.api)).rejects.toThrow(); else await runCompatPublisher(p.input, f.api);
      expect(old.state).toBe(dispatchFails ? "open" : "closed");
      const dispatch = f.api.writes.findIndex(row => row.route.endsWith("/dispatches")), close = f.api.writes.findIndex(row => (row.body as { state?: string })?.state === "closed");
      if (!dispatchFails) expect(close).toBeGreaterThan(dispatch); else expect(close).toBe(-1);
    } finally { f.cleanup(); }
  }
});

test("failed eligibility updates only the exact-title drift issue with canonical reason and preserves other managed rows", async () => {
  const f = fixture(); try {
    const raw = f.summary("99.0.0"); raw.eligible = true; raw.legs[0]!.status = "fail"; raw.legs[0]!.cause = "proof-failed"; raw.outcome = "fail"; raw.legs[0]!.reason = "DO_NOT_PUBLISH_RAW_PROSE";
    f.api.issues.push({ number: 3, title: "Same label, wrong title", body: "leave this alone", state: "open" });
    await runCompatPublisher(f.prepare("99.0.0", BASE, [raw]).input, f.api);
    expect(f.api.pulls).toHaveLength(0); expect(f.api.issues[0]!.body).toBe("leave this alone");
    const issue = f.api.issues.find(row => row.title === AGENT_COMPAT_ISSUE_TITLE)!;
    expect(issue.body).toContain("proof-failed"); expect(issue.body).toContain("Next step:"); expect(issue.body).not.toContain("DO_NOT_PUBLISH_RAW_PROSE");
    const previous = issue.body.replaceAll('"id":"pi"', '"id":"qwen"').replace("### pi ", "### qwen ");
    const merged = retainManagedReceiptRows("New watcher report.\n", previous);
    expect(merged).toStartWith("New watcher report."); expect(merged).toContain("### qwen 99.0.0");
    issue.body = `${previous}\nHuman comment.\n`; f.api.calls = [];
    await runCompatPublisher(f.prepare("99.0.0", BASE, [raw]).input, f.api);
    expect(issue.body).toContain("### qwen 99.0.0"); expect(issue.body).toContain("### pi 99.0.0"); expect(issue.body).toContain("Human comment.");
  } finally { f.cleanup(); }
});

test("duplicate exact-title issues and malformed owned blocks refuse before writes", async () => {
  const f = fixture(); try {
    const p = f.prepare(); f.api.issues.push({ number: 1, title: AGENT_COMPAT_ISSUE_TITLE, body: "", state: "open" }, { number: 2, title: AGENT_COMPAT_ISSUE_TITLE, body: "", state: "open" });
    await expect(runCompatPublisher(p.input, f.api)).rejects.toThrow(); expect(f.api.writes).toHaveLength(0);
    f.api.issues.pop(); f.api.issues[0]!.body = "<!-- agent-compat-receipt:end -->";
    await expect(runCompatPublisher(p.input, f.api)).rejects.toThrow("issue-marker"); expect(f.api.writes).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("today's confirmed verified IDs clear yesterday's stale blocks while drifting and unknown IDs remain", async () => {
  const f = fixture(); try {
    const failed = f.summary("99.0.0"); failed.legs[0]!.status = "fail"; failed.legs[0]!.cause = "proof-failed"; failed.outcome = "fail";
    await runCompatPublisher(f.prepare("99.0.0", BASE, [failed]).input, f.api);
    const issue = f.api.issues.find(row => row.title === AGENT_COMPAT_ISSUE_TITLE)!, block = issue.body.slice(issue.body.indexOf("<!-- agent-compat-receipt:start "));
    const renamed = (id: string) => block.replaceAll('"id":"pi"', `"id":"${id}"`).replace("### pi ", `### ${id} `);
    // Yesterday both Kimi and Qwen failed, and an older unknown jcode observation remains.
    const previous = `Human context.\n${renamed("kimi-review")}\n${renamed("qwen")}\n${renamed("jcode")}\n`;
    const report = "Today's watcher report.\n", known = ["pi", "kimi-review", "qwen", "jcode"];
    const retained = retainManagedReceiptRows(report, previous, ["kimi-review"], known, ["qwen"]);
    expect(retained).not.toContain("### kimi-review "); expect(retained).toContain("### qwen 99.0.0"); expect(retained).toContain("### jcode 99.0.0");
    expect(() => retainManagedReceiptRows(report, previous, ["unknown-id"], known, ["qwen"])).toThrow("verified-ids");
    expect(() => retainManagedReceiptRows(report, previous, ["qwen"], known, ["qwen"])).toThrow("verified-ids");

    // Exercise the full publisher with canonical structured watch state, not report parsing.
    const manifest = { entries: { pi: f.entry, "kimi-review": f.entry, qwen: f.entry, jcode: f.entry } };
    const currentBase = "b".repeat(40);
    f.api.addCommit(currentBase, { ...f.baseFiles, "scripts/compat-receipts/manifest.json": JSON.stringify(manifest) }, [BASE]); f.api.refs.set("main", currentBase); issue.body = previous;
    const p = f.prepare("99.0.0", currentBase, [failed]);
    p.index.watch.candidates = [{ id: "qwen", version: "99.0.0" }];
    p.index.artifacts = [{ ...failed, id: "qwen" }]; p.index.watch.verified = ["kimi-review"];
    writeFileSync(join(p.directory, "index.json"), JSON.stringify(p.index)); f.api.calls = [];
    await runCompatPublisher(p.input, f.api);
    expect(issue.body).not.toContain("### kimi-review "); expect(issue.body).toContain("### qwen 99.0.0"); expect(issue.body).toContain("### jcode 99.0.0"); expect(issue.body).toContain("Human context.");
    expect(f.api.pulls).toHaveLength(0);

    for (const verified of [["qwen"], ["unknown-id"], ["kimi-review", "kimi-review"]]) {
      p.index.watch.verified = verified; writeFileSync(join(p.directory, "index.json"), JSON.stringify(p.index)); f.api.calls = [];
      await expect(runCompatPublisher(p.input, f.api)).rejects.toThrow("verified-ids"); expect(f.api.writes).toHaveLength(0);
    }
  } finally { f.cleanup(); }
});
