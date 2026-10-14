/** Self-contained glyph pixels for the shared literal frame data; browser injection needs no font/image decoder. */
export function petPixels(frame: readonly string[]): { width: number; height: number; pixels: [number, number][]; underlay: [number, number, number, number][]; detail: [number, number][] } {
  const font: Record<string, string[]> = {
    O:["01110","10001","10001","10001","10001","10001","01110"],
    o:["00000","00000","01110","10001","10001","01110","00000"],
    X:["10001","10001","01010","00100","01010","10001","10001"],
    S:["01111","10000","10000","01110","00001","00001","11110"],
    T:["11111","00100","00100","00100","00100","00100","00100"],
    A:["01110","10001","10001","11111","10001","10001","10001"],
    I:["11111","00100","00100","00100","00100","00100","11111"],
    ">": ["10000","01000","00100","00010","00100","01000","10000"],
    "<": ["00001","00010","00100","01000","00100","00010","00001"],
    "^": ["00100","01010","10001"],
    "~": ["00000","01001","10110"],
    "/": ["00001","00001","00010","00100","01000","10000","10000"],
    "\\": ["10000","10000","01000","00100","00010","00001","00001"],
    "-": ["00000","00000","00000","11111"],
    "'": ["00100","00100"],
    // Double-width, double-height STAI letters for the blocks full frame: each letter spans 2x2 cells
    // (10x16 px). Tops u,v,w,x,y,z,9,0 and bottoms j,k,l,m,n,p,q,r, in S,T,A,I order.
    u:["00111","00111","11000","11000","11000","11000","00111","00111"],
    v:["11111","11111","00000","00000","00000","00000","11100","11100"],
    w:["11111","11111","00001","00001","00001","00001","00001","00001"],
    x:["11111","11111","10000","10000","10000","10000","10000","10000"],
    y:["00111","00111","11000","11000","11000","11000","11111","11111"],
    z:["11100","11100","00011","00011","00011","00011","11111","11111"],
    "9":["11111","11111","00001","00001","00001","00001","00001","00001"],
    "0":["11111","11111","10000","10000","10000","10000","10000","10000"],
    j:["00111","00111","00000","00000","00000","00000","11111","11111"],
    k:["11100","11100","00011","00011","00011","00011","11100","11100"],
    l:["00001","00001","00001","00001","00001","00001","00001","00001"],
    m:["10000","10000","10000","10000","10000","10000","10000","10000"],
    n:["11111","11111","11000","11000","11000","11000","11000","11000"],
    p:["11111","11111","00011","00011","00011","00011","00011","00011"],
    q:["00001","00001","00001","00001","00001","00001","11111","11111"],
    r:["10000","10000","10000","10000","10000","10000","11111","11111"],
  };
  const pixels: [number, number][] = [];
  // underlay: solid cell rects behind letter/detail glyphs; detail: the glyph strokes, drawn in a contrast color by layer-aware renderers.
  const underlay: [number, number, number, number][] = [];
  const detail: [number, number][] = [];
  for (const [row, text] of frame.entries()) for (const [column, glyph] of [...text].entries()) {
    // Arm strokes (the slash glyphs) stay body-colored; other font glyphs are light details on a solid cell.
    const letter = font[glyph], isDetail = letter && glyph !== "/" && glyph !== "\\";
    if (isDetail) underlay.push([column*5, row*8, 5, 8]);
    for (let y=0;y<8;y++) for (let x=0;x<5;x++) {
      const stroke = letter?.[y]?.[x] === "1";
      const on = stroke || glyph === "█" || glyph === "▀" && y<4 || glyph === "▄" && y>=4 || glyph === "▟" && (y>=4 || x>=2) || glyph === "▙" && (y>=4 || x<3);
      if (on) pixels.push([column*5+x,row*8+y]);
      if (stroke && isDetail) detail.push([column*5+x,row*8+y]);
    }
  }
  return { width: Math.max(0,...frame.map(row=>[...row].length))*5, height: frame.length*8, pixels, underlay, detail };
}
