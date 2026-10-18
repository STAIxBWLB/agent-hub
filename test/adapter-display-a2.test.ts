import { afterEach, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { CLAUDE_DISPLAY, CODEX_DISPLAY, KIMI_DISPLAY, PI_DISPLAY, LOCAL_DISPLAY, QWEN_DISPLAY, JCODE_DISPLAY } from "../src/adapters/definitions/native-display.ts";
import { definitionOf, OFFICE_PEER_ORDER } from "../src/adapters/registry.ts";
import type { AdapterDefinition } from "../src/adapters/registry-types.ts";
import { startDashboard } from "../src/hub/ui.ts";
import { officeModel } from "../src/ui/office-model.ts";
import { PEER_PALETTE, peerPaletteCss, peerStyle } from "../src/ui/peer-palette.ts";

const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
const expected = {
  claude: { tone: "peerClaude", ansi: "\x1b[94m", css: "#6495ed" },
  codex: { tone: "peerCodex", ansi: "\x1b[96m", css: "#22b8cf" },
  kimi: { tone: "taskKeyword", ansi: "\x1b[35m", css: "#bc73ca" },
  pi: { tone: "attention", ansi: "\x1b[33m", css: "#c79936" },
  local: { tone: "success", ansi: "\x1b[32m", css: "#4caa77" },
  hub: { tone: "info", ansi: "\x1b[36m", css: "#489da8" },
  other: { tone: "muted", ansi: "\x1b[90m", css: "#8a8f99" },
};

test("#451 A2 definition display data preserves every existing palette byte and public key order", () => {
  expect(OFFICE_PEER_ORDER).toEqual(["claude", "codex", "kimi", "pi", "local"]);
  expect(Object.keys(PEER_PALETTE)).toEqual(Object.keys(expected));
  expect(JSON.stringify(PEER_PALETTE)).toBe(JSON.stringify(expected));
  expect(peerPaletteCss()).toBe(".peer-claude{--peer-color:#6495ed}.peer-codex{--peer-color:#22b8cf}.peer-kimi{--peer-color:#bc73ca}.peer-pi{--peer-color:#c79936}.peer-local{--peer-color:#4caa77}.peer-hub{--peer-color:#489da8}.peer-other{--peer-color:#8a8f99}");
  for (const [kind, display] of Object.entries({ claude: CLAUDE_DISPLAY, codex: CODEX_DISPLAY, kimi: KIMI_DISPLAY, pi: PI_DISPLAY, local: LOCAL_DISPLAY, qwen: QWEN_DISPLAY, jcode: JCODE_DISPLAY })) {
    const style = kind in expected ? expected[kind as keyof typeof expected] : expected.other;
    const subject: AdapterDefinition["display"] = display;
    expect(subject).toEqual({ palette: { fg: style.css, bg: "transparent", tone: style.tone, ansi: style.ansi } });
    expect(definitionOf(kind)?.display).toBe(display);
  }
});

test("#451 A2 unknown and prototype-like peer ids keep the existing other fallback", () => {
  for (const key of ["qwen", "jcode", "constructor", "__proto__", "toString", "custom", "codex-second"]) expect(peerStyle(key)).toBe(PEER_PALETTE.other);
  for (const key of Object.keys(expected)) expect(peerStyle(key)).toBe(PEER_PALETTE[key as keyof typeof PEER_PALETTE]);
});

test("#451 A2 served office model captures registry order without browser globals or model changes", async () => {
  const ui = startDashboard({ snapshot: () => ({}), action: () => ({}) }); stops.push(ui.stop);
  const page = await (await fetch(ui.origin)).text();
  const expression = page.match(/const officeModel = ([\s\S]*?);\nconst officeView/)?.[1];
  expect(expression).toBeDefined();
  const browserModel = runInNewContext(`(${expression})`);
  const snapshot = { status: { peers: { zeta: { state: "idle" }, local: { state: "idle" }, qwen: { state: "busy" }, pi: { state: "paused" }, claude: { state: "idle" }, jcode: { state: "idle" }, codex: { state: "busy" }, kimi: { state: "offline" } } }, tasks: [{ id: 7, title: "public title", state: "in_progress", class: "implement", owner: "codex", detail: "PRIVATE-DETAIL" }], events: [{ event: { t: "message", env: { body: "PRIVATE-BODY" } } }] };
  const options = { cols: 2, now: 1000 }, current = officeModel(snapshot, null, options);
  expect(current.desks.map(row => row.id)).toEqual(["claude", "codex", "kimi", "pi", "local", "jcode", "qwen", "zeta"]);
  expect(JSON.parse(JSON.stringify(browserModel(snapshot, null, options)))).toEqual(JSON.parse(JSON.stringify(current)));
  expect(JSON.stringify(current)).not.toContain("PRIVATE-DETAIL");
  expect(JSON.stringify(current)).not.toContain("PRIVATE-BODY");
  const next = { ...snapshot, status: { peers: { local: { state: "idle" } } } };
  expect(JSON.parse(JSON.stringify(browserModel(next, current, options)))).toEqual(JSON.parse(JSON.stringify(officeModel(next, current, options))));
});
