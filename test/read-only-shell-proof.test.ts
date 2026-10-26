import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { proveReadOnlyShell, ShellExecutionProofs, gitHelpersUnconfigured } from "../src/hub/read-only-shell-proof.ts";
import { realPath } from "../src/hub/project.ts";
import { hostExecutable } from "../src/hub/host-executable.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { parseSource, findSymbol } from "../scripts/lib/ts-ast.ts";
import { guardPath, runTool, type ToolContext } from "../src/local/tools.ts";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=realPath(mkdtempSync(join(tmpdir(),"ahub-shell-proof-")));roots.push(root);mkdirSync(join(root,"src"));writeFileSync(join(root,"src/a.txt"),"safe\n");return root;}
const current=()=>true;

test("host shell proof uses actual path guard and refuses lexical PATH shadows including outside-target symlinks",()=>{
  const root=fixture(),opts={root,deny:["private"]};
  expect(proveReadOnlyShell({command:"cat src/a.txt"},opts,current)?.program).toBe("cat");
  for(const command of ["cat /etc/passwd","cat ../outside","cat private-note","sh -c pwd","cat '$HOME/file'"]) {
    // A literal $HOME filename is safe (no expansion); nonexistent ordinary filenames retain the path guard's policy.
    if(command.includes("'$HOME"))expect(proveReadOnlyShell({command},opts,current)?.program).toBe("cat");
    else expect(proveReadOnlyShell({command},opts,current),command).toBeUndefined();
  }
  symlinkSync("/etc/passwd",join(root,"escape"));
  expect(proveReadOnlyShell({command:"cat escape"},opts,current)).toBeUndefined();
  const host=hostExecutable("cat",root);mkdirSync(join(root,"bin"));symlinkSync(host,join(root,"bin/cat"));
  expect(proveReadOnlyShell({command:"cat src/a.txt"},{...opts,env:{PATH:`${root}/bin:/usr/bin:/bin`}},current)).toBeUndefined();
});

test("nested task roots do not trust a parent-project PATH program or its outside-target symlink",()=>{
  const projectRoot=fixture(),root=join(projectRoot,".worktrees/task");mkdirSync(root,{recursive:true});
  const bin=join(projectRoot,"node_modules/.bin");mkdirSync(bin,{recursive:true});
  const host=hostExecutable("ls",root),options={root,projectRoot,deny:[],env:{PATH:`${bin}:/usr/bin:/bin`}};
  writeFileSync(join(bin,"ls"),"#!/bin/sh\nexit 0\n",{mode:0o755});
  expect(proveReadOnlyShell({command:"ls"},options,current)).toBeUndefined();
  rmSync(join(bin,"ls"));symlinkSync(host,join(bin,"ls"));
  expect(proveReadOnlyShell({command:"ls"},options,current)).toBeUndefined();
  rmSync(join(bin,"ls"));
  expect(proveReadOnlyShell({command:"ls"},options,current)?.program).toBe("ls");
  const outside=fixture();writeFileSync(join(bin,"parent-ls"),"#!/bin/sh\nexit 0\n",{mode:0o755});symlinkSync(join(bin,"parent-ls"),join(outside,"ls"));
  expect(proveReadOnlyShell({command:"ls"},{...options,env:{PATH:outside}},current)).toBeUndefined();
});

test("raw symlink-parent paths and ambiguous PATH entries never receive automatic shell proof",()=>{
  const root=fixture(),outside=fixture(),target=join(outside,"child");mkdirSync(target);symlinkSync(target,join(root,"link"));
  writeFileSync(join(root,"secret"),"public lexical target");writeFileSync(join(outside,"secret"),"outside target");
  // Node.resolve/guardPath normalize before visiting link; the raw kernel pathname visits link first.
  expect(guardPath({cwd:root,deny:[]},"link/../secret","read")).toBe(join(root,"secret"));
  expect(readFileSync(`${root}/link/../secret`,"utf8")).toBe("outside target");
  for(const command of ["cat link/../secret","git -C link/.. status","rg -f link/../secret x src","find src -newer link/../secret"])
    expect(proveReadOnlyShell({command},{root,deny:[],env:{PATH:"/usr/bin:/bin"}},current),command).toBeUndefined();
  for(const path of [".:/usr/bin:/bin",":/usr/bin:/bin","bin:/usr/bin:/bin",`${root}/link/../bin:/usr/bin:/bin`])
    expect(proveReadOnlyShell({command:"ls"},{root,deny:[],env:{PATH:path}},current),path).toBeUndefined();
});

