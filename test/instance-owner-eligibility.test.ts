import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assign, parseRouting } from "../src/hub/routing.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";

const instances = { "codex-review": { kind: "codex", roles: ["reviewer"] } };
const routing = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.bulk_edit]\npeers=["codex"]\n[classes.test]\npeers=["codex"]\n[classes.review]\npeers=["codex"]\n');
type Options = NonNullable<Parameters<typeof assign>[3]> & { ownerIsolation?: Readonly<Record<string, boolean>> };
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("I2 reviewer-only declared extras remain reviewers but never beat a busy base owner for write work", () => {
  const result = assign({ class: "implement", signals: [] }, { codex: "busy", "codex-review": "idle" }, routing,
    { instances, roles: { "codex-review": ["reviewer"] }, ownerIsolation: { "codex-review": false } } as Options);
  expect(result.owner).toBe("codex"); expect(result.reviewer).toBe("codex-review");
  expect(result.refusals).toContainEqual(expect.objectContaining({ peer: "codex-review", role: "owner", code: "owner-admission" }));
});

test("I2 declared write owners need current implementer role AND positive host isolation proof in every writer class", () => {
  for (const cls of ["implement", "bulk_edit", "test"] as const) {
    const work = { class: cls, signals: [] }, states = { "codex-review": "idle" as const };
    const base: Options = { instances, roles: { "codex-review": ["implementer"] }, candidates: ["codex-review"], namedOwner: "codex-review" };
    expect(assign(work, states, routing, base).owner).toBeUndefined();
    expect(assign(work, states, routing, { ...base, ownerIsolation: { "codex-review": false } } as Options).owner).toBeUndefined();
    expect(assign(work, states, routing, { ...base, ownerIsolation: { "codex-review": true } } as Options).owner).toBe("codex-review");
    expect(assign(work, states, routing, { ...base, roles: { "codex-review": ["reviewer"] }, ownerIsolation: { "codex-review": true } } as Options).owner).toBeUndefined();
  }
});

class Owner extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
test("I2 role-only changes cannot give Tasks a write owner without the host's verified actual root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-owner-isolation-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const board = new Board(join(dir, "hub.db")); cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 }); cleanup.push(() => bus.closeJournal());
  const owner = new Owner("codex-review"); await owner.start(); bus.add(owner); cleanup.push(() => owner.stop());
  const roles = { "codex-review": ["reviewer"] }, proof = { "codex-review": false };
  const deps: TasksDeps & { ownerIsolation: () => Readonly<Record<string, boolean>> } = { board, bus, cwd: dir, project: "fixture", routing: () => routing, instances: () => instances, roles, ownerIsolation: () => proof, notify: () => {} };
  const tasks = new Tasks(deps);
  const first = await tasks.propose(USER, { title: "Unisolated review peer", class: "implement" });
  expect(first.owner).toBeNull();
  roles["codex-review"] = ["implementer"];
  expect(tasks.explain({ title: "Still shared root", class: "implement" })).toContain("owner: none available, task stays proposed (ahub task assign <id> <peer>)");
  const before = board.get(first.id)!.history;
  await expect(tasks.assignTo(first.id, "codex-review", USER, true)).rejects.toThrow(/owner admission|isolation|isolated/);
  expect(board.get(first.id)!.owner).toBeNull(); expect(board.get(first.id)!.history).toEqual(before);
  proof["codex-review"] = true; // Positive evidence comes only from the host; role changes cannot manufacture it.
  expect((await tasks.assignTo(first.id, "codex-review", USER, true)).owner).toBe("codex-review");
});
