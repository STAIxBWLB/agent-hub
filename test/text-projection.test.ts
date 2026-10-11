import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { projectionConfig, TextProjections } from "../src/hub/text-projection.ts";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function root() { const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-projection-"))); dirs.push(dir); return dir; }
test("projection argv schema is bounded and requires a separate input placeholder (#259)", () => {
  expect(projectionConfig(undefined)).toEqual({});
  expect(projectionConfig({ ".docx": ["textutil", "-stdout", "{input}"] })).toEqual({ ".docx": ["textutil", "-stdout", "{input}"] });
  for (const raw of [null, [], { docx: ["cat", "{input}"] }, { ".docx": "cat {input}" }, { ".docx": ["cat"] }, { ".docx": ["{input}"] }, { ".docx": ["cat", "{input}", "{input}"] }]) expect(() => projectionConfig(raw)).toThrow();
});
test.skipIf(process.platform !== "darwin")("projection uses immutable input, bounded readonly conversion and content/config cache (#259)", () => {
  const dir = root(), input = join(dir, "article.docx"), converter = join(dir, "convert.sh");
  writeFileSync(input, "first");
  writeFileSync(converter, "#!/bin/sh\n/bin/cat \"$1\"\n", { mode: 0o755 });
  const logs: string[] = [], config = projectionConfig({ ".docx": [converter, "{input}"] });
  const projections = new TextProjections({ cwd: dir, stateDir: join(dir, ".agenthub/state"), config, log: line => logs.push(line) });
  const first = projections.project(input); expect(first).toBeDefined(); expect(first!.text).toBe("first");
  expect(projections.project(input)).toEqual(first); writeFileSync(input, "second");
  const second = projections.project(input); expect(second).toBeDefined(); expect(second!.text).toBe("second"); expect(second!.inputHash).not.toBe(first!.inputHash);
  expect(logs).toEqual([]);
  writeFileSync(converter, "#!/bin/sh\nprintf changed > \"$1\"\n/bin/cat \"$1\"\n", { mode: 0o755 });
  const changedConfig = projectionConfig({ ".docx": [converter, "{input}", "new-config"] });
  const readonly = new TextProjections({ cwd: dir, stateDir: join(dir, ".other-state"), config: changedConfig });
  const result = readonly.project(input); expect(readFileSync(input, "utf8")).toBe("second"); expect(result?.text).toBe("second");
});
test.skipIf(process.platform !== "darwin")("converter changes invalidate cache and failure logs are bounded without stderr text (#259)", () => {
  const dir = root(), file = join(dir, "article.docx"), converter = join(dir, "convert.sh"); writeFileSync(file, "input");
  writeFileSync(converter, "#!/bin/sh\nprintf first\n", { mode: 0o755 });
  const logs: string[] = [], projections = new TextProjections({ cwd: dir, stateDir: join(dir, ".agenthub/state"), config: projectionConfig({ ".docx": [converter, "{input}"] }), log: line => logs.push(line) });
  const first = projections.project(file); expect(first).toBeDefined(); expect(first!.text).toBe("first");
  writeFileSync(converter, "#!/bin/sh\nprintf second\n", { mode: 0o755 }); const second = projections.project(file);
  expect(second).toBeDefined(); expect(second!.text).toBe("second"); expect(second!.configHash).not.toBe(first!.configHash);
  writeFileSync(converter, "#!/bin/sh\nprintf PRIVATE_STDERR_MARKER >&2\nexit 1\n", { mode: 0o755 });
  expect(projections.project(file)).toBeUndefined(); expect(projections.project(file)).toBeUndefined(); expect(logs).toHaveLength(1); expect(logs.join("\n")).not.toContain("PRIVATE_STDERR_MARKER");
});
test("projection commands are ignored from tracked config and accepted only machine-locally (#259)", async () => {
  const dir = root(), { hubGitSync } = await import("../src/hub/git.ts"), { loadConfig } = await import("../src/hub/daemon.ts"), { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, ".agenthub")); expect(hubGitSync(["init", "--quiet"], { cwd: dir, encoding: "utf8" }).status).toBe(0);
  const config = { text_projection: { ".docx": ["/usr/bin/textutil", "-stdout", "{input}"] } };
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify(config));
  expect(hubGitSync(["add", "-f", ".agenthub/config.json"], { cwd: dir, encoding: "utf8" }).status).toBe(0);
  const tracked = loadConfig(dir); expect(tracked.text_projection).toBeUndefined(); expect(tracked.ignored?.join("\n")).toContain("text_projection");
  writeFileSync(join(dir, ".agenthub/config.local.json"), JSON.stringify(config)); expect(loadConfig(dir).text_projection).toEqual(config.text_projection);
});
test("private facts never invoke configured projection callbacks (#259)", async () => {
  const dir = root(), { Facts } = await import("../src/hub/facts.ts"); const file = join(dir, "private.docx"); writeFileSync(file, "PRIVATE_PROJECTION_MARKER"); let calls = 0;
  const facts = new Facts({ root: dir, tmp: join(dir, ".facts"), instance: "fixture", scope: () => ({ paths: ["private.docx"], plans: [] }), peers: () => ["claude"], nameable: () => true,
    privatePath: () => true, projection: () => { calls++; throw new Error("must not read private input"); } });
  expect(facts.due("claude")).toBeUndefined(); expect(calls).toBe(0);
});
test.skipIf(process.platform !== "darwin")("projected facts show text changes but never grant Codex effect attribution (#259)", async () => {
  const dir = root(), file = join(dir, "article.docx"), converter = join(dir, "convert.sh"); writeFileSync(file, "first\n"); writeFileSync(converter, "#!/bin/sh\nprintf '# projection\\n'\n/bin/cat \"$1\"\n", { mode: 0o755 });
  const projections = new TextProjections({ cwd: dir, stateDir: join(dir, ".agenthub/state"), config: projectionConfig({ ".docx": [converter, "{input}"] }) }), { Facts } = await import("../src/hub/facts.ts");
  const facts = new Facts({ root: dir, tmp: join(dir, ".facts"), instance: "fixture", scope: () => ({ paths: ["article.docx"], plans: [] }), peers: () => ["claude", "codex"], nameable: () => true, projection: input => projections.project(input) });
  for (const peer of ["claude", "codex"]) { const first = facts.due(peer); if (first) facts.ack(peer, first.id); }
  writeFileSync(file, "second\n"); facts.codexItem("codex", { type: "fileChange", status: "completed", changes: [{ path: file, kind: { type: "update" }, diff: "@@ -1 +1 @@\n-first\n+second\n" }] });
  const offer = facts.due("claude"); expect(offer).toBeDefined(); expect(offer!.text).toContain("+second"); expect(offer!.text).toContain("attribution unknown");
});
test.skipIf(process.platform !== "darwin")("converter output limit and process timeout fall back without changing the input (#259)", () => {
  const dir = root(), file = join(dir, "article.docx"), large = join(dir, "large.sh"); writeFileSync(file, "unchanged");
  writeFileSync(large, "#!/bin/sh\n/usr/bin/yes overflow\n", { mode: 0o755 });
  const logs: string[] = [], projected = new TextProjections({ cwd: dir, stateDir: join(dir, ".agenthub/state"), config: projectionConfig({ ".docx": [large, "{input}"] }), log: line => logs.push(line) });
  expect(projected.project(file)).toBeUndefined(); expect(readFileSync(file, "utf8")).toBe("unchanged"); expect(logs).toHaveLength(1);
});
test.skipIf(process.platform !== "darwin")("projection deadline stops forked converter descendants and retains input (#259)", () => {
  const dir = root(), file = join(dir, "article.docx"), converter = join(dir, "sleep.sh"); writeFileSync(file, "unchanged"); writeFileSync(converter, "#!/bin/sh\n/bin/sleep 30 &\nwait\n", { mode: 0o755 });
  const projected = new TextProjections({ cwd: dir, stateDir: join(dir, ".agenthub/state"), config: projectionConfig({ ".docx": [converter, "{input}"] }) });
  const started = performance.now(); expect(projected.project(file)).toBeUndefined(); expect(performance.now() - started).toBeLessThan(10000); expect(readFileSync(file, "utf8")).toBe("unchanged");
});
test("projection presentation preserves raw identity and never establishes raw write attribution (#259)", async () => {
  const dir = root(), file = join(dir, "article.docx"); writeFileSync(file, "first\n");
  const { Facts } = await import("../src/hub/facts.ts"), { createHash } = await import("node:crypto");
  const projection = (input: string) => {
    const bytes = readFileSync(input), rawHash = createHash("sha1").update(bytes).digest("hex"), rawBlob = createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
    return { rawHash, rawBlob, inputHash: "fixture", configHash: "fixture", text: "# projection\n" + bytes.toString("utf8") };
  };
  const facts = new Facts({ root: dir, tmp: join(dir, ".facts"), instance: "fixture", scope: () => ({ paths: ["article.docx"], plans: [] }), peers: () => ["claude", "codex"], nameable: () => true, projection });
  for (const peer of ["claude", "codex"]) { const first = facts.due(peer); if (first) facts.ack(peer, first.id); }
  writeFileSync(file, "second\n"); facts.codexItem("codex", { type: "fileChange", status: "completed", changes: [{ path: file, kind: { type: "update" }, diff: "@@ -1 +1 @@\n-first\n+second\n" }] });
  const offer = facts.due("claude"); expect(offer).toBeDefined(); expect(offer!.text).toContain("+second"); expect(offer!.text).toContain("attribution unknown");
});

