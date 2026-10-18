import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fresh interpreter catches registry -> preview -> start-mode initialization cycles hidden by cached modules.
for (const first of ["hub/start-mode", "adapters/registry", "cli/launch", "cli/preview"]) {
  test(`#451 native preview initializes with ${first} imported first`, () => {
    const cwd = mkdtempSync(join(tmpdir(), "ahub-preview-import-order-"));
    try {
      const initial = new URL(`../../src/${first}.ts`, import.meta.url).href;
      const preview = new URL("../../src/cli/preview.ts", import.meta.url).href;
      const code = `await import(${JSON.stringify(initial)}); const p = await import(${JSON.stringify(preview)}); const out = p.launcherPreview("codex", [], process.cwd(), "unused-preview-state", false); if (out.cmd !== "codex" || !out.args.includes("[unresolved]")) throw new Error("native preview unavailable");`;
      const result = spawnSync(process.execPath, ["-e", code], { cwd, encoding: "utf8", timeout: 5000 });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}
