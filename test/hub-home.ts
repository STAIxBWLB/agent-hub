import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preloaded by bunfig.toml for every test run: a hub home of the run's own unless the caller set one (the gate's temp
// root, a test's own). Daemons started from a project config open hub memory (#258) and the registry there, never in
// the person's ~/.agenthub. ponytail: the directory stays in TMPDIR after an ad-hoc run; the gate's TMPDIR is removed.
// AMEM_HOME otherwise overrides this isolated hub home; scoped tests may set their own after preload.
delete process.env.AMEM_HOME;
if (!process.env.AGENTHUB_HOME?.trim()) process.env.AGENTHUB_HOME = mkdtempSync(join(tmpdir(), "ahub-test-home-"));
// Kimi's data home (#285 phase 2): the daemon reads `<home>/session_index.jsonl` at every Kimi turn end, so no test may reach the person's ~/.kimi-code.
// Always replaced, an inherited value included (an agent shell exports the real one); a test that needs its own sets and restores it after preload.
process.env.KIMI_CODE_HOME = mkdtempSync(join(tmpdir(), "ahub-test-kimi-home-"));