test.skipIf(process.platform !== "darwin")("historic projection converts checked bytes without reading current or deleted files (#259)", () => {
  const dir=root(), converter=join(dir,"historic.sh"), file=join(dir,"article.docx");
  writeFileSync(converter,"#!/bin/sh\n/bin/cat \"$1\"\n",{mode:0o755}); writeFileSync(file,"current bytes");
  const projections=new TextProjections({cwd:dir,stateDir:join(dir,".agenthub/state"),config:projectionConfig({".docx":[converter,"{input}"]})});
  const before=Buffer.from("historical bytes\n"), projected=projections.projectBytes(file,before);
  expect(projected?.text).toBe("historical bytes\n"); expect(readFileSync(file,"utf8")).toBe("current bytes");
  expect(projected?.rawHash).not.toBe(projections.project(file)?.rawHash);
  rmSync(file); expect(projections.projectBytes(file,before)).toEqual(projected);
  expect(projections.projectBytes(join(dir,"never-existed.docx"),before)).toEqual(projected);
});

test("historic projection rejects outside names and oversized bytes with bounded diagnostics (#259)", async () => {
  const dir=root(), logs:string[]=[], {MAX_PROJECTION_INPUT}=await import("../src/hub/text-projection.ts");
  const projections=new TextProjections({cwd:dir,stateDir:join(dir,".agenthub/state"),config:projectionConfig({".docx":["/bin/cat","{input}"]}),log:line=>logs.push(line)});
  expect(projections.projectBytes(join(dir,"../outside.docx"),Buffer.from("private"))).toBeUndefined();
  expect(projections.projectBytes(join(dir,"article.docx"),Buffer.alloc(MAX_PROJECTION_INPUT+1))).toBeUndefined();
  expect(projections.projectBytes(join(dir,"ignored.txt"),Buffer.from("private"))).toBeUndefined();
  expect(logs).toHaveLength(1); expect(logs.join("\n")).not.toContain("private");
});

