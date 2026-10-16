import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMemoryBoundary, MEMORY_CORE } from "../scripts/check-memory-boundary.ts";

test("memory core boundary rejects reverse, package, type-only and dynamic imports (#412)", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-boundary-"));
  try {
    const dir = join(root, "src/memory"); mkdirSync(dir, { recursive: true });
    for (const file of MEMORY_CORE) writeFileSync(join(dir, file), "");
    const file = join(dir, "store.ts");
    writeFileSync(file, 'import { readFileSync } from "node:fs"; import { Database } from "bun:sqlite"; export type { View } from "./project.ts";');
    expect(checkMemoryBoundary(root)).toEqual([]);
    for (const source of [
      'import type { Task } from "../hub/board.ts";',
      'export { isDenied } from "../local/deny.ts";',
      'type Owner = import("../pi/process-signature.ts").Owner;',
      'const x = import("../cli/memory.ts");',
      'const x = require("../hub/git.ts");',
      'import ts from "typescript";',
      'import { recallFor } from "./recall.ts";',
      'const x = import(name);',
    ]) {
      writeFileSync(file, source);
      expect(checkMemoryBoundary(root).length).toBe(1);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
