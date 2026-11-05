import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldCalls, freshShimReading, installFakeRipwire, withProbe } from "./helpers/ripwire-probe.ts";

// #723: the diagnostic helper for the two fake-ripwire CodeFacts tests. It must be invisible when nothing goes wrong, leave the fake's output and exit code exactly as written, and, when
// something does go wrong, name which of the three explanations the evidence supports.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig(fake: string) {
  const root = mkdtempSync(join(tmpdir(), "ahub-ripwire-probe-")); dirs.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  const probe = installFakeRipwire(root, bin, fake);
  const run = (...args: string[]) => { const r = Bun.spawnSync([join(bin, "ripwire"), ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }); return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }; };
  return { root, bin, probe, run };
}
const SIMPLE = `if(process.argv.includes("--version")){console.log("ripwire 0.6.7");process.exit(0);}console.log(JSON.stringify({of:"x"}));process.exit(process.argv.includes("--fail")?1:0);`;

test("the fake's stdout and exit code are exactly what its source says, through the probe's wrapper, for console.log, process.exit and a nonzero exit", () => {
  const f = rig(SIMPLE);
  expect(f.run("--version")).toEqual({ code: 0, out: "ripwire 0.6.7\n", err: "" });
  expect(f.run("--callers=x")).toEqual({ code: 0, out: '{"of":"x"}\n', err: "" });
  expect(f.run("--callers=x", "--fail")).toEqual({ code: 1, out: '{"of":"x"}\n', err: "" });
  // a fake that writes with process.stdout.write and one that never writes
  const raw = rig(`process.stdout.write("raw\\n");`); expect(raw.run()).toEqual({ code: 0, out: "raw\n", err: "" });
  const silent = rig(`process.exit(3);`); expect(silent.run()).toEqual({ code: 3, out: "", err: "" });
});

test("the passing path is silent: nothing on stdout or stderr from the helper, no diagnostic text unless asked, and the warm-up run is not counted as a call", async () => {
  const f = rig(SIMPLE);
  expect(existsSync(join(f.root, "ripwire-marks.log"))).toBe(false);                    // the warm-up (the area note's #519 rule) ran, and its marks were deleted: it is not a call of the test
  expect(readdirSync(join(f.root, "shim-stamps"))).toEqual([]);
  f.probe.markCall(); f.run("--callers=x"); f.run("--callees=x");
  let value = 0; expect(await withProbe(f.probe, async () => { value = 7; return value; })).toBe(7);   // a passing body returns its value untouched
  const text = await f.probe.diagnose();
  expect(text).toContain("2 fake ripwire launch(es)");                                    // exactly the two measured calls, not three
  expect(text).not.toContain("--version");                                                // the warm-up (`--version`) is excluded
});

test("a failing body rethrows the SAME error, with its assertion diff and stack intact, and the report appended to its message", async () => {
  const f = rig(SIMPLE);
  f.probe.markCall(); f.run("--callers=x");
  let caught: Error | undefined, original: Error | undefined;
  try { await withProbe(f.probe, async () => { try { expect({ a: 1 }).toEqual({ a: 2 }); } catch (error) { original = error as Error; throw error; } }); }
  catch (error) { caught = error as Error; }
  expect(caught).toBe(original);                                                          // the identical object, not a wrapper
  expect(caught!.message).toContain("Expected");                                          // the assertion's own message is still first
  expect(caught!.message.indexOf("Expected")).toBeLessThan(caught!.message.indexOf("[#723 ripwire diagnostics]"));
  expect(caught!.stack).toContain("ripwire-probe.test.ts");
  expect(caught!.message).toMatch(/loadavg .* cpus, free .* MB, os .* bun /);
  expect(caught!.message).toContain("a fresh shim of the same shape, run twice right now");
  // a non-Error throw is rethrown as it was
  await expect(withProbe(f.probe, async () => { throw "plain"; })).rejects.toBe("plain");
});

test("the report decomposes each call into the four gaps and says when a call never finished", async () => {
  const f = rig(`if(process.argv.includes("--hang")){await Bun.sleep(60000);}console.log("done");`);
  f.probe.markCall();
  f.run("--callers=x");
  const hung = Bun.spawn([join(f.bin, "ripwire"), "--hang"], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` }, stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(1500); hung.kill(); await hung.exited;
  const text = await f.probe.diagnose();
  expect(text).toMatch(/#1 --callers=x: before-shim \d+ ms \| shim->script \(Bun start-up\) \d+ ms \| script->first output \d+ ms \| output->exit \d+ ms/);
  expect(text).toMatch(/#2 --hang: .*output->exit never \(no exit mark: it never finished\)/);
});

test("the three explanations are told apart by the fresh-shim pair, and a middling pair says so", () => {
  expect(freshShimReading(5200, 300)).toContain("scan of newly written executables");
  expect(freshShimReading(5200, 4800)).toContain("runner load");
  expect(freshShimReading(300, 30)).toContain("not in launching a fresh executable");
  expect(freshShimReading(2000, 200)).toContain("inconclusive");
  expect(freshShimReading(200, 2500)).toContain("inconclusive");
});

test("foldCalls pairs the marks of each call by pid, keeps a call that has no exit, and survives a shim mark that reads later than the fake's own (a coarse mtime clock)", () => {
  const calls = foldCalls([
    { event: "shim", at: 10, pid: 1 }, { event: "script", at: 40, pid: 1, argv: "--callers=a" }, { event: "output", at: 55, pid: 1 }, { event: "exit", at: 60, pid: 1 },
    { event: "shim", at: 100, pid: 2 }, { event: "script", at: 130, pid: 2, argv: "--callees=a" }, { event: "output", at: 140, pid: 2 },
  ]);
  expect(calls).toEqual([{ argv: "--callers=a", shim: 10, script: 40, output: 55, exit: 60 }, { argv: "--callees=a", shim: 100, script: 130, output: 140 }]);
  // the shim's mtime reads 12 ms AFTER the script's own clock: still one call, not two
  // (the shim's pid is a file name, a string, and the fake's is a number: they are the same call)
  expect(foldCalls([{ event: "script", at: 40, pid: 7, argv: "x" }, { event: "shim", at: 52, pid: "7" }, { event: "exit", at: 60, pid: 7 }])).toEqual([{ argv: "x", shim: 52, script: 40, exit: 60 }]);
  expect(foldCalls([])).toEqual([]);
});

test("the watchdog is silent when disarmed in time and prints the report once when the call outlives it", async () => {
  const f = rig(SIMPLE);
  const lines: string[] = [], real = console.error; console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    const disarm = f.probe.watch(80, "quiet"); disarm(); await Bun.sleep(200);
    expect(lines).toEqual([]);
    const late = f.probe.watch(50, "late"); await Bun.sleep(900); late();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("late: still running 50 ms in, before the test's own timeout.");
    expect(lines[0]).toContain("[#723 ripwire diagnostics]");
  } finally { console.error = real; }
});
