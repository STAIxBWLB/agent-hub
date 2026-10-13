import { expect, test } from "bun:test";
import { CHARACTERS, CHARACTER_IDS, petFrame, petSize, petGlyphs, type CharacterId, type PetSize } from "../src/pet/frame.ts";
import { characterAttentionLine } from "../src/cli/attention.ts";
import { needs } from "../src/ui/needs.ts";
import { initialConsoleState, reduceConsole, renderConsoleLines, paint, consoleFooterRows } from "../src/cli/console-state.ts";

test("all five approved characters have bounded complete literal frames and only approval blink changes with time", () => {
  expect(CHARACTER_IDS).toEqual(["stai","gyul","lantern","cursor-cat","boxbot"]);
  for (const character of CHARACTER_IDS) for (const [glyphs, poses] of Object.entries(CHARACTERS[character].frames)) for (const [pose, sizes] of Object.entries(poses)) for (const [size, rows] of Object.entries(sizes)) {
    const width = size === "line" ? 5 : size === "mini" ? 9 : 12, height = size === "line" ? 1 : size === "mini" ? 3 : 8;
    expect(rows.length).toBeLessThanOrEqual(height);
    for (const row of rows) { expect(Bun.stringWidth(row)).toBe(width); expect(row).toMatch(glyphs === "ascii" ? /^[ -~]*$/ : /^[ -~▀▄█▟▙]*$/); }
    expect(pose).toMatch(/^(waiting|waitingBlink|blocked|review|working|idle|sleeping)$/);
  }
  for (const character of CHARACTER_IDS) {
    const approval = needs({approvals:[{id:"request",expiresAt:3000}]},0);
    expect(characterAttentionLine(approval,character,0,true)).not.toBe(characterAttentionLine(approval,character,1000,true));
    for (const input of [{defaults:[{peer:"codex"}]},{storageBlocked:true},{peers:{codex:{state:"busy"}}},{}]) {
      const value=needs(input,0);expect(characterAttentionLine(value,character,0,true)).toBe(characterAttentionLine(value,character,1000,true));
    }
  }
});

test("glyph and size floors preserve printable fallback and fixed footer geometry", () => {
  for (const TERM of ["dumb","linux",undefined]) expect(petGlyphs("blocks",{LANG:"en_US.UTF-8",TERM})).toBe("ascii");
  expect(petGlyphs("blocks",{LANG:"C",TERM:"xterm"})).toBe("ascii");
  expect(petGlyphs("auto",{LANG:"en_US.UTF-8",TERM:"xterm"})).toBe("blocks");
  expect(petGlyphs("ascii",{LANG:"en_US.UTF-8",TERM:"xterm"})).toBe("ascii");
  expect(petSize("full",99,40)).toBe("line");expect(petSize("full",100,24)).toBe("mini");expect(petSize("full",100,40)).toBe("full");
  for (const character of CHARACTER_IDS) for (const size of ["line","mini","full"] as PetSize[]) for (const columns of [80,99,100,120]) for (const rows of [24,40]) {
    const base={...initialConsoleState(true),petEnabled:true,petCharacter:character,petSize:size,petGlyphs:"ascii" as const};
    const off=renderConsoleLines({...base,petEnabled:false},columns,rows,0),on=renderConsoleLines(base,columns,rows,0);
    expect(on.length).toBe(rows);expect(on.at(-1)?.map(s=>s.text).join("")).toBe(off.at(-1)?.map(s=>s.text).join(""));
    for(const line of on)expect(Bun.stringWidth(paint(line,false))).toBeLessThanOrEqual(columns);
    const editing={...base,editing:true,input:"a".repeat(columns-2)};
    expect(renderConsoleLines(editing,columns,rows,0).at(-1)?.map(s=>s.text).join("")).toBe(renderConsoleLines({...editing,petEnabled:false},columns,rows,0).at(-1)?.map(s=>s.text).join(""));
    const footer=consoleFooterRows(base,columns,rows);
    for(const state of [{peers:{codex:{state:"busy"}}},{storageBlocked:true},{approvals:[{id:"r",peer:"codex",title:"PRIVATE_TITLE",expiresAt:3000,options:[]}]}]) expect(consoleFooterRows({...base,...state},columns,rows)).toBe(footer);
  }
});

test("advertised character choices cycle all four alternatives and off without workflow effects", () => {
  let state={...initialConsoleState(),petEnabled:true,petChoices:CHARACTER_IDS,petCharacter:"stai" as CharacterId};
  for (const expected of ["gyul","lantern","cursor-cat","boxbot",undefined,"stai"]) {
    const next=reduceConsole(state,"P",0);expect(next.effects).toEqual([]);expect(next.state.petEnabled?next.state.petCharacter:undefined).toBe(expected);state=next.state as typeof state;
  }
  const typing={...state,editing:true,input:"P"};expect(reduceConsole(typing,"P",0).state.petCharacter).toBe(typing.petCharacter);
});

test("expanded pet rows never carry notice or default-source prose", () => {
  for(const size of ["mini","full"] as PetSize[]) {
    const state={...initialConsoleState(true),petEnabled:true,petSize:size,notice:"PRIVATE_NOTICE",noticeAt:0,confirm:{type:"permission_default" as const,peer:"codex",source:"PRIVATE_SOURCE"}};
    const lines=renderConsoleLines(state,120,40,0).slice(-consoleFooterRows(state,120,40));
    expect(lines.map(line=>paint(line,false)).join("\n")).not.toContain("PRIVATE_");
  }
});
