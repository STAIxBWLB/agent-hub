import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { dogfoodScorecard, formatDogfood, source, type DogfoodInput } from "../src/hub/dogfood.ts";
import { dogfoodTasks, dogfoodEvents, dogfoodProjectProfile } from "../src/hub/dogfood-read.ts";

// Captured from unmodified main 170199d6 before the #799 implementation.
test("dev dogfood JSON and readable output retain their pre-profile bytes", () => {
  const fixture = (name: string) => readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
  const report = dogfoodScorecard(JSON.parse(fixture("dogfood-dev-input.json")) as DogfoodInput);
  expect(JSON.stringify(report, null, 2) + "\n").toBe(fixture("dogfood-dev-scorecard.json"));
  expect(formatDogfood(report).join("\n") + "\n").toBe(fixture("dogfood-dev-scorecard.txt"));
});

// Captured from approved #810 head 1d84d219 before the AC5 reader/validator edits.
test("dev dogfood collector path retains JSON and readable golden bytes", () => {
  const fixture = (name: string) => readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
  const metadata = JSON.parse(fixture("dogfood-dev-reader-input.json")) as { legacyInput: string; metadata: { id: number; class: string; state: string; projectProfile: object | null; plan: object }[] };
  const input = JSON.parse(fixture(metadata.legacyInput)) as DogfoodInput;
  const root = mkdtempSync(join(tmpdir(), "ahub-reader-golden-")), file = join(root, "hub.db");
  try {
    const db = new Database(file);
    db.run("CREATE TABLE tasks(id INTEGER,class TEXT,state TEXT,project_profile TEXT,plan TEXT,sdlc TEXT,signals TEXT,history TEXT,title TEXT,detail TEXT)");
    for (const task of input.tasks.data) {
      const m = metadata.metadata.find(row => row.id === task.id)!;
      db.query("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)").run(task.id, m.class, m.state,
        m.projectProfile === null ? null : JSON.stringify(m.projectProfile), JSON.stringify(m.plan), JSON.stringify({ repo: task.repo, pr: task.pr }),
        JSON.stringify(task.pii ? ["pii_path"] : []), JSON.stringify(task.history.map(h => ({ ...h, ...(task.pii ? { note: "PRIVATE_READER_NOTE" } : {}) }))),
        task.pii ? "PRIVATE_READER_TITLE" : "fixture", task.pii ? "PRIVATE_READER_DETAIL" : "");
    }
    db.close();
    const report = dogfoodScorecard({ ...input, tasks: dogfoodTasks(file),
      events: dogfoodEvents(source(input.events.data.map(e => JSON.stringify(e))), input.since, input.until), projectProfile: dogfoodProjectProfile(root) });
    expect(JSON.stringify(report, null, 2) + "\n").toBe(fixture("dogfood-dev-reader-scorecard.json"));
    expect(formatDogfood(report).join("\n") + "\n").toBe(fixture("dogfood-dev-reader-scorecard.txt"));
    expect(JSON.stringify(report)).not.toContain("PRIVATE_READER");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
