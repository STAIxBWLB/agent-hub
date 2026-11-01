import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import type { ProjectRuntimeIdentity, RuntimeProject } from "../src/hub/project-runtime-state.ts";

const put = (root: string, file: string, body: string) => { const target = join(root, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body); };
type Child = Bun.Subprocess<"ignore", "ignore", "pipe">;
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-runtime-replace-")));
  const project: RuntimeProject = { id: "p-runtime-fixture", root: join(root, "project"), stateDir: join(root, "state") };
  mkdirSync(project.root); mkdirSync(project.stateDir);
  const record = (revision: number): ProjectRuntimeIdentity => ({ schema: 1, projectId: project.id, projectRoot: project.root, stateDir: project.stateDir,
    version: `0.26.${revision}`, root: join(root, `capture-${revision}`), digest: String(revision + 1).repeat(64), kind: "restart", instanceId: null });
  const file = join(project.stateDir, "runtime.json"), held = join(root, "reader-held"), release = join(root, "reader-release"), result = join(root, "reader-result.json");
  const before = record(0), after = record(1); writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("ORCA_") || name.startsWith("AGENTHUB_") || name.startsWith("AMEM_")) delete env[name];
  env.AGENTHUB_HOME = join(root, "home"); env.HOME = join(root, "user-home");
  mkdirSync(env.AGENTHUB_HOME); mkdirSync(env.HOME);
  return { root, project, before, after, file, held, release, result, env };
}
function copiedReader(f: ReturnType<typeof fixture>) {
  const source = readFileSync(new URL("../src/hub/project-runtime-state.ts", import.meta.url), "utf8");
  if (source.split('from "node:fs";').length !== 2) throw new Error("runtime state fixture expected one filesystem import");
  put(f.root, "module/project-runtime-state.ts", source.replace('from "node:fs";', 'from "./fs-wrapper.ts";'));
  const actual = (file: string) => new URL(file, import.meta.url).href;
  for (const [name, exports, dependency] of [["config-trust", "configRepositoryPresent", "../src/hub/config-trust.ts"],
    ["child-process", "childEnv", "../src/hub/child-process.ts"], ["git", "hubGitSync", "../src/hub/git.ts"]])
    put(f.root, `module/${name}.ts`, `export { ${exports} } from ${JSON.stringify(actual(dependency!))};\n`);
  put(f.root, "module/fs-wrapper.ts", `import { existsSync, fstatSync as actualFstat, writeFileSync } from 'node:fs';
export { closeSync, constants, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
let first = true;
export function fstatSync(fd, options) {
 const captured = actualFstat(fd, options);
 if (first) {
  first = false; writeFileSync(${JSON.stringify(f.held)}, JSON.stringify({dev:captured.dev,ino:captured.ino,nlink:captured.nlink}));
  const deadline = Date.now() + 10000;
  while (!existsSync(${JSON.stringify(f.release)}) && Date.now() < deadline) Bun.sleepSync(5);
  if (!existsSync(${JSON.stringify(f.release)})) throw new Error('runtime reader barrier not released');
 }
 return captured;
}
`);
  const reader = join(f.root, "reader.ts");
  writeFileSync(reader, `import { writeFileSync } from 'node:fs';
import { readProjectRuntimeReference } from './module/project-runtime-state.ts';
try { writeFileSync(${JSON.stringify(f.result)}, JSON.stringify({ok:true,value:readProjectRuntimeReference(${JSON.stringify(f.project)})})); }
catch (error) { writeFileSync(${JSON.stringify(f.result)}, JSON.stringify({ok:false,error:String(error)})); }
`);
  return reader;
}
async function waitHeld(f: ReturnType<typeof fixture>, child: Child) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(f.held) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(5);
  if (!existsSync(f.held) && child.exitCode !== null) throw new Error(`owned reader exited before barrier: ${await new Response(child.stderr).text()}`);
  expect(existsSync(f.held), "reader did not hold its first opened descriptor").toBe(true);
}

test("#616 atomic runtime publication while an old descriptor is open reopens and returns the replacement binding", async () => {
  const f = fixture(), children: Child[] = [];
  try {
    const reader = Bun.spawn([process.execPath, copiedReader(f)], { env: f.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); children.push(reader);
    await waitHeld(f, reader);
    const writerFile = join(f.root, "writer.ts");
    writeFileSync(writerFile, `import { renameSync, writeFileSync } from 'node:fs';
const temporary = ${JSON.stringify(`${f.file}.replacement`)};
writeFileSync(temporary, ${JSON.stringify(JSON.stringify(f.after))}, {mode:0o600,flag:'wx'});
renameSync(temporary, ${JSON.stringify(f.file)});
`);
    const writer = Bun.spawn([process.execPath, writerFile], { env: f.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); children.push(writer);
    expect(await writer.exited, await new Response(writer.stderr).text()).toBe(0);
    expect(reader.exitCode).toBeNull(); expect(existsSync(f.release)).toBe(false);
    expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual(f.after);
    writeFileSync(f.release, "read the retained descriptor now\n");
    expect(await reader.exited, await new Response(reader.stderr).text()).toBe(0);
    const result = JSON.parse(readFileSync(f.result, "utf8")) as {ok:boolean;value?:ProjectRuntimeIdentity;error?:string};
    expect(result.ok, result.error).toBe(true); expect(result.value).toEqual(f.after);
    expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual(f.after);
  } finally {
    writeFileSync(f.release, "release owned reader\n");
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map(child => child.exited));
    rmSync(f.root, { recursive: true, force: true });
  }
}, 20_000);
