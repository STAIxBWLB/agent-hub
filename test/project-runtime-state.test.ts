import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { readProjectRuntimeReference, type ProjectRuntimeIdentity, type RuntimeProject } from "../src/hub/project-runtime-state.ts";

const put = (root: string, file: string, body: string) => { const target = join(root, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body); };
type Child = Bun.Subprocess<"ignore", "ignore", "pipe">;
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-runtime-replace-")));
  const project: RuntimeProject = { id: "p-runtime-fixture", root: join(root, "project"), stateDir: join(root, "state") };
  mkdirSync(project.root); mkdirSync(project.stateDir);
  const record = (revision: number): ProjectRuntimeIdentity => ({ schema: 1, projectId: project.id, projectRoot: project.root, stateDir: project.stateDir,
    version: `0.26.${revision}`, root: join(root, `capture-${revision}`), digest: String(revision + 1).repeat(64), kind: "restart", instanceId: null });
  const file = join(project.stateDir, "runtime.json"), held = join(root, "reader-held"), release = join(root, "reader-release"), result = join(root, "reader-result.json");
  const opens = join(root, "reader-opens");
  const before = record(0), after = record(1); writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("ORCA_") || name.startsWith("AGENTHUB_") || name.startsWith("AMEM_")) delete env[name];
  env.AGENTHUB_HOME = join(root, "home"); env.HOME = join(root, "user-home");
  mkdirSync(env.AGENTHUB_HOME); mkdirSync(env.HOME);
  return { root, project, record, before, after, file, held, release, result, opens, env };
}
const phaseFile = (file: string, phase: number) => phase === 1 ? file : `${file}.${phase}`;
function copiedReader(f: ReturnType<typeof fixture>, holdOpens = [1]) {
  const source = readFileSync(new URL("../src/hub/project-runtime-state.ts", import.meta.url), "utf8");
  if (source.split('from "node:fs";').length !== 2) throw new Error("runtime state fixture expected one filesystem import");
  put(f.root, "module/project-runtime-state.ts", source.replace('from "node:fs";', 'from "./fs-wrapper.ts";'));
  const actual = (file: string) => new URL(file, import.meta.url).href;
  for (const [name, exports, dependency] of [["config-trust", "configRepositoryPresent", "../src/hub/config-trust.ts"],
    ["child-process", "childEnv", "../src/hub/child-process.ts"], ["git", "hubGitSync", "../src/hub/git.ts"]])
    put(f.root, `module/${name}.ts`, `export { ${exports} } from ${JSON.stringify(actual(dependency!))};\n`);
  put(f.root, "module/fs-wrapper.ts", `import { existsSync, fstatSync as actualFstat, openSync as actualOpen, writeFileSync } from 'node:fs';
export { closeSync, constants, existsSync, lstatSync, mkdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
let opens = 0;
const stats = new Map(), hold = ${JSON.stringify(holdOpens)};
export function openSync(file, flags, mode) {
 const fd = actualOpen(file, flags, mode); stats.set(fd, {phase:++opens,calls:0});
 writeFileSync(${JSON.stringify(f.opens)}, String(opens)); return fd;
}
export function fstatSync(fd, options) {
 const captured = actualFstat(fd, options), state = stats.get(fd);
 if (state && ++state.calls === 1 && hold.includes(state.phase)) {
  const suffix = state.phase === 1 ? '' : '.' + state.phase;
  const held = ${JSON.stringify(f.held)} + suffix, release = ${JSON.stringify(f.release)} + suffix;
  writeFileSync(held, JSON.stringify({dev:captured.dev,ino:captured.ino,nlink:captured.nlink}));
  const deadline = Date.now() + 10000;
  while (!existsSync(release) && Date.now() < deadline) Bun.sleepSync(5);
  if (!existsSync(release)) throw new Error('runtime reader barrier not released');
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
async function waitHeld(f: ReturnType<typeof fixture>, child: Child, phase = 1, allowExit = false) {
  const held = phaseFile(f.held, phase);
  const deadline = Date.now() + 10_000;
  while (!existsSync(held) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(5);
  if (allowExit && !existsSync(held) && child.exitCode !== null) return false;
  if (!existsSync(held) && child.exitCode !== null) throw new Error(`owned reader exited before barrier: ${await new Response(child.stderr).text()}`);
  expect(existsSync(held), "reader did not hold its opened descriptor").toBe(true);
  return true;
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

for (const invalid of ["malformed", "wrong-binding", "symlink", "hardlink", "oversize", "directory"] as const) {
  test(`#616 a stable ${invalid} runtime record still refuses without replacement recovery`, () => {
    const f = fixture();
    try {
      if (invalid === "malformed") writeFileSync(f.file, "{");
      else if (invalid === "wrong-binding") writeFileSync(f.file, JSON.stringify({ ...f.before, projectId: "p-foreign" }));
      else if (invalid === "oversize") writeFileSync(f.file, " ".repeat(16 * 1024 + 1) + JSON.stringify(f.before));
      else {
        const other = join(f.root, "other.json"); writeFileSync(other, JSON.stringify(f.before)); rmSync(f.file);
        if (invalid === "symlink") symlinkSync(other, f.file);
        else if (invalid === "hardlink") linkSync(other, f.file);
        else mkdirSync(f.file);
      }
      expect(() => readProjectRuntimeReference(f.project)).toThrow("project runtime record is invalid");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("#616 initial absence remains no selection and a stable valid binding is unchanged", () => {
  const f = fixture();
  try {
    expect(readProjectRuntimeReference(f.project)).toEqual(f.before);
    rmSync(f.file); expect(readProjectRuntimeReference(f.project)).toBeUndefined();
    expect(existsSync(f.file)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("#616 same-inode mutation during reading refuses instead of reopening as an atomic publisher", async () => {
  const f = fixture(), children: Child[] = [];
  try {
    const reader = Bun.spawn([process.execPath, copiedReader(f)], { env: f.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); children.push(reader);
    await waitHeld(f, reader);
    const writerFile = join(f.root, "in-place-writer.ts");
    writeFileSync(writerFile, `import { statSync, utimesSync, writeFileSync } from 'node:fs';
const file = ${JSON.stringify(f.file)}, before = statSync(file);
writeFileSync(file, ${JSON.stringify(JSON.stringify(f.after))});
utimesSync(file, before.atime, new Date(before.mtimeMs + 1000));
`);
    const writer = Bun.spawn([process.execPath, writerFile], { env: f.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); children.push(writer);
    expect(await writer.exited, await new Response(writer.stderr).text()).toBe(0);
    writeFileSync(f.release, "read changed same inode\n");
    expect(await reader.exited, await new Response(reader.stderr).text()).toBe(0);
    const result = JSON.parse(readFileSync(f.result, "utf8")) as {ok:boolean;error?:string};
    expect(result.ok).toBe(false); expect(result.error).toContain("project runtime record is invalid");
    expect(Number(readFileSync(f.opens, "utf8"))).toBe(1);
    expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual(f.after);
  } finally {
    writeFileSync(f.release, "release owned reader\n");
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map(child => child.exited)); rmSync(f.root, { recursive: true, force: true });
  }
}, 20_000);

for (const invalid of ["malformed", "wrong-binding", "symlink", "hardlink", "oversize", "missing"] as const) {
  test(`#616 replacing an opened runtime with ${invalid} state refuses rather than selecting a fallback`, async () => {
    const f = fixture(), children: Child[] = [];
    try {
      const reader = Bun.spawn([process.execPath, copiedReader(f)], { env: f.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); children.push(reader);
      await waitHeld(f, reader);
      const other = join(f.root, "other.json"), replacement = `${f.file}.replacement`, writerFile = join(f.root, "invalid-writer.ts");
      const text = invalid === "malformed" ? "{" : invalid === "wrong-binding" ? JSON.stringify({ ...f.after, stateDir: join(f.root, "foreign-state") })
        : invalid === "oversize" ? " ".repeat(16 * 1024 + 1) + JSON.stringify(f.after) : JSON.stringify(f.after);
      let effect: string;
      if (invalid === "missing") effect = `rmSync(${JSON.stringify(f.file)});`;
      else if (invalid === "symlink" || invalid === "hardlink") effect = `writeFileSync(${JSON.stringify(other)}, ${JSON.stringify(text)});
${invalid === "symlink" ? "symlinkSync" : "linkSync"}(${JSON.stringify(other)}, ${JSON.stringify(replacement)});
renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(f.file)});`;
      else effect = `writeFileSync(${JSON.stringify(replacement)}, ${JSON.stringify(text)}, {mode:0o600,flag:'wx'}); renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(f.file)});`;
      writeFileSync(writerFile, `import { linkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';\n${effect}\n`);
      const writer = Bun.spawn([process.execPath, writerFile], { env: f.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); children.push(writer);
      expect(await writer.exited, await new Response(writer.stderr).text()).toBe(0);
      writeFileSync(f.release, "read invalid replacement\n");
      expect(await reader.exited, await new Response(reader.stderr).text()).toBe(0);
      const result = JSON.parse(readFileSync(f.result, "utf8")) as {ok:boolean;error?:string};
      expect(result.ok).toBe(false); expect(result.error).toContain("project runtime record is invalid");
      expect(Number(readFileSync(f.opens, "utf8"))).toBeLessThanOrEqual(2);
    } finally {
      writeFileSync(f.release, "release owned reader\n");
      for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.all(children.map(child => child.exited)); rmSync(f.root, { recursive: true, force: true });
    }
  }, 20_000);
}

test("#616 repeated valid atomic replacements exhaust at most three descriptor attempts", async () => {
  const f = fixture(), children: Child[] = [];
  try {
    const reader = Bun.spawn([process.execPath, copiedReader(f, [1, 2, 3])], { env: f.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); children.push(reader);
    for (let phase = 1; phase <= 3; phase++) {
      if (!await waitHeld(f, reader, phase, true)) break;
      const writerFile = join(f.root, `replacing-writer-${phase}.ts`), replacement = `${f.file}.replacement-${phase}`;
      writeFileSync(writerFile, `import { renameSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(replacement)}, ${JSON.stringify(JSON.stringify(f.record(phase)))}, {mode:0o600,flag:'wx'});
renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(f.file)});
`);
      const writer = Bun.spawn([process.execPath, writerFile], { env: f.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); children.push(writer);
      expect(await writer.exited, await new Response(writer.stderr).text()).toBe(0);
      writeFileSync(phaseFile(f.release, phase), "another inode replaced\n");
    }
    expect(await reader.exited, await new Response(reader.stderr).text()).toBe(0);
    const result = JSON.parse(readFileSync(f.result, "utf8")) as {ok:boolean;error?:string};
    expect(result.ok).toBe(false); expect(result.error).toContain("project runtime record is invalid");
    expect(Number(readFileSync(f.opens, "utf8"))).toBeLessThanOrEqual(3);
  } finally {
    for (let phase = 1; phase <= 3; phase++) writeFileSync(phaseFile(f.release, phase), "release owned reader\n");
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map(child => child.exited)); rmSync(f.root, { recursive: true, force: true });
  }
}, 20_000);
