import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preloaded by bunfig.toml for every test run: a hub home of the run's own unless the caller set one (the gate's temp
// root, a test's own). Daemons started from a project config open hub memory (#258) and the registry there, never in
// the person's ~/.agenthub. ponytail: the directory stays in TMPDIR after an ad-hoc run; the gate's TMPDIR is removed.
if (!process.env.AGENTHUB_HOME?.trim()) process.env.AGENTHUB_HOME = mkdtempSync(join(tmpdir(), "ahub-test-home-"));
