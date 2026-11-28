import { renderSettingsRows, renderSdlcSetting, renderSettingsConfirmation, renderSettingsPreview, renderSettingsReceipt, renderSettingsRejected } from "../src/cli/settings-output.ts";
import type { SettingRow } from "../src/hub/settings.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Report as PackageReport, errorLine, errorSpans, lineSpans, paint as packagePaint, terminalText as packageText, wrap as packageWrap, wrapSpans as packageWrapSpans } from "@staix/cli-output";
import { sanitize } from "../src/hub/envelope.ts";
import { renderHelp } from "../src/cli/help.ts";
import { renderStatus, renderStatusDefault, renderReport } from "../src/cli/output.ts";
import { summarize } from "../src/hub/report.ts";
import { renderAuthorization, renderSdlcAudit, renderSdlcConfiguration, renderSdlcCosts, renderSdlcExplain, renderSdlcMerge, renderSdlcMetrics, renderSdlcQueue, renderSdlcRelease, renderSdlcStatus, renderSdlcSurvey, renderSdlcReceipt, renderSdlcReadback, renderSdlcTrain } from "../src/cli/sdlc-output.ts";
import { renderBacklogResult, renderGroom, renderReleaseList, renderReleaseShow, renderTaskCancel, renderTaskShow } from "../src/cli/task-output.ts";
import { renderSourceAdd, renderSourceList } from "../src/cli/source-output.ts";
import { renderScheduleChange, renderScheduleList, renderScheduleRun } from "../src/cli/schedule-output.ts";
import { renderExperiments, renderStudyEvidence, renderStudyList, renderStudyReceipt, renderStudyShow, renderSynthesisReadiness } from "../src/cli/study-output.ts";
import { renderHandoffReceipt, renderHandoffs } from "../src/cli/handoff-output.ts";
import { renderLearnChange, renderLearnList } from "../src/cli/learn-output.ts";
import { renderIntake, renderIntakeChange } from "../src/cli/intake-output.ts";
import { renderCapabilities } from "../src/cli/capabilities-output.ts";
import { renderTidyPreview, renderTidyResult, renderWorktrees } from "../src/cli/worktrees-output.ts";
import { renderRoomInbox, renderRoomInboxResult, renderRoomPreview, renderRoomResult, renderRooms } from "../src/cli/room-output.ts";
import { PALETTE, Report, TONE_ROLE, paint, table, wrap } from "../src/cli/console-state.ts";
import { errorLines, failureExitCode, warningLines } from "../src/cli/error-format.ts";
import { MARKERS, MARKER_COLUMN, MARKER_NAMES, ROLE_SGR, SECTION_MARKER, SGR_RESET, asciiMarkers, cellWidth, markerCell, resolveColor, streamEnv } from "../src/cli/output-standard.ts";

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

const packageFixtures = join(dirname(dirname(fileURLToPath(import.meta.resolve("@staix/cli-output")))), "fixtures", "v1");

