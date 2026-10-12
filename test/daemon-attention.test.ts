import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";

test("real daemon attention exposes private review/work ids without task text", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-attention-private-")), stateDir = join(root, "state"); mkdirSync(stateDir);
  const board = new Board(join(stateDir, "hub.db"));
  const review = board.propose("user", { title: "PRIVATE_REVIEW_MARKER", detail: "PRIVATE_DETAIL_MARKER", class: "implement", signals: ["pii_path"] });
  board.update(review.id, "user", "assigned", { owner: "local", reviewer: "user" });
  board.update(review.id, "local", "accepted", { state: "in_progress" });
  board.update(review.id, "local", "done", { state: "in_review" });
  const work = board.propose("user", { title: "PRIVATE_WORK_MARKER", class: "implement", signals: ["pii_path"] });
  board.update(work.id, "user", "assigned", { owner: "local" });
  board.update(work.id, "local", "accepted", { state: "in_progress" }); board.close();
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  const client = await ControlClient.connect(stateDir, { role: "console" });
  try {
    const status = (await client.request({ t: "status" })).status;
    expect(status.needs).toEqual({ act: 1, watch: 1, state: "review", first: { kind: "review", level: "act", id: review.id } });
    expect(status.attentionItems).toEqual([{ kind: "review", level: "act", id: review.id }, { kind: "offline", level: "watch", peer: "local", id: work.id }]);
    expect(JSON.stringify(status)).not.toContain("PRIVATE_");
    const persisted = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    expect(persisted.needs).toEqual(status.needs); expect(persisted.attentionItems).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain("PRIVATE_");
  } finally { client.close(); await daemon.stop(); rmSync(root, { recursive: true }); }
}, 20000);