test.skipIf(process.platform !== "darwin")("historic byte cap refuses a converter that would otherwise emit a short valid result (#259)", async () => {
  const dir=root(), converter=join(dir,"short.sh"), {MAX_PROJECTION_INPUT}=await import("../src/hub/text-projection.ts");
  writeFileSync(converter,"#!/bin/sh\nprintf short\n",{mode:0o755});
  const projections=new TextProjections({cwd:dir,stateDir:join(dir,".agenthub/state"),config:projectionConfig({".docx":[converter,"{input}"]})});
  expect(projections.projectBytes(join(dir,"article.docx"),Buffer.from("small"))?.text).toBe("short");
  expect(projections.projectBytes(join(dir,"article.docx"),Buffer.alloc(MAX_PROJECTION_INPUT+1))).toBeUndefined();
});

test.skipIf(process.platform !== "darwin")("historic cache distinguishes extension-dependent converters for identical raw bytes (#259)", () => {
  const dir=root(), converter=join(dir,"extension.sh");
  writeFileSync(converter,"#!/bin/sh\ncase \"$1\" in *.docx) printf docx;; *.hwpx) printf hwpx;; esac\n",{mode:0o755});
  const argv=[converter,"{input}"], projections=new TextProjections({cwd:dir,stateDir:join(dir,".agenthub/state"),config:projectionConfig({".docx":argv,".hwpx":argv})}), raw=Buffer.from("shared raw bytes");
  const docx=projections.projectBytes(join(dir,"document.docx"),raw), hwpx=projections.projectBytes(join(dir,"document.hwpx"),raw);
  expect(docx?.text).toBe("docx"); expect(hwpx?.text).toBe("hwpx"); expect(docx?.rawBlob).toBe(hwpx?.rawBlob);
});

