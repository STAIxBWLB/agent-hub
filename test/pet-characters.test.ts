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
  for (const expected of ["gyul","lantern","cursor-cat","boxbot",undefined,"stai"] as const) {
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

test("expired notices restore selected approval ids and expiry in expanded pet footers",()=>{
 for(const size of ["mini","full"] as PetSize[]){
  const state={...initialConsoleState(true),petEnabled:true,petSize:size,notice:"PRIVATE_EXPIRED_NOTICE",noticeAt:0,approvalId:"approval-123",approvals:[{id:"approval-123",peer:"codex",title:"PRIVATE_APPROVAL_TITLE",expiresAt:60000,options:[]}]};
  const footer=renderConsoleLines(state,120,40,10001).slice(-consoleFooterRows(state,120,40)).map(line=>paint(line,false)).join("\n");
  expect(footer).toContain("codex approval-123");expect(footer).toContain("left");expect(footer).not.toContain("PRIVATE_");
 }
});

test("console line faces honor selected block glyphs and the locale ASCII floor",()=>{
 for(const character of CHARACTER_IDS)for(const glyphs of ["ascii","blocks"] as const){
  const state={...initialConsoleState(true),petEnabled:true,petCharacter:character,petSize:"line" as const,petGlyphs:glyphs};
  const rule=paint(renderConsoleLines(state,100,24,0)[20]!,false);expect(rule).toContain(petFrame(character,"sleeping","line",glyphs)[0]!);expect(Bun.stringWidth(rule)).toBe(100);expect(rule).not.toContain("\x1b");
 }
 const floor=petGlyphs("blocks",{LANG:"C",TERM:"xterm"});expect(floor).toBe("ascii");expect(characterAttentionLine(needs({},0),"stai",0,false,true,floor)).toContain(petFrame("stai","sleeping","line","ascii")[0]!);
});

test("console line glyph mode selects distinct trusted catalog output without moving the prompt",()=>{
 const prior=CHARACTERS.stai.frames.blocks.sleeping.line;
 const state={...initialConsoleState(true),petEnabled:true,petCharacter:"stai" as const,petSize:"line" as const,petGlyphs:"blocks" as const};
 const before=renderConsoleLines(state,100,24,0);
 try{
  CHARACTERS.stai.frames.blocks.sleeping.line=["B B B"];
  const after=renderConsoleLines(state,100,24,0);expect(paint(after[20]!,false)).toContain("B B B");expect(after.at(-1)).toEqual(before.at(-1));
 }finally{CHARACTERS.stai.frames.blocks.sleeping.line=prior}
});

test("expanded pets keep active notices in panel body and away from character footer",()=>{
 for(const size of ["mini","full"] as PetSize[]){const state={...initialConsoleState(true),petEnabled:true,petSize:size,notice:"READABLE_NOTICE_MARKER",noticeAt:0};const lines=renderConsoleLines(state,120,40,0),footer=consoleFooterRows(state,120,40);
  expect(lines.slice(0,-footer).map(line=>paint(line,false)).join("\n")).toContain("Notice: READABLE_NOTICE_MARKER");expect(lines.slice(-footer).map(line=>paint(line,false)).join("\n")).not.toContain("READABLE_NOTICE_MARKER");expect(lines).toHaveLength(40);
  expect(renderConsoleLines(state,120,40,10001).map(line=>paint(line,false)).join("\n")).not.toContain("READABLE_NOTICE_MARKER");
 }
});

test("expanded panel notices reserve wrapped rows before placing the selected peer",()=>{
 for(const size of ["mini","full"] as PetSize[]){
  const peers=Object.fromEntries(Array.from({length:28},(_,i)=>[`peer${String(i).padStart(2,"0")}`,{state:"idle"}]));
  const state={...initialConsoleState(true),peers,selection:27,petEnabled:true,petSize:size,notice:"WRAPPED_NOTICE_MARKER ".repeat(10),noticeAt:0};
  const lines=renderConsoleLines(state,120,40,0),body=lines.slice(2,-consoleFooterRows(state,120,40)).map(line=>paint(line,false));
  expect(lines).toHaveLength(40);expect(body.some(line=>line.startsWith("Notice: WRAPPED_NOTICE_MARKER"))).toBe(true);
  expect(body.some(line=>line.startsWith("> peer27"))).toBe(true);
  expect(reduceConsole(state,"p",0).state).toMatchObject({input:"pause peer27",editing:true});
  expect(reduceConsole(state,"p",0).effects).toEqual([]);
 }
});
