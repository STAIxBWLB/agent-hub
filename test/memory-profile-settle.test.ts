import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskKey } from "@staix/agent-mem";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { openProfileMemory } from "../src/hub/memory-profile.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";

function authoredRows(dir: string): Record<string, string> {
  return Object.fromEntries(["log", "local"].flatMap(folder => {
    const path = join(dir, folder);
    return existsSync(path) ? readdirSync(path).filter(name => name.endsWith(".jsonl")).map(name => [`${folder}/${name}`, readFileSync(join(path, name), "utf8")]) : [];
  }));
}

for (const approval of ["review", "done without reviewer"] as const) {
  test(`${approval} approval preserves the board outcome but fences stale-profile settlement and promotion`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ahub-profile-settle-"));
    const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
    const opened = openProfileMemory({ home: join(dir, "home"), screen: () => "promote" });
    try {
      const project = "synthetic/profile-settle", notices: string[] = [];
      const task = board.propose(USER, { title: "synthetic work ready for approval", class: "implement" });
      board.update(task.id, "codex", "accepted", { owner: "codex", reviewer: approval === "review" ? "claude" : null, state: "in_progress" });
      if (approval === "review") board.update(task.id, "codex", "done", { state: "in_review" }, "synthetic work complete");
      const key = taskKey(project, task);
      const note = opened.store.note({ op: "note", project, scope: "project", tier: "short", kind: "decision", peer: "codex", source: "hub",
        task: key, text: "synthetic decision remains short while unsettled", about: [`task:${key}`] });
      expect(opened.store.get(note, project)?.tier).toBe("short");
      expect(opened.store.settled(key)).toBe(false);
      const before = authoredRows(opened.store.dir);
      let settles = 0, checks = 0;
      const settle = opened.store.settle.bind(opened.store);
      opened.store.settle = (...args) => { settles++; return settle(...args); };
      const tasks = new Tasks({ board, bus, cwd: dir, project, routing: () => loadRouting(dir), notify: line => notices.push(line),
        memoryCheck: () => { checks++; opened.binding.assertCurrent(); }, store: { store: opened.store, project, repo: "synthetic/profile-settle" } });
      writeFileSync(join(opened.store.dir, "profile.json"), JSON.stringify({ schema: "agent-mem.profile/v1", kind: "generation", generation: "f".repeat(32) }));
      const result = approval === "review" ? await tasks.review("claude", task.id, "approved", "synthetic accepted work")
        : await tasks.done("codex", task.id, "synthetic accepted work");
      expect(result.state).toBe("approved"); expect(board.get(task.id)?.state).toBe("approved");
      expect(checks).toBeGreaterThan(0); expect(settles).toBe(0);
      expect(authoredRows(opened.store.dir)).toEqual(before);
      expect(opened.store.settled(key)).toBe(false);
      expect(opened.store.get(note, project)?.tier).toBe("short");
      expect(notices.some(line => line.includes("hub memory could not settle its notes"))).toBe(true);
    } finally {
      opened.store.close(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
}
