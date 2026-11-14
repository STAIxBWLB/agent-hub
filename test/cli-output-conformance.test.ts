import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { renderHelp } from "../src/cli/help.ts";
import { PALETTE, Report, TONE_ROLE, paint } from "../src/cli/console-state.ts";
import { MARKERS, MARKER_COLUMN, MARKER_NAMES, ROLE_SGR, SECTION_MARKER, asciiMarkers, cellWidth, markerCell, resolveColor, streamEnv } from "../src/cli/output-standard.ts";

// CLI output standard v1 (docs/design/cli-output.md, #1484): the five conformance checks every CLI runs, the role and marker tables,
// the color precedence per stream, and the guard that keeps raw SGR codes out of human-output code.
const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli/main.ts");
const ESC = "\x1b";
const MARKERS_ENV = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "NO_COLOR", "FORCE_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "LC_ALL", "LC_CTYPE", "LANG"];
const root = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-cli-output-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
/** The CLI as a person runs it: no agent markers and no color or locale variables of this runner; stdout is a pipe unless `tty`. */
async function cli(args: string[], env: Record<string, string> = {}, tty = false) {
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS_ENV)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify({ TERM: "xterm-256color", ...env, AGENTHUB_HOME: join(root, "home") })});
${tty ? `Object.defineProperty(process.stdout, "isTTY", { value: true }); Object.defineProperty(process.stdout, "columns", { value: 80 });` : ""}
process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(CLI)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
const SGR = /\x1b\[[0-9;]*m/g;
/** A small report that uses every part of the layout grammar. */
function sample(columns = 80, ascii = false): Report {
  return new Report(columns, ascii).header("ahub", "Check", "v0.0.0  pid 1")
    .section("Attention", "2 items").bullet("fail", "codex-review 0.169.0 refused").next("ahub agents trust codex-review 0.169.0").bullet("warn", "memory unbound")
    .section("Hub").kv([["version", "0.39.0"], ["pid", 4242], ["endpoint", ""], ["a very long key that is wider than twenty eight cells", "value"]])
    .section("Checks").bullet("ok", "tools: git found").bullet("absent", "optional model not configured").bullet("unknown", "quota not reported")
    .summary({ failed: 1, warnings: 1, unknown: 1, ok: 3 });
}

describe("CLI output standard v1: roles", () => {
  test("the nine roles map to the normative ANSI codes, bold only on header, section and the status roles", () => {
    expect(ROLE_SGR).toEqual({ header: "\x1b[1;34m", section: "\x1b[1;35m", key: "\x1b[34m", value: "", success: "\x1b[1;32m", warning: "\x1b[1;33m", error: "\x1b[1;31m", hint: "\x1b[90m", accent: "\x1b[36m" });
    for (const [role, sgr] of Object.entries(ROLE_SGR)) expect(sgr.includes("1;")).toBe(["header", "section", "success", "warning", "error"].includes(role));
    for (const sgr of Object.values(ROLE_SGR)) expect(sgr).not.toMatch(/\[(?:[0-9;]*;)?(?:4[0-9]|10[0-7])m/); // no background colors
  });
  test("a role paints its text and value is the default foreground", () => {
    expect(paint([{ text: "x", role: "error" }], true)).toBe("\x1b[1;31mx\x1b[0m");
    expect(paint([{ text: "x", role: "value" }], true)).toBe("x");
    expect(paint([{ text: "x", role: "error" }], false)).toBe("x");
    expect(paint([{ text: "x", role: "error", tone: "success" }], true)).toBe("\x1b[1;31mx\x1b[0m");
  });
  test("Tone stays the console vocabulary and maps onto roles; identity tones stay out of the status roles", () => {
    expect(TONE_ROLE).toEqual({ info: "accent", strong: "header", success: "success", attention: "warning", failure: "error", muted: "hint", number: "value" });
    for (const tone of ["peerClaude", "peerCodex", "taskKeyword", "issueRef", "taskRef"] as const) expect(TONE_ROLE[tone]).toBeUndefined();
    expect(PALETTE.failure).toBe("\x1b[31m");
  });
});

describe("CLI output standard v1: markers", () => {
  test("each marker has its normative glyph, ASCII form and role, and fills the 2-cell marker column", () => {
    expect(MARKERS).toEqual({
      ok: { glyph: "✓", ascii: "ok", role: "success" }, fail: { glyph: "✗", ascii: "x", role: "error" }, warn: { glyph: "⚠", ascii: "!", role: "warning" },
      absent: { glyph: "-", ascii: "-", role: "hint" }, unknown: { glyph: "?", ascii: "?", role: "hint" }, pending: { glyph: "~", ascii: "~", role: "hint" },
      active: { glyph: "*", ascii: "*", role: "success" }, next: { glyph: "→", ascii: "->", role: "accent" },
    });
    expect(SECTION_MARKER).toEqual({ glyph: "▸", ascii: ">" });
    for (const name of MARKER_NAMES) for (const ascii of [false, true]) expect(cellWidth(markerCell(name, ascii))).toBe(MARKER_COLUMN);
    expect(new Set(MARKER_NAMES.map(name => MARKERS[name].glyph)).size).toBe(MARKER_NAMES.length);
  });
  test("East Asian Ambiguous glyphs are measured as one cell", () => {
    for (const name of MARKER_NAMES) expect(cellWidth(MARKERS[name].glyph)).toBe(1 + (name === "next" ? 1 : 0) * 0);
    expect(cellWidth(`${SECTION_MARKER.glyph} x`)).toBe(3);
  });
  test("ASCII forms follow --ascii and a locale that is not UTF-8 (LC_ALL, then LC_CTYPE, then LANG)", () => {
    expect(asciiMarkers({ LANG: "en_US.UTF-8" })).toBe(false);
    expect(asciiMarkers({ LANG: "ko_KR.utf8" })).toBe(false);
    expect(asciiMarkers({ LANG: "C" })).toBe(true);
    expect(asciiMarkers({})).toBe(true);
    expect(asciiMarkers({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe(true);
    expect(asciiMarkers({ LC_ALL: "en_US.UTF-8", LC_CTYPE: "C" })).toBe(false);
    expect(asciiMarkers({ LC_CTYPE: "C", LANG: "en_US.UTF-8" })).toBe(true);
    expect(asciiMarkers({ LANG: "en_US.UTF-8" }, true)).toBe(true);
  });
});

describe("CLI output standard v1: color precedence, per stream", () => {
  const tty = { isTTY: true }, pipe = { isTTY: false };
  test("the six rules, first match wins", () => {
    const cases: [string | undefined, Record<string, unknown>, boolean][] = [
      // 1 flag
      ["never", { ...tty, FORCE_COLOR: "1" }, false], ["always", { ...pipe, NO_COLOR: "1", TERM: "dumb" }, true],
      // 2 NO_COLOR non-empty, over FORCE_COLOR and CLICOLOR_FORCE
      [undefined, { ...tty, NO_COLOR: "1" }, false], ["auto", { ...tty, NO_COLOR: "1", FORCE_COLOR: "1" }, false], [undefined, { ...pipe, NO_COLOR: "1", CLICOLOR_FORCE: "1" }, false],
      [undefined, { ...tty, NO_COLOR: "" }, true],
      // 3 FORCE_COLOR / CLICOLOR_FORCE non-empty and not 0
      [undefined, { ...pipe, FORCE_COLOR: "1" }, true], [undefined, { ...pipe, FORCE_COLOR: "true" }, true], [undefined, { ...pipe, CLICOLOR_FORCE: "1" }, true],
      [undefined, { ...pipe, TERM: "dumb", FORCE_COLOR: "1" }, true], [undefined, { ...pipe, FORCE_COLOR: "" }, false], [undefined, { ...pipe, CLICOLOR_FORCE: "0" }, false],
      // 4 FORCE_COLOR=0 or CLICOLOR=0
      [undefined, { ...tty, FORCE_COLOR: "0" }, false], [undefined, { ...tty, CLICOLOR: "0" }, false], [undefined, { ...tty, CLICOLOR: "1" }, true], [undefined, { ...pipe, FORCE_COLOR: "0", CLICOLOR_FORCE: "1" }, true],
      // 5 TTY and TERM not dumb
      [undefined, { ...tty }, true], ["auto", { ...tty, TERM: "xterm-256color" }, true], [undefined, { ...tty, TERM: "dumb" }, false],
      // 6 otherwise
      [undefined, { ...pipe }, false], ["auto", { ...pipe, TERM: "xterm" }, false],
    ];
    for (const [flag, env, want] of cases) expect(resolveColor(flag, env as never)).toBe(want);
  });
  test("an unknown flag value is a usage error", () => {
    for (const flag of ["rainbow", "", "ALWAYS"]) expect(resolveColor(flag, tty)).toBeInstanceOf(Error);
  });
  test("each stream is decided on its own isTTY, with the same variables", () => {
    const env = { TERM: "xterm-256color" };
    expect(resolveColor(undefined, streamEnv(true, env))).toBe(true);
    expect(resolveColor(undefined, streamEnv(false, env))).toBe(false);
    expect(resolveColor(undefined, streamEnv(false, { ...env, FORCE_COLOR: "1" }))).toBe(true);
    expect(resolveColor(undefined, streamEnv(true, { ...env, NO_COLOR: "1" }))).toBe(false);
    expect(streamEnv(true, { TERM: "x", PATH: "/bin", FORCE_COLOR: "2", CLICOLOR: "0", CLICOLOR_FORCE: "1", NO_COLOR: "" })).toEqual({ isTTY: true, TERM: "x", NO_COLOR: "", FORCE_COLOR: "2", CLICOLOR: "0", CLICOLOR_FORCE: "1" });
  });
});

describe("CLI output standard v1: conformance checks", () => {
  test("1: a golden report with color off, and the same report with color on whose roles map to the ANSI codes", () => {
    const report = sample();
    expect(report.render(false).join("\n")).toBe([
      " ahub Check  v0.0.0  pid 1",
      "",
      "▸ Attention (2 items)",
      "  ✗  codex-review 0.169.0 refused",
      "    →  ahub agents trust codex-review 0.169.0",
      "  ⚠  memory unbound",
      "",
      "▸ Hub",
      "  version:   0.39.0",
      "  pid:       4242",
      "  endpoint:  (unset)",
      "  a very long key that is wider than twenty eight cells:",
      "    value",
      "",
      "▸ Checks",
      "  ✓  tools: git found",
      "  -  optional model not configured",
      "  ?  quota not reported",
      "",
      "✗ 1 failed  ⚠ 1 warning  ? 1 unknown  ✓ 3 ok",
    ].join("\n"));
    const painted = report.render(true);
    const [header, , section, fail, next, warn] = painted;
    expect(header).toBe(`${ROLE_SGR.header} ahub Check${"\x1b[0m"}${ROLE_SGR.hint}  v0.0.0  pid 1\x1b[0m`);
    expect(section).toBe(`${ROLE_SGR.section}▸ Attention\x1b[0m${ROLE_SGR.hint} (2 items)\x1b[0m`);
    expect(fail).toContain(`${ROLE_SGR.error}✗ \x1b[0m`);
    expect(next).toContain(`${ROLE_SGR.accent}→  ahub agents trust codex-review 0.169.0\x1b[0m`);
    expect(warn).toContain(`${ROLE_SGR.warning}⚠ \x1b[0m`);
    expect(painted.join("\n")).toContain(`${ROLE_SGR.key}version:\x1b[0m`);
    expect(painted.join("\n")).toContain(`${ROLE_SGR.hint}(unset)\x1b[0m`);
    expect(painted.at(-1)).toBe(`${ROLE_SGR.error}✗ 1 failed\x1b[0m  ${ROLE_SGR.warning}⚠ 1 warning\x1b[0m  ${ROLE_SGR.hint}? 1 unknown\x1b[0m  ${ROLE_SGR.success}✓ 3 ok\x1b[0m`);
    expect(painted.join("\n").replace(SGR, "")).toBe(report.render(false).join("\n"));
  });
  test("layout grammar: one blank line before each section, none after, never two in a row, no trailing blank; zero counts are omitted", () => {
    const lines = sample().render(false);
    for (const [index, line] of lines.entries()) {
      if (line.startsWith("▸ ")) { expect(lines[index - 1]).toBe(""); expect(lines[index + 1]).not.toBe(""); }
      if (line === "") expect(lines[index + 1]).not.toBe("");
    }
    expect(lines.at(-1)).not.toBe("");
    expect(new Report().section("A").summary({ ok: 2 }).render(false)).toEqual(["▸ A", "", "✓ 2 ok"]);
    expect(new Report().summary({}).render(false)).toEqual([]);
    expect(new Report().summary({ warnings: 3 }).render(false)).toEqual(["⚠ 3 warnings"]);
  });
  test("2: NO_COLOR=1 with --color=auto emits no ESC byte, FORCE_COLOR=1 on a pipe emits color", async () => {
    const forced = await cli(["help"], { FORCE_COLOR: "1" });
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain(ESC);
    expect((await cli(["help"], { FORCE_COLOR: "1", NO_COLOR: "1" })).stdout).not.toContain(ESC);
    expect((await cli(["help", "--color=auto"], { NO_COLOR: "1" }, true)).stdout).not.toContain(ESC);
    expect((await cli(["help"], {}, true)).stdout).toContain(ESC);
    expect((await cli(["help"], { CLICOLOR_FORCE: "1" })).stdout).toContain(ESC);
    expect((await cli(["help"], { FORCE_COLOR: "0" }, true)).stdout).not.toContain(ESC);
    expect((await cli(["help"])).stdout).not.toContain(ESC);
  }, 20_000);
  test("2: --json never contains ESC, whatever the color rules say", async () => {
    // doctor needs no hub; its exit code is not asserted here (it changes with #1484 T2).
    const json = await cli(["doctor", "--json", "--color=always"], { FORCE_COLOR: "1" }, true);
    expect(json.stdout).not.toContain(ESC);
    expect(Array.isArray(JSON.parse(json.stdout))).toBe(true);
  }, 20_000);
  test("3: at 80 columns no line exceeds 80 cells and the marker and key columns never wrap", () => {
    for (const line of renderHelp(80, false).split("\n")) expect(cellWidth(line)).toBeLessThanOrEqual(80);
    const long = "x".repeat(60) + " " + "word ".repeat(40);
    const report = new Report(80).header("ahub", "Long").section("S").bullet("warn", long).next("ahub " + "a".repeat(40)).kv([["note", long], ["id", 7]]);
    for (const columns of [80, 60]) {
      const lines = new Report(columns).section("S").bullet("warn", long).kv([["note", long], ["id", 7]]).render(false);
      for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(columns);
      expect(lines.filter(line => line.startsWith("  ⚠  ")).length).toBe(1);
      expect(lines.find(line => line.startsWith("  note:"))).toBeDefined();
      expect(lines.find(line => line.startsWith("  id:"))).toBe("  id:    7");
    }
    for (const line of report.render(false)) expect(cellWidth(line)).toBeLessThanOrEqual(80);
  });
  test("4: a failing command exits non-zero with the tool name on stderr, and nothing on stdout", async () => {
    const unknown = await cli(["no-such-command"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toMatch(/^ahub: /);
    expect(unknown.stdout).toBe("");
    const usage = await cli(["help", "--color=rainbow"]);
    expect(usage.code).not.toBe(0);
    expect(usage.stderr).toContain("ahub: ");
  }, 20_000);
  // The usage-error exit code 2 and the `✗ ahub:` marker on a terminal arrive with the shared fail() helper (#1484 T2, AC5).
  test.todo("4: a usage error exits 2 (#1484 T2)", () => {});
  test("5: with LANG=C the markers are ASCII and the report keeps its alignment", () => {
    const text = sample(80, asciiMarkers({ LANG: "C" })).render(false).join("\n");
    expect(text).toContain("> Attention (2 items)");
    for (const line of ["  x  codex-review 0.169.0 refused", "    -> ahub agents trust codex-review 0.169.0", "  !  memory unbound", "  ok tools: git found", "  -  optional model not configured", "  ?  quota not reported", "x 1 failed  ! 1 warning  ? 1 unknown  ok 3 ok"]) expect(text).toContain(line);
    expect(text).not.toMatch(/[^\x00-\x7f]/);
  });
});

/** Source files under a directory, relative to the repository root. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...sources(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}
/** An SGR sequence written as a literal: `\x1b[31m`, `\u001b[0m`, `\033[1m`, `\e[0m` or the ESC character itself. */
const RAW_SGR = /(?:\\x1[bB]|\\u001[bB]|\\u\{1[bB]\}|\\033|\\e|\x1b)\[[0-9;$\{\}a-zA-Z_.]*m/;
/** AC1: `output-standard.ts` (roles and the console tones), the identity palettes and the full-screen console own raw codes; every other human-output file names a role. */
const SGR_ALLOWED = new Set(["src/cli/output-standard.ts", "src/cli/console.ts", "src/ui/peer-palette.ts", "src/adapters/definitions/native-display.ts"]);
describe("CLI output standard v1: no raw SGR in human-output code", () => {
  test("the detector finds each literal form and ignores cursor, mode and key sequences", () => {
    for (const form of ["\\x1b[31m", "\\x1B[0m", "\\u001b[1;36m", "\\033[90m", "\\e[0m", "\x1b[32m", "`\\x1b[${code}m`"]) expect(RAW_SGR.test(form)).toBe(true);
    for (const form of ["\\x1b[?1049h", "\\x1b[2K", "\\x1b[A", "\\x1b", "key === \"\\x1b\"", "\\x1b[${row};1H"]) expect(RAW_SGR.test(form)).toBe(false);
  });
  test("src/cli and src/hub carry no SGR literal outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of [...sources("src/cli"), ...sources("src/hub")]) {
      if (SGR_ALLOWED.has(file)) continue;
      readFileSync(join(ROOT, file), "utf8").split("\n").forEach((line, index) => { if (RAW_SGR.test(line)) offenders.push(`${file}:${index + 1}`); });
    }
    expect(offenders).toEqual([]);
  });
  test("every allowlisted file exists, so the list cannot rot", () => {
    for (const file of SGR_ALLOWED) expect(statSync(join(ROOT, file)).isFile()).toBe(true);
    expect(relative(ROOT, join(ROOT, "src/cli/output-standard.ts"))).toBe("src/cli/output-standard.ts");
  });
});