test("published standard v1 fixtures match the hub and package", async () => {
  const colors = await Bun.file(join(packageFixtures, "color.json")).json();
  for (const fixture of colors) {
    const value = resolveColor(fixture.flag, fixture.env, fixture.tool ?? "ahub");
    if (fixture.expectedError !== undefined) expect(value).toEqual(new Error(fixture.expectedError));
    else expect(value).toBe(fixture.expected);
  }
  const markers = await Bun.file(join(packageFixtures, "markers.json")).json();
  for (const fixture of markers) {
    expect(markerCell(fixture.name, false)).toBe(fixture.utf8);
    expect(markerCell(fixture.name, true)).toBe(fixture.ascii);
  }
  const errors = await Bun.file(join(packageFixtures, "error-line.json")).json();
  for (const fixture of errors) {
    expect(errorLine(fixture.tool, fixture.what, fixture.why, fixture.options, fixture.columns)).toEqual(fixture.expected);
    expect(errorSpans(fixture.tool, fixture.what, fixture.why, fixture.options, fixture.columns)).toEqual(fixture.spans);
    expect(errorSpans(fixture.tool, fixture.what, fixture.why, fixture.options, fixture.columns).map(line => packagePaint(line, true))).toEqual(fixture.colored);
    const message = `${fixture.what}${fixture.why ? `: ${fixture.why}` : ""}`;
    expect(errorLines(message, fixture.options.next?.replaceAll(fixture.tool, "ahub"), fixture.options.tty, fixture.options.ascii ?? false)).toEqual(errorLine(fixture.tool, fixture.what, fixture.why, fixture.options).map((line: string) => line.replaceAll(fixture.tool, "ahub")));
  }
  const texts = await Bun.file(join(packageFixtures, "text.json")).json();
  for (const fixture of texts) expect(packageText(fixture.input, fixture.options)).toBe(fixture.expected);
  const wraps = await Bun.file(join(packageFixtures, "wrap.json")).json();
  for (const fixture of wraps) expect(packageWrap(fixture.input, fixture.columns, fixture.hang)).toEqual(fixture.expected);
  const spanWraps = await Bun.file(join(packageFixtures, "span-wrap.json")).json();
  for (const fixture of spanWraps) {
    const lines = packageWrapSpans(fixture.input, fixture.columns, fixture.hang);
    expect(lines).toEqual(fixture.expected);
    expect(lines.map(line => packagePaint(line, true, fixture.styles))).toEqual(fixture.colored);
  }
  const reports = readdirSync(join(packageFixtures, "report")).filter(name => name.endsWith(".json"));
  expect(reports.length).toBeGreaterThan(0);
  for (const file of reports) {
    const fixture = await Bun.file(join(packageFixtures, "report", file)).json();
    const fixtureSanitizer = fixture.input.sanitizer === "quote-headers" ? sanitize : fixture.input.sanitizer === "drop-cr" ? (text: string) => text.replace(/\r/g, "") : undefined;
    const shared = new PackageReport(fixture.input.columns ?? undefined, fixture.input.ascii, { sanitize: fixtureSanitizer, styles: fixture.input.styles, ...fixture.input.reportOptions });
    const local = new Report(fixture.input.columns ?? undefined, fixture.input.ascii);
    let hasTable = false, hasWrappedCommand = false, packageOnly = !!fixture.input.sanitizer || !!fixture.input.styles || !!fixture.input.reportOptions;
    for (const op of fixture.input.operations) {
      switch (op.op) {
        case "header": shared.header(op.tool, op.name, op.context); local.header(op.tool, op.name, op.context); break;
        case "section": shared.section(op.name, op.count); local.section(op.name, op.count); break;
        case "kv": shared.kv(op.rows, op.indent, op.options); if (op.options || op.indent) packageOnly = true; else local.kv(op.rows); break;
        case "bullet": shared.bullet(op.marker, op.text, op.nested); local.bullet(op.marker, op.text, op.nested); break;
        case "next": shared.next(op.command); local.next(op.command); if (file.startsWith("next-")) hasWrappedCommand = true; break;
        // The hub table keeps its existing styled cells and geometry: STAIxBWLB/cli-output#37.
        case "table": shared.table(op.head, op.rows, op.flexible, op.options); hasTable = true; break;
        case "append": shared.append(op.lines); packageOnly = true; break;
        case "line": shared.line(op.text); if (op.lines) expect(lineSpans(op.text, fixture.input.columns ?? undefined).map(line => packagePaint(line, false))).toEqual(op.lines); packageOnly = true; break;
        case "note": shared.note(op.text, op.role); local.note(op.text, op.role); break;
        case "summary": shared.summary(op.counts); local.summary(op.counts); break;
        default: throw new Error(`unknown standard fixture operation ${op.op}`);
      }
    }
    expect(shared.render(false)).toEqual(fixture.plain);
    expect(shared.render(true)).toEqual(fixture.colored);
    // The package fixture tests its wrapped default; the hub selects the unwrapped option.
    if (!hasTable && !hasWrappedCommand && !packageOnly) { expect(local.render(false)).toEqual(fixture.plain); expect(local.render(true)).toEqual(fixture.colored); }
    if (hasWrappedCommand) expect(local.render(false)).toHaveLength(1);
  }
});

test("hub report keeps legacy command and sanitization behavior while using shared primitives", () => {
  const command = "ahub " + "word ".repeat(20).trim();
  expect(new Report(20).next(command).render(false)).toEqual([`    →  ${command}`]);
  expect(new Report().note("a\rb").render(false)).toEqual(["  ab"]);
  expect(new Report(16).note("--- from x --- from x").render(false)).toEqual(["  > --- from x", "  > --- from x"]);
  const hub = new Report().header("ahub", "Check").section("Results").summary({ ok: 2 });
  const shared = new PackageReport().header("ahub", "Check").section("Results").summary({ ok: 2 });
  expect(hub.lines()).toEqual(shared.lines());
  expect(paint([{ text: "peer", tone: "peerClaude" }], true)).toBe(PALETTE.peerClaude + "peer" + SGR_RESET);
});