test("Git proof reads real effective helper config without trusting injected command overrides",()=>{
  const root=fixture();expect(hubGitSync(["init","-q",root],{encoding:"utf8"}).status).toBe(0);
  const git=hostExecutable("git",root),env={PATH:"/usr/bin:/bin",HOME:root,LANG:"C",TERM:"dumb"};
  expect(gitHelpersUnconfigured(git,root,env,current)).toBe(true);
  expect(gitHelpersUnconfigured(git,root,{...env,GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:"core.fsmonitor",GIT_CONFIG_VALUE_0:"false"},current)).toBe(false);
  expect(gitHelpersUnconfigured(git,root,{...env,GIT_CONFIG_PARAMETERS:"'core.fsmonitor=false'"},current)).toBe(false);
  writeFileSync(join(root,".git/config"),"[core]\nrepositoryformatversion = 0\nfsmonitor = false\n");
  expect(gitHelpersUnconfigured(git,root,env,current)).toBe(false);
  writeFileSync(join(root,".git/config"),"[core]\nrepositoryformatversion = 0\n");
  writeFileSync(join(root,".gitconfig"),"[core]\nfsmonitor = synthetic-helper\n");
  expect(gitHelpersUnconfigured(git,root,env,current)).toBe(false);
});

for (const [section, key, value] of [
  ["core", "fsmonitor", "false"],
  ["log", "showSignature", "true"],
  ["gpg", "program", "synthetic-helper"],
  ['gpg "openpgp"', "program", "synthetic-helper"],
  ['GPG "SSH"', "PROGRAM", "synthetic-helper"],
  ["diff", "external", "synthetic-helper"],
  ["format", "pretty", "format:%G?"],
  ["pretty", "audit", "format:%G?"],
  ['diff "x"', "command", "synthetic-helper"],
  ['diff "x.y"', "textconv", "synthetic-helper"],
] as const) test(`Git helper config [${section}] ${key} keeps every git form asking`, () => {
  const root = fixture();
  expect(hubGitSync(["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
  const options = { root, deny: [], env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "C", TERM: "dumb" } };
  const input = { command: "git log -n 1" };
  const proofs = new ShellExecutionProofs(options);
  const proof = proveReadOnlyShell(input, options, current);
  expect(proof?.program).toBe("git"); // The default repository still auto-grants.
  proofs.readonly(input, proof!, current);
  writeFileSync(join(root, ".git/config"), `[${section}]\n${key} = ${value}\n`);
  for (const command of ["git log -n 1", "git status --short", "git diff --no-ext-diff --no-textconv"])
    expect(proveReadOnlyShell({ command }, options, current), command).toBeUndefined();
  expect(proofs.check(input)).toBe("ask"); // A newly configured helper also invalidates the execution proof.
});

test("a signed-object fixture invokes default GPG through pretty placeholders, never through automatic forms", () => {
  const root = fixture(), bin = join(root, "bin"), gpg = join(bin, "gpg");
  mkdirSync(bin);
  writeFileSync(gpg, '#!/bin/sh\nprintf called > "$0.called"\nexit 1\n', { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, LANG: "C", TERM: "dumb", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (args: string[], input?: string) => hubGitSync(args, { cwd: root, env, input, encoding: "utf8", timeout: 1000 });
  expect(run(["init", "-q"]).status).toBe(0);
  const tree = run(["mktree"], "").stdout.trim();
  const raw = `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n dummy\n -----END PGP SIGNATURE-----\n\nfixture\n`;
  const commit = run(["hash-object", "-t", "commit", "-w", "--stdin"], raw).stdout.trim();
  expect(commit).toMatch(/^[0-9a-f]{40}$/);
  const options = { root, deny: [], env };
  expect(proveReadOnlyShell({ command: `git log --oneline -n 1 ${commit}` }, options, current)?.program).toBe("git");
  expect(proveReadOnlyShell({ command: `git log --format='%G?' ${commit}` }, options, current)).toBeUndefined();
  expect(run(["log", "--format=%G?", commit]).status).toBe(0);
  expect(readFileSync(`${gpg}.called`, "utf8")).toBe("called"); // Positive control: no helper-bearing config is needed.
});

test("proof revalidation catches root and path rebinding, preserves ordinary authority, and rejects ended owners",()=>{
  const root=fixture(),opts={root,deny:[]},proofs=new ShellExecutionProofs(opts),input={command:"cat src/a.txt"};
  const proof=proveReadOnlyShell(input,opts,current)!;expect(proof).toBeDefined();proofs.readonly(input,proof,current);expect(proofs.check(input)).toBe("valid");
  renameSync(join(root,"src"),join(root,"old-src"));mkdirSync(join(root,"src"));writeFileSync(join(root,"src/a.txt"),"changed");
  expect(proofs.check(input)).toBe("ask");
  proofs.ordinary(input,current);expect(proofs.check(input)).toBe("valid");
  let live=true;proofs.ordinary(input,()=>live);live=false;expect(proofs.check(input)).toBe("aborted");
  const noPath={command:"pwd"},p=proveReadOnlyShell(noPath,opts,current)!;proofs.readonly(noPath,p,current);
  renameSync(root,`${root}-old`);roots.push(`${root}-old`);mkdirSync(root);
  expect(proofs.check(noPath)).toBe("ask");
});

test("bash bridge reasks once after await mismatch and never executes unstable or aborted calls",async()=>{
  const root=fixture(),policies:unknown[]=[],proofs=new ShellExecutionProofs({root,deny:[]}),input={command:"cat src/a.txt"};
  // Exercise runTool's actual post-permit bridge; changing the guarded directory invalidates the real host proof.
  let calls=0;
  const ctx:ToolContext={cwd:root,deny:[],sandboxProfile:"",send:()=>"sent",permit:async(_t,_n,_s,_p,_o,_original,args,policy)=>{
    policies.push(policy);calls++;
    if(calls===1){const proof=proveReadOnlyShell(args,{root,deny:[]},current)!;expect(proof).toBeDefined();proofs.readonly(args,proof,current);await Promise.resolve();renameSync(join(root,"src"),join(root,"old-src"));mkdirSync(join(root,"src"));return true;}
    return false;
  },shellExecutionCheck:args=>proofs.check(args)};
  expect(await runTool("bash",JSON.stringify(input),ctx)).toContain("did not approve");
  expect(policies).toEqual([undefined,{forceAsk:true}]);
  const abort=new AbortController();abort.abort();
  expect(await runTool("bash",JSON.stringify(input),{...ctx,signal:abort.signal,permit:async()=>true})).toContain("cancelled");
});

test("a second unstable proof fails closed without a third approval or process",async()=>{
  const root=fixture(),options={root,deny:[]},proofs=new ShellExecutionProofs(options);let approvals=0;
  const ctx:ToolContext={cwd:root,deny:[],sandboxProfile:"",send:()=>"sent",permit:async(_title,_tool,_signal,_path,_observe,_original,input)=>{
    approvals++;const proof=proveReadOnlyShell(input,options,current)!;expect(proof).toBeDefined();proofs.readonly(input,proof,current);
    await Promise.resolve();renameSync(join(root,"src"),join(root,`old-src-${approvals}`));mkdirSync(join(root,"src"));writeFileSync(join(root,"src/a.txt"),"new");return true;
  },shellExecutionCheck:input=>proofs.check(input)};
  expect(await runTool("bash",JSON.stringify({command:"cat src/a.txt"}),ctx)).toContain("remained unstable; no command was executed");
  expect(approvals).toBe(2);
});

test("Seatbelt file and existing guardPath body remain byte-identical to the accepted base",()=>{
  const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
  expect(hash(readFileSync(new URL("../src/local/sandbox.ts",import.meta.url),"utf8"))).toBe("38b08b6c7fd93b65edee8ca770edc1db80840d363bfbc137ed0e80ae1c9a06f9"); // #518 and #520 moved this pin on purpose: moduleGitDirs and the modules trees changed (the #816 read-only shell slice itself left the file as a81626da...)
  const tools=readFileSync(new URL("../src/local/tools.ts",import.meta.url),"utf8"),spans=findSymbol(parseSource("tools.ts",tools),"guardPath");
  expect(spans).toHaveLength(1);
  const span=spans[0]!;expect(tools[span.end]).toBe("\n");
  expect(hash(tools.slice(span.start,span.end)+"\n")).toBe("c344f86f20f9d62baa47a621ed418d87d64b9f9060e2eb303f08aa67001cc1af");
});