test.skipIf(process.platform!=="darwin")("historic projection deadline rejects cached values and stops slow conversion within the shared budget (#259)",()=>{
  const dir=root(), converter=join(dir,"slow.sh"), file=join(dir,"paper.docx");writeFileSync(converter,"#!/bin/sh\n/bin/cat \"$1\"\n",{mode:0o755});
  const projections=new TextProjections({cwd:dir,stateDir:join(dir,".agenthub/state"),config:projectionConfig({".docx":[converter,"{input}"]})}), bytes=Buffer.from("historic");
  expect(projections.projectBytes(file,bytes)?.text).toBe("historic");expect(projections.projectBytes(file,bytes,0)).toBeUndefined();
  writeFileSync(converter,"#!/bin/sh\n/bin/sleep 30 &\nwait\n",{mode:0o755});const started=performance.now();expect(projections.projectBytes(file,bytes,started+300)).toBeUndefined();expect(performance.now()-started).toBeLessThan(2000);
});

test.skipIf(process.platform!=="darwin")("projection helper termination stops its owned converter and forked descendants (#259)",async()=>{
  const dir=root(), converter=join(dir,"fork.sh"), {profile}=await import("../src/local/sandbox.ts");writeFileSync(converter,"#!/bin/sh\n/bin/sleep 30 &\nwait\n",{mode:0o755});
  const helper=Bun.spawn([process.execPath,join(import.meta.dir,"../src/hub/projection-exec.ts")],{cwd:dir,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  helper.stdin.write(JSON.stringify({cwd:dir,sandbox:profile(dir,false,undefined,undefined,["."]),argv:[converter]}));helper.stdin.end();
  const rows=()=>{const p=Bun.spawnSync(["/bin/ps","-axo","pid=,ppid=,stat="],{stdout:"pipe",stderr:"pipe"});return p.stdout.toString().trim().split("\n").map(line=>{const [pid,parent,state]=line.trim().split(/\s+/);return {pid:Number(pid),parent:Number(parent),state:state??""};});};
  const descendants=()=>{const all=rows(), found=new Set<number>([helper.pid]);for(let i=0;i<4;i++)for(const row of all)if(found.has(row.parent))found.add(row.pid);found.delete(helper.pid);return [...found];};
  let owned:number[]=[];
  try {
    for(let i=0;i<200 && owned.length<2;i++){owned=descendants();if(owned.length<2)await Bun.sleep(10);}expect(owned.length).toBeGreaterThanOrEqual(2);
    helper.kill("SIGTERM");await helper.exited;
    const running=()=>rows().filter(row=>owned.includes(row.pid)&&!row.state.startsWith("Z")).map(row=>row.pid);
    for(let i=0;i<200 && running().length;i++)await Bun.sleep(10);expect(running()).toEqual([]);
  }finally{if(helper.exitCode===null)helper.kill("SIGTERM");await helper.exited;await new Response(helper.stdout).text();await new Response(helper.stderr).text();}
});