test("legacy wrap and table edges retain their existing output", () => {
  expect(wrap("👩‍💻🇰🇷y", 3, 0)).toEqual(["👩‍💻🇰", "🇷y"]);
  expect(wrap("ab", 0, 0)).toEqual(["a", "b"]);
  expect(wrap("--- from x --- from x", 14, 0)).toEqual(["> --- from x", "> --- from x"]);
  const lines = table(["name", "value"], [[{ text: "x".repeat(30), tone: "peerClaude" }, { text: "ok" }]], 60).map(line => paint(line, true));
  expect(lines).toEqual([`${PALETTE.info}name                      ${SGR_RESET}${PALETTE.info}value${SGR_RESET}`, `${PALETTE.peerClaude}${"x".repeat(21)}...  ${SGR_RESET}ok`]);
  const multiline = table(["name", "value"], [[{ text: "alpha" }, { text: "one\ntwo" }]], 40).map(line => paint(line, false));
  expect(multiline[1]).toBe("alpha  one\ntwo");
});

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
    for (const [flag, env, want] of cases) expect(resolveColor(flag, env as never, "ahub")).toBe(want);
  });
  test("an unknown flag value is a usage error", () => {
    for (const flag of ["rainbow", "", "ALWAYS"]) expect(resolveColor(flag, tty, "ahub")).toBeInstanceOf(Error);
  });
  test("each stream is decided on its own isTTY, with the same variables", () => {
    const env = { TERM: "xterm-256color" };
    expect(resolveColor(undefined, streamEnv(true, env), "ahub")).toBe(true);
    expect(resolveColor(undefined, streamEnv(false, env), "ahub")).toBe(false);
    expect(resolveColor(undefined, streamEnv(false, { ...env, FORCE_COLOR: "1" }), "ahub")).toBe(true);
    expect(resolveColor(undefined, streamEnv(true, { ...env, NO_COLOR: "1" }), "ahub")).toBe(false);
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
  test("4: a usage error exits 2, an unknown command too, and the error line is plain on a pipe", async () => {
    const usage = await cli(["task", "show"]);
    expect(usage.code).toBe(2); expect(usage.stdout).toBe("");
    expect(usage.stderr).toMatch(/^ahub: usage: ahub task show/);
    const unknown = await cli(["no-such-command"]);
    expect(unknown.code).toBe(2); expect(unknown.stderr).toBe('ahub: unknown command "no-such-command"; run ahub help\n');
    expect(unknown.stderr).not.toMatch(/[✗→]/); // a piped stderr keeps the plain `ahub: ` form
  }, 20_000);
  test("4: the error line leads with the fail marker only on a terminal, carries an optional copyable next step, and falls back to ASCII", () => {
    expect(errorLines("no task #9", undefined, false, false)).toEqual(["ahub: no task #9"]);
    expect(errorLines("no task #9", undefined, true, false)).toEqual(["✗ ahub: no task #9"]);
    expect(errorLines("no task #9", "ahub board", true, false)).toEqual(["✗ ahub: no task #9", "  → ahub board"]);
    expect(errorLines("no task #9", "ahub board", false, true)).toEqual(["ahub: no task #9", "  -> ahub board"]);
    expect(errorLines("x", "cd /p && ahub init\u001b[31m", false, false)[1]).not.toContain("\u001b"); // a next step is sanitized like any text
  });
  test("4: usage errors exit 2 and everything else 1", () => {
    for (const message of ["usage: ahub stop <peer>", 'unknown command "x"; run ahub help', "--after pages a campaign\nusage: ahub study ...", "--task needs a value", "invalid release command", "ahub research: unknown argument --x (another project)", "usage: ahub answer ...; unknown flag --x", "unknown flag --x", 'unknown option "--x" for ahub task propose; nothing was filed']) expect(failureExitCode(message), message).toBe(2);
    for (const message of ["no task #9", "never-ask requires --yes; nothing was changed", "no hub running for /p (run: ahub up)", "cannot read the manifest file"]) expect(failureExitCode(message), message).toBe(1);
  });
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

// #1484 T2: the doctor's exit-1 rule is set where the report prints, and `ahub setup`, which runs the same function, clears it first. A real `ahub setup` writes to
// the machine (plugin, home registration), so a test never starts one; this pins the two statements that carry the rule instead.
test("#1484 ahub doctor exits 1 on a failed row but ahub setup clears the rule before it runs the same report", () => {
  const main = readFileSync(join(ROOT, "src/cli/main.ts"), "utf8");
  expect(main).toContain("let doctorSetsExit = true;");
  expect(main).toMatch(/else \{ doctorSetsExit = false; await commands\.doctor!\(\); \}/);
  expect(main).toMatch(/if \(doctorSetsExit && checks\.some\(check => check\.level === "fail"\)\) process\.exitCode = 1;/);
});

test("#1484 a Report with no wrap width keeps every line whole, and one with a width wraps at it", () => {
  const long = "word ".repeat(60).trim();
  const free = new Report(undefined).section("S").bullet("warn", long).kv([["note", long]]).render(false);
  expect(free.filter(line => line.includes("word")).every(line => Bun.stringWidth(line) > 200)).toBe(true);
  expect(free.some(line => /^ {3,}word/.test(line))).toBe(false);
  for (const line of new Report(80).section("S").bullet("warn", long).kv([["note", long]]).render(false)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
});

test("list views open with the standard header and a counted section, and print only one bare line when empty (#1654 T3)", async () => {
  const { renderQueue, renderTurns, renderProjects, renderOrphans } = await import("../src/cli/output.ts");
  for (const [name, spans, empty] of [["Queue", renderQueue([], 80), "no retained deliveries"], ["Turns", renderTurns([], 80, Date.now()), "no turns recorded"], ["Projects", renderProjects([], 80, Date.now()), "No registered projects"], ["Orphans", renderOrphans([], 80), "no orphaned hub registrations"]] as const) {
    const lines = spans.map(line => line.map(span => span.text).join(""));
    expect(lines.length, name).toBe(1);
    expect(lines[0]!.startsWith(empty), name).toBe(true);
    expect(lines.some(line => line.startsWith("▸ ") || line.startsWith(` ahub ${name}`)), name).toBe(false);
  }
  const filled = renderQueue([{ id: 1, peer: "claude", state: "queued" }], 80, Date.now()).map(line => line.map(span => span.text).join(""));
  expect(filled[0]!.startsWith(" ahub Queue")).toBe(true);
  expect(filled.some(line => line.startsWith("▸ "))).toBe(true);
});

// #1654 T4: the grammar checks run over the real output of every command family moved onto the shared Report in T3, not over a sample report.
describe("CLI output standard v1: each converted view follows the grammar (#1654 T4)", () => {
  const A = "a".repeat(40), NOW = 1_800_000_000_000;
  const peer = { state: "idle", doing: "", since: NOW - 60_000, tokens: 0 };
  const status = { version: "0.40.0", pid: 4242, controlPort: 12345, cwd: "/work/project", peers: { claude: peer }, tasks: { in_progress: 2 } } as any;
  const taskCard = { id: 7, title: "Implement the human output for every task command with a title long enough to need wrapping", detail: "A long detail line that wraps.", class: "implement", owner: "jcode", reviewer: "claude", planner: "claude", state: "in_review", refs: { repo: "owner/repo", branch: "feat/x", commit: A, paths: ["src/cli/task-output.ts"] }, plan: { paths: ["src/cli/task-output.ts"], symbols: ["renderTaskShow"] }, deps: [1, 2, 3], created: NOW - 7_200_000, updated: NOW - 60_000, rank: 3, priority: 1, planningRevision: 4, flowRevision: 9, approval: { head: A, latestHead: A, current: true }, symbolOverlaps: [{ task: 8, files: ["src/hub/tasks.ts"], sameFileDifferentSymbols: true }], deliverables: { state: "approved", changedSinceReview: true, files: [{ id: "d1", sha256: "b".repeat(64), state: "changed", path: "docs/report.md", format: "md" }] }, reviews: [{ kind: "approved", reviewer: "claude", at: NOW - 3_600_000 }], history: [{ at: NOW - 60_000, by: "claude", event: "changes_requested", note: "a note" }] };
  const settingsRow: SettingRow = { key: "research.enabled", group: "Switches", label: "Research task tools", value: true, fileValue: false,
    type: "boolean", source: "config.local.json", file: "config.local.json", applies: "live", risk: "raises" };
  const views: Record<string, (columns: number | undefined, ascii: boolean) => ReturnType<typeof renderSdlcMerge>> = {
    "status --verbose": (c, a) => renderStatus(status, c, NOW, false, a),
    "status": (c, a) => renderStatusDefault(status, c, NOW, a),
    "report": (c, a) => renderReport(summarize([]), c, NOW, false, a),
    "sdlc authorize-release": (c, a) => renderAuthorization({ version: "0.18.0", commit: A, by: "person", at: NOW - 60_000, id: "11111111-2222-3333-4444-555555555555", docs: { fresh: true, documents: 3, digest: A } }, c, NOW, a),
    "sdlc merge": (c, a) => renderSdlcMerge({ task: 7, mode: "on", ran: false, decision: "refused", refused: ["auto_merge is off for this repository"] }, c, NOW, a),
    "sdlc queue": (c, a) => renderSdlcQueue({ report: { repo: "owner/a-repository-with-a-long-name", complete: true, order: [830], rows: [{ pr: 830, tasks: [7], ready: false, head: A, after: [], blockers: ["required check is not successful"] }] } }, c, NOW, a),
    "sdlc release": (c, a) => renderSdlcRelease({ report: { repo: "owner/repo", head: A, ready: false, native: "unverified", blockers: ["documents not fresh"] } }, c, NOW, a),
    "sdlc status": (c, a) => renderSdlcStatus({ mode: "advise", rows: [{ id: 7, title: "task", stage: "implementation-review", mode: "advise", ready: false, actor: "owner/planner", next: "wait", blockers: ["no review"], receipt: { pr: 807 } }] }, c, NOW, a),
    "sdlc explain": (c, a) => renderSdlcExplain({ mode: "advise", rows: [{ id: 7, title: "task", stage: "review", mode: "advise", ready: false, actor: "reviewer", next: "wait", blockers: [] }] }, c, NOW, a),
    "sdlc metrics": (c, a) => renderSdlcMetrics({ since: null, tasks: 1, metrics: {}, bands: "off" }, c, NOW, a),
    "sdlc costs": (c, a) => renderSdlcCosts({ rows: [{ repo: "owner/repo", pr: 830, reviewRounds: 1, ciRuns: 2, complete: true }] }, c, NOW, a),
    "sdlc audit": (c, a) => renderSdlcAudit({ audit: { audit: "A1", task: 7, ref: A, profile: "standard", counts: { covered: 1 }, findings: {}, units: [], items: [] } }, c, NOW, a),
    // #1654 AC3: the views that still used the old heading/pair/grid helpers
    "sdlc configure": (c, a) => renderSdlcConfiguration({ by: "claude", restartPending: ["sdlc.toml"], lines: ["mode advise", "required checks unit, lint"], backup: "/work/project/.agenthub/sdlc.toml.bak" }, c, NOW, a),
    "sdlc survey": (c, a) => renderSdlcSurvey({ task: 7, survey: 3, ref: A, focus: "tests", items: [{ finding: { id: "F1", evidence: "src/cli/a.ts:1", impact: "high", fix_sketch: "guard the call" }, decision: { verdict: "accepted" }, rejected: [{ id: "R1", change: "unknown", reason: "covered by an existing guard" }] }], rejected: [{ id: "R2", status: "unknown", reason: "older survey" }] }, c, NOW, a),
    "sdlc release-guard": (c, a) => renderSdlcReceipt({ title: "Release guard", lines: ["release authorization matched"] }, c, NOW, a),
    "sdlc audit start": (c, a) => renderSdlcReceipt({ title: "Audit start", lines: ["task #7: security audit A1 started at aaaaaaaaaaaa, 4 units (3 planned, 1 carried over), partial"] }, c, NOW, a),
    "sdlc accept-departure": (c, a) => renderSdlcReceipt({ title: "Accept departure", lines: ["task #7: plan departure accepted for the reviewed head"] }, c, NOW, a),
    "sdlc adopt-merge": (c, a) => renderSdlcReceipt({ title: "Adopt merge", lines: ["task #7: merged outside the hub; approved"] }, c, NOW, a),
    "sdlc accept": (c, a) => renderSdlcReceipt({ title: "Accept spec", lines: ["spec read-back: none (start one with ahub sdlc readback start 7)", "task #7: spec issue #21 accepted at body edit never"] }, c, NOW, a),
    "sdlc readback start": (c, a) => renderSdlcReadback({ task: 7, op: "start", reply: { state: "requested", readback: 5, reader: "claude", repo: "owner/repo", issue: 21 } }, c, NOW, a),
    "sdlc readback show": (c, a) => renderSdlcReadback({ task: 7, op: "show", reply: { readback: { status: "reported", readback: 5, reader: "claude", repo: "owner/repo", issue: 21, report: { proposes: "Use the shared report", existing: "Raw output", undefined: [{ term: "scope", where: "section 2" }], open_decisions: [{ decision: "name the view", where: "section 3" }], refs: ["src/cli/main.ts"] }, missing_refs: ["docs/old.md"] } } }, c, NOW, a),
    "sdlc train report": (c, a) => renderSdlcTrain({ release: { id: 2, name: "0.18.0", goal: "Release reports", state: "active", revision: 6 }, readiness: { trigger: "waiting", tasks: [{ id: 7, state: "in_review" }], blockers: ["task #7: not approved"] }, native: "unverified", metrics: { hotfixCount: 2, hotfixRate: 0.5, ciRuns: 7, reviews: 3, unknown: [1], intervals: [{ from: 1, to: 2, ms: 900000 }] } }, c, NOW, a),
    "sdlc train configure": (c, a) => renderSdlcTrain({ id: 2, name: "0.18.0", goal: "Release reports", state: "active", revision: 7 }, c, NOW, a),
    "sdlc train cut": (c, a) => renderSdlcTrain({ id: 2, name: "0.18.0", goal: "Release reports", state: "frozen", revision: 8, train: { scope: [7, 21] } }, c, NOW, a),
    "sdlc release-assign": (c, a) => renderTaskShow({ ...taskCard, release: 2 }, c, NOW, a),
    "sdlc plan-review": (c, a) => renderTaskShow(taskCard, c, NOW, a),
    "settings list": (c, a) => renderSettingsRows({ rows: [settingsRow], pendingRestart: [{ key: "routing.classes.implement.peers" }], undo: settingsRow.key }, c, NOW, a),
    "settings get": (c, a) => renderSettingsRows({ rows: [settingsRow], detail: true }, c, NOW, a),
    "settings get sdlc": (c, a) => renderSdlcSetting({ key: "sdlc.required_checks", value: ["staged checks"], fileValue: ["planned checks"], problem: true }, c, NOW, a),
    "settings reload rejected": (c, a) => renderSettingsRejected([{ key: "codex_bin", reason: "restart only" }], c, NOW, a),
    "settings reload confirmation": (c, a) => renderSettingsConfirmation([{ key: "permission_modes.kimi", before: '"ask"', after: '"never-ask"', effect: "approval prompts are disabled" }], c, NOW, a),
    "settings reload result": (c, a) => renderSettingsReceipt({ title: "Settings reload", lines: ["configuration reloaded"] }, c, NOW, a),
    "settings undo": (c, a) => renderSettingsReceipt({ title: "Settings undo", lines: ["research.enabled: put back to false"] }, c, NOW, a),
    "settings preview": (c, a) => renderSettingsPreview({ lines: ["routing.classes.implement.peers: kimi -> codex"], tasks: [{ before: ["task #7", "if it were assigned now:", "kimi selected"], after: ["task #7", "if it were assigned now:", "codex selected"] }], hidden: 1 }, c, NOW, a),
    "settings set": (c, a) => renderSettingsReceipt({ title: "Settings set", lines: ["research.enabled: true (in force now)", "applies at once"] }, c, NOW, a),
    "settings edit": (c, a) => renderSettingsReceipt({ title: "Settings edit", lines: ["config.local.json written: review.pool", "restart pending: sdlc.mode"] }, c, NOW, a),
    "settings backups": (c, a) => renderSettingsReceipt({ title: "Settings backups", lines: ["config.local.json  90 bytes  fixture backup"] }, c, NOW, a),
    "task show": (c, a) => renderTaskShow(taskCard, c, NOW, a),
    "task cancel": (c, a) => renderTaskCancel({ ...taskCard, state: "cancelled", cancelled: { reason: "superseded by the new plan", supersededBy: "#8" } }, c, NOW, a),
    "backlog plan": (c, a) => renderBacklogResult("plan", { ...taskCard, state: "backlog", planningRevision: 0, history: [{ at: NOW - 1000, by: "claude", event: "planned", note: "priority 1" }] }, c, NOW, a),
    "backlog split": (c, a) => renderBacklogResult("split", { parent: taskCard, children: [{ id: 21, title: "first part", state: "backlog", deps: [] }, { id: 22, title: "second part", state: "backlog", deps: [21] }] }, c, NOW, a),
    "backlog groom": (c, a) => renderGroom({ items: [{ kind: "overlap", task: 7, related: [8, 9], code: "tests", personCommand: "ahub backlog return 7 3 reason" }], unknown: [11], truncated: true, privateTasks: "withheld" }, c, NOW, a),
    "release list": (c, a) => renderReleaseList([{ id: 2, name: "0.18.0", goal: "Readable output", order: 2, state: "active", revision: 4, plannedStart: NOW - 86_400_000, tasks: [{ id: 7, state: "in_progress" }], afterCut: null }], c, NOW, a),
    "release show": (c, a) => renderReleaseShow({ id: 2, name: "0.18.0", goal: "Readable output", order: 2, state: "active", revision: 4, tasks: [], afterCutUnknown: [41], afterCutUnknownCount: 1, afterCut: null }, c, NOW, a),
    // #1654 AC3 close-out: the last eight output files
    "source add": (c, a) => renderSourceAdd({ id: "src:e5d53b3ad5222924", created: true, kind: "file", origin: "/a/very/long/path/to/a/note.txt", sha256: "e".repeat(64), bytes: 13, private: true, text: true, reasons: ["path under pii.paths"] }, c, NOW, a),
    "source list": (c, a) => renderSourceList([{ id: "src:e5d53b3ad5222924", kind: "file", origin: "/a/note.txt", sha256: "e".repeat(64), bytes: 13, added_at: NOW - 1000, private: false, origins: [{ origin: "/a/note.txt", private: false }, { origin: "/b/note.txt", private: true }] }], c, NOW, a),
    "schedule list": (c, a) => renderScheduleList([{ id: "nightly", every: "1h", class: "plan", queue: "backlog", state: "scheduled", next: NOW + 3_600_000, coalesced: 2, error: "could not propose" }], c, NOW, a),
    "schedule run": (c, a) => renderScheduleRun({ id: "nightly", outcome: "ran", task: 12 }, c, NOW, a),
    "schedule pause": (c, a) => renderScheduleChange("pause", [{ id: "nightly", every: "1h", state: "paused", next: NOW + 3_600_000 }], c, NOW, a),
    "study list": (c, a) => renderStudyList({ campaigns: [{ id: "rc-1", revision: 2, status: "approved", parentTaskId: 7, unitCount: 3 }], next: "rc-1" }, c, NOW, a),
    "study show": (c, a) => renderStudyShow({ id: "rc-1", revision: 2, held: true, reasons: ["a source is missing"], units: [{ unitId: "u1", round: 1, taskId: 8, state: "open", purpose: "discover", handoff: {}, sourceIds: [] }], rounds: [] }, c, NOW, a),
    "study receipt": (c, a) => renderStudyReceipt("draft", { id: "rc-1", revision: 1, status: "draft", parentTaskId: 7, unitCount: 1, units: [{ unitId: "u1", taskId: 8, round: 1 }] }, c, NOW, a),
    "study experiments": (c, a) => renderExperiments({ attempts: [{ id: "ra-1", taskId: 2, phase: "final", status: "succeeded", approval: "unapproved", postHoc: "predeclared" }], counts: { all: 1, statuses: { succeeded: 1 } } }, c, NOW, a),
    "study evidence": (c, a) => renderStudyEvidence({ status: "resolved", id: "ev-1", revision: 1, link: { sourceId: "src:1" }, locator: { start: 0, end: 10 }, excerpt: "a screened passage" }, c, NOW, a),
    "study check": (c, a) => renderSynthesisReadiness({ status: "ready", scope: "structural", manifestSha256: A, binding: "current", claimCoverage: "complete", deliverable: "ok", bibliography: "ok", citations: { state: "ok", cited: 2, missing: 0 }, claims: [{ claimId: "c1", claim: "text" }], next: ["record_evidence"] }, c, NOW, a),
    "handoff receipt": (c, a) => renderHandoffReceipt({ project: "other-project", task: 4, state: "proposed" }, c, NOW, a),
    "handoff list": (c, a) => renderHandoffs({ handoffs: [{ remoteProject: "other", remoteTask: 4, state: "proposed", reach: "unreachable", cause: "hub not running", age: "2h", originPeer: "jcode", title: "a title" }], syncing: true, pending: 1 }, c, NOW, a),
    "learn list": (c, a) => renderLearnList([{ id: 3, status: "open", profile: "dev", class: "implement", criterion: "AC1", tasks: [1, 2], line: "check AC1" }], c, false, false, a),
    "learn accept": (c, a) => renderLearnChange("accept", { card: { id: 3 }, accepted: { profile: "dev", class: "implement", criterion: "AC1", line: "check AC1", file: ".agenthub/config.local.json", lines: 3, applies: "after a restart", undo: "ahub settings undo" } }, c, NOW, a),
    "intake draft": (c, a) => renderIntake({ draft: { id: 7, title: "Intake: prepare" }, split: "hub", children: [{ id: 8, class: "plan", deps: [], title: "Part one" }, { id: 9, class: "implement", deps: [8], title: "Part two" }] }, c, NOW, a),
    "intake approve": (c, a) => renderIntakeChange("approve", [{ id: 7, state: "backlog", title: "t" }], c, NOW, a),
    "capabilities": (c, a) => renderCapabilities({ peers: [{ peer: "claude", permission_mode: "default", entries: [{ id: "skill:a", state: "digest-changed", class: "destructive", source: "skill", invoke: "slash", digest: "abc" }] }] }, c, NOW, a),
    "worktrees": (c, a) => renderWorktrees({ live: [{ path: "/w/a", branch: "feat/a", task: 7, pr: 9, lastActiveAt: NOW - 1000 }], settled: [{ path: "/w/b", branch: "feat/b", reason: "merged", lastActiveAt: NOW - 5000 }], complete: false }, c, NOW, a),
    "worktrees tidy": (c, a) => renderTidyPreview({ entries: [{ shown: "/w/b", branch: "feat/b", reason: "merged" }], removable: [{ shown: "/w/b", branch: "feat/b", reason: "merged" }], fingerprint: "abc123" }, c, NOW, a),
    "worktrees tidy confirm": (c, a) => renderTidyResult([{ shown: "/w/b", branch: "feat/b", worktreeRemoved: true, branchDeleted: false, note: "branch kept" }], c, NOW, a),
    "room list": (c, a) => renderRooms([{ name: "lab", room: "ccccccccccccccccccccccccccccccccccccccccccc", owner: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", member: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", epoch: "2", state: "offline", linkCause: "transport_closed", linkNextStep: "Check the broker address and network connection.", health: { refused: { wrong_epoch: 2 }, outboxDepth: 3, oldestOutboxAgeMs: 50, lastReceiptAgeMs: null }, remotePeers: [{ id: "codex@guest", state: "idle" }, { id: "kimi@guest", state: "offline", liveness: "untracked" }], deliveries: [{ direction: "outbound", id: "12345678-1234-4234-8234-123456789abc", application: "12345678-1234-4234-8234-123456789abc", peer: "codex@guest", state: "needs_review", holdReason: "epoch rotated" }, { direction: "inbound", pending: 1, needsReview: 1, truncated: true }] }], false, c, a),
    "room status": (c, a) => renderRooms([{ name: "lab", room: "ccccccccccccccccccccccccccccccccccccccccccc", owner: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", member: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", epoch: "2", state: "offline", linkCause: "transport_closed", linkNextStep: "Check the broker address and network connection.", health: { refused: { wrong_epoch: 2 }, outboxDepth: 3, oldestOutboxAgeMs: 50, lastReceiptAgeMs: null }, remotePeers: [{ id: "codex@guest", state: "idle" }, { id: "kimi@guest", state: "offline", liveness: "untracked" }], deliveries: [{ direction: "outbound", id: "12345678-1234-4234-8234-123456789abc", application: "12345678-1234-4234-8234-123456789abc", peer: "codex@guest", state: "needs_review", holdReason: "epoch rotated" }, { direction: "inbound", pending: 1, needsReview: 1, truncated: true }] }], true, c, a),
    "room inbox": (c, a) => renderRoomInbox([{ id: "12345678-1234-4234-8234-123456789abc", name: "lab", from: "codex@guest", state: "unread", receivedAt: NOW - 60000, expiresAt: NOW + 86400000, bytes: 42, sender: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }], NOW, c, a),
    "room inbox result": (c, a) => renderRoomInboxResult({ id: "12345678-1234-4234-8234-123456789abc", state: "done" }, false, c, a),
    "room preview": (c, a) => renderRoomPreview("invite", { owner: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", member: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", outstanding: ["12345678-1234-4234-8234-123456789abc"] }, c, a),
    "room result": (c, a) => renderRoomResult("join", { name: "lab", artifact: true }, c, a),
  };
  const text = (lines: ReturnType<typeof renderSdlcMerge>) => lines.map(line => line.map(span => span.text).join(""));
  for (const [name, render] of Object.entries(views)) {
    test(`${name}: header first, a section mark per group with one blank line before it, no trailing blank, no line over 24, 40 or 80 cells`, () => {
      for (const columns of [24, 40, 80, undefined]) {
        const lines = text(render(columns, false));
        expect(lines[0], `${name} at ${columns}`).toMatch(/^ ahub /);
        expect(lines.at(-1), `${name} at ${columns}: trailing blank`).not.toBe("");
        for (const [i, line] of lines.entries()) {
          if (line.startsWith("▸ ") && i > 1) expect(lines[i - 1], `${name} at ${columns}: blank before ${line}`).toBe("");
          if (columns !== undefined) expect(Bun.stringWidth(line), `${name} at ${columns}: ${line}`).toBeLessThanOrEqual(columns);
        }
        for (let i = 1; i < lines.length; i++) expect(!(lines[i] === "" && lines[i - 1] === ""), `${name} at ${columns}: two blank lines`).toBe(true);
        // a section mark is followed by a row of its own, never by the next section or the end
        for (const [i, line] of lines.entries()) if (line.startsWith("▸ ")) expect(lines[i + 1] ?? "", `${name} at ${columns}: empty section ${line}`).not.toBe("");
      }
    });
    test(`${name}: --ascii swaps every glyph and keeps the same line count`, () => {
      const unicode = text(render(80, false)), ascii = text(render(80, true));
      expect(ascii.length).toBe(unicode.length);
      expect(ascii.join("\n")).not.toMatch(/[\u2713\u2717\u26a0\u25b8\u2192]/);
      expect(unicode.some(line => line.startsWith("▸ ")) || name === "report" || name === "status --verbose").toBe(true);
    });
  }
});

// #1654 AC3: the header-fit rule is one Report behavior, not three copies.
describe("Report.titled: the header fits, else the context moves to a note (#1654 AC3)", () => {
  const rows = (report: InstanceType<typeof Report>) => report.lines().map(line => line.map(span => span.text).join(""));
  test("a context that fits stays on the header line after two spaces; inline joins it by one space", () => {
    expect(rows(new Report(80).titled("ahub", "Status", "v1  pid 2"))).toEqual([" ahub Status  v1  pid 2"]);
    expect(rows(new Report(80).titled("ahub", "Merge queue", "owner/repo", true))).toEqual([" ahub Merge queue owner/repo"]);
    expect(rows(new Report(undefined).titled("ahub", "Merge queue", "owner/" + "x".repeat(200), true))).toHaveLength(1);
  });
  test("a context that does not fit moves to one wrapped note under a short header; nothing passes the width", () => {
    const narrow = rows(new Report(24).titled("ahub", "Status", "127.0.0.1:12345  pid 4242"));
    expect(narrow[0]).toBe(" ahub Status");
    expect(narrow.slice(1).join(" ")).toContain("127.0.0.1:12345");
    const long = rows(new Report(24).titled("ahub", "Guarded merge of task", "#7", true));
    for (const line of long) expect(cellWidth(line)).toBeLessThanOrEqual(24);
    expect(long.join(" ").replace(/\s+/g, " ")).toContain("Guarded merge of task #7");
  });
  test("an empty context is no context", () => {
    expect(rows(new Report(80).titled("ahub", "Status", ""))).toEqual([" ahub Status"]);
  });
});

// #1654 T4 / AC4: a `console.log` or `console.error` in src/cli that bypasses Report, printOutput, errorLines or warningLines fails here unless
// `scripts/cli-raw-output.baseline.json` lists it. The baseline can only shrink: a new call is refused, and an entry whose call is gone or reduced must be removed.
const OUTPUT_PATHS = /JSON\.stringify|errorLines\(|warningLines\(|printOutput|\brender[A-Z]\w*\(|\.render\(|\bwarn\(|\bwarnLine\(/;
const RAW_CALL = /console\.(log|error)\(/;
interface RawBaseline { file: string; text: string; count: number; reason: string }
function rawCalls(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of sources("src/cli")) {
    if (file === "src/cli/warn-line.ts") continue; // the warning printer itself: its one console.error is the sanctioned path
    for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
      if (!RAW_CALL.test(line) || OUTPUT_PATHS.test(line)) continue;
      const key = `${file}\u0000${line.trim()}`;
      found.set(key, (found.get(key) ?? 0) + 1);
    }
  }
  return found;
}
describe("CLI output standard v1: raw console output is a shrink-only baseline (#1654 AC4)", () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, "scripts/cli-raw-output.baseline.json"), "utf8")) as RawBaseline[];
  const allowed = new Map(baseline.map(entry => [`${entry.file}\u0000${entry.text}`, entry.count]));
  test("the detector skips the sanctioned paths and sees a bare call", () => {
    expect(RAW_CALL.test("console.log(`x`)")).toBe(true);
    for (const line of ["console.error(errorLines(a, b, c, d).join())", "console.error(warningLines(a))", "console.log(JSON.stringify(x))", "printOutput(x)", "warn(`x`)"]) {
      expect(RAW_CALL.test(line) && !OUTPUT_PATHS.test(line)).toBe(false);
    }
  });
  test("main.ts warn() only forwards to warnLine(), and error-format re-exports the one formatter", () => {
    expect(readFileSync(join(ROOT, "src/cli/main.ts"), "utf8")).toContain("function warn(message: string, next?: string): void { warnLine(message, next); }");
    expect(readFileSync(join(ROOT, "src/cli/error-format.ts"), "utf8")).toContain('export { warningLines } from "./warn-line.ts";');
  });
  test("a warning is `ahub: warning: <what>: <why>` with an optional next step, a marker only on a terminal", () => {
    expect(warningLines("never-ask: nothing asks", undefined, false, false)).toEqual(["ahub: warning: never-ask: nothing asks"]);
    expect(warningLines("w", "ahub x --y", true, true)).toEqual(["! ahub: warning: w", "  -> ahub x --y"]);
  });
  test("every call outside the sanctioned paths is in the baseline", () => {
    const added = [...rawCalls()].filter(([key, count]) => count > (allowed.get(key) ?? 0)).map(([key]) => key.replace("\u0000", ": "));
    expect(added).toEqual([]);
  });
  test("the baseline holds no entry whose call is gone or reduced, so it only shrinks", () => {
    const found = rawCalls();
    const stale = baseline.filter(entry => (found.get(`${entry.file}\u0000${entry.text}`) ?? 0) < entry.count).map(entry => `${entry.file}: ${entry.text}`);
    expect(stale).toEqual([]);
  });
  test("every entry names its reason from #1654", () => {
    for (const entry of baseline) expect(entry.reason).toContain("#1654");
  });
});
