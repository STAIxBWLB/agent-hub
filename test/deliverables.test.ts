import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELIVERABLE_LIMITS, deliverableId, parseDeliverableClaims, parseDeliverableRecords, publicDeliverables, latestDeliverables, approvedDeliverables, type DeliverableRecord } from "../src/hub/deliverables.ts";
import { checkDeliverables, deliverableHooks, hashDeliverables, vetDeliverables, DeliverableRefusal, type DeliverablePorts } from "../src/hub/deliverable-files.ts";

// #509a: records are bound to hashes the hub computes itself, in a plain folder, with every path vetted first.
const dirs: string[] = [];
afterEach(() => { delete deliverableHooks.beforeOpen; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function folder(files: Record<string, string> = { "report.md": "# Report\nv1\n" }) {
  const root = mkdtempSync(join(tmpdir(), "ahub-deliverables-")); dirs.push(root);
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); }
  const ports = (extra: Partial<DeliverablePorts> = {}): DeliverablePorts => ({ cwd: root, deny: [], private: () => false, ...extra });
  return { root, ports };
}
const claim = (path: string, format = "md", version?: string) => ({ path, format, ...(version ? { version } : {}) });

test("claims: only path, format and version are accepted, and a claimed hash is refused with the reason", () => {
  expect(parseDeliverableClaims([{ path: "docs/a.md", format: "md", version: "v2" }, { path: "b.pdf", format: "pdf" }])).toEqual([{ path: "docs/a.md", format: "md", version: "v2" }, { path: "b.pdf", format: "pdf" }]);
  for (const field of ["sha256", "hash", "bytes"]) expect(() => parseDeliverableClaims([{ path: "a.md", format: "md", [field]: "0".repeat(64) }])).toThrow("the hub hashes the file itself; a claimed hash is not used");
  expect(() => parseDeliverableClaims([{ path: "a.md", format: "md", id: "d-000000000000" }])).toThrow("unsupported field id");
});

test("claims: malformed shapes are refused whole", () => {
  const bad: unknown[] = ["x", null, {}, [], Array.from({ length: 17 }, (_, i) => claim(`f${i}.md`)), [claim("a.md"), claim("a.md", "pdf")], [{ path: "a.md" }], [{ format: "md" }],
    [claim("/etc/passwd")], [claim("../x.md")], [claim("a/../b.md")], [claim("a//b.md")], [claim("./a.md")], [claim("C:/x.md")], [claim("a\\b.md")], [claim("a\nb.md")], [claim("a\u0000.md")],
    [claim("a.md", "MD")], [claim("a.md", "")], [claim("a.md", "x".repeat(33))], [claim("a.md", "md", "bad version!")], [claim("x".repeat(513))], [{ path: 1, format: "md" }], ["a.md"]];
  for (const value of bad) expect(() => parseDeliverableClaims(value), JSON.stringify(value)?.slice(0, 60)).toThrow();
});

test("ids are stable for a path and format and differ across either", () => {
  expect(deliverableId("a.md", "md")).toBe(deliverableId("a.md", "md"));
  expect(deliverableId("a.md", "md")).not.toBe(deliverableId("a.md", "pdf"));
  expect(deliverableId("a.md", "md")).not.toBe(deliverableId("b.md", "md"));
  expect(deliverableId("a.md", "md")).toMatch(/^d-[0-9a-f]{12}$/);
});

test("the hub hashes the file itself: the record carries the real sha256 and size, in a plain folder with no git", async () => {
  const f = folder({ "out/report.md": "hello\n", "deck.pptx": "binary-ish" });
  const records = await hashDeliverables([claim("out/report.md", "md", "v1"), claim("deck.pptx", "pptx")], f.ports());
  expect(records).toEqual([
    { id: deliverableId("out/report.md", "md"), path: "out/report.md", format: "md", version: "v1", sha256: sha("hello\n"), bytes: 6 },
    { id: deliverableId("deck.pptx", "pptx"), path: "deck.pptx", format: "pptx", sha256: sha("binary-ish"), bytes: 10 },
  ]);
  expect(parseDeliverableRecords(records)).toEqual(records); // the board's read-back accepts exactly what was written
});

test("a large file is hashed across chunks to the same digest", async () => {
  const f = folder({}), big = Buffer.alloc(3 * 1024 * 1024 + 123, "ab");
  writeFileSync(join(f.root, "big.bin"), big);
  const [record] = await hashDeliverables([claim("big.bin", "bin")], f.ports());
  expect(record).toMatchObject({ sha256: sha(big), bytes: big.length });
});

test("paths are vetted before any hashing: outside the project, the denylist, hub state, links out, directories and missing files all refuse", async () => {
  const f = folder({ "ok.md": "x", ".env": "SECRET=1", "notes/secret.txt": "s", ".agenthub/config.json": "{}", "docs/a.md": "a" });
  mkdirSync(join(f.root, ".git")); writeFileSync(join(f.root, ".git/config"), "[core]");
  const outside = mkdtempSync(join(tmpdir(), "ahub-outside-")); dirs.push(outside); writeFileSync(join(outside, "leak.md"), "outside");
  symlinkSync(join(outside, "leak.md"), join(f.root, "link.md")); symlinkSync(outside, join(f.root, "linkdir")); symlinkSync(join(f.root, "missing-target"), join(f.root, "dangling.md"));
  const ports = f.ports({ deny: ["secret"] });
  const refused: [string, RegExp][] = [
    [".env", /denylist/], ["notes/secret.txt", /denylist/], [".agenthub/config.json", /hub's own state/], [".git/config", /hub's own state/],
    ["link.md", /outside the project/], ["linkdir/leak.md", /outside the project/], ["dangling.md", /dangling|outside/], ["docs", /not a regular file/], ["absent.md", /does not exist/],
  ];
  for (const [path, why] of refused) {
    expect(() => vetDeliverables([claim(path)], ports), path).toThrow(DeliverableRefusal);
    await expect(hashDeliverables([claim(path)], ports), path).rejects.toThrow(why);
  }
  await expect(hashDeliverables([claim("ok.md"), claim(".env")], ports)).rejects.toThrow(DeliverableRefusal); // one bad claim refuses the call: no partial record
  // a refusal names the path as given, never a resolved one
  await expect(hashDeliverables([claim("link.md")], ports)).rejects.not.toThrow(outside);
});

test("a hard link is a regular file inside the project and hashes like its twin, under its own id", async () => {
  const f = folder({ "a.md": "same bytes" });
  linkSync(join(f.root, "a.md"), join(f.root, "b.md"));
  const records = await hashDeliverables([claim("a.md"), claim("b.md", "md")], f.ports());
  expect(records[0]!.sha256).toBe(records[1]!.sha256);
  expect(records[0]!.id).not.toBe(records[1]!.id);
});

test("a file over the size limit is refused, never hashed in part", async () => {
  const f = folder({});
  writeFileSync(join(f.root, "huge.bin"), "");
  truncateSync(join(f.root, "huge.bin"), DELIVERABLE_LIMITS.fileBytes + 1); // a sparse file: no disk used
  await expect(hashDeliverables([claim("huge.bin", "bin")], f.ports())).rejects.toThrow(/larger than 256 MiB/);
  const near = folder({});
  for (const name of ["a.bin", "b.bin", "c.bin"]) { writeFileSync(join(near.root, name), ""); truncateSync(join(near.root, name), 200 * 1024 * 1024); }
  await expect(hashDeliverables(["a.bin", "b.bin", "c.bin"].map(p => claim(p, "bin")), near.ports())).rejects.toThrow(/together larger than 512 MiB/);
});

test("a PII path or a PII task makes the record private, and the public view shows no path for it", async () => {
  const f = folder({ "report.md": "r", "patients/2026.csv": "p" });
  const records = await hashDeliverables([claim("report.md"), claim("patients/2026.csv", "csv")], f.ports({ private: path => path.startsWith("patients/") }));
  expect(records.map(r => !!r.private)).toEqual([false, true]);
  expect(records[1]!.path).toBe("patients/2026.csv"); // the board keeps it to find the file again
  const view = publicDeliverables(records, () => true)!;
  expect(view[0]!.path).toBe("report.md");
  expect(view[1]).toEqual({ id: records[1]!.id, format: "csv", sha256: records[1]!.sha256, bytes: 1, private: true }); // id, hash and size only
  expect(JSON.stringify(view[1])).not.toContain("patients");
  const screened = publicDeliverables(records, path => !path.includes("report"))!; // a path matching a PII pattern is withheld too, and marked private
  expect(screened[0]).toMatchObject({ private: true }); expect(screened[0]!.path).toBeUndefined();
  expect(publicDeliverables(undefined, () => true)).toBeUndefined(); expect(publicDeliverables([], () => true)).toBeUndefined();
});

test("checking: unchanged, changed, missing and unreadable are told apart, and unreadable is never unchanged", async () => {
  const f = folder({ "a.md": "one", "b.md": "two", "c.md": "three", "d.md": "four" });
  const records = await hashDeliverables(["a.md", "b.md", "c.md", "d.md"].map(p => claim(p)), f.ports());
  writeFileSync(join(f.root, "b.md"), "two, edited"); rmSync(join(f.root, "c.md"));
  const checks = await checkDeliverables(records, f.ports({ deny: ["d.md"] })); // d.md is on the denylist now: the hub may not vouch for it
  expect(checks.map(c => c.state)).toEqual(["unchanged", "changed", "missing", "unknown"]);
  expect(checks[2]!.why).toContain("does not exist");
  expect(checks[3]!.why).toContain("denylist");
  expect((await checkDeliverables([{ ...records[0]!, path: undefined }], f.ports()))[0]).toMatchObject({ state: "unknown", why: "no path recorded" });
  writeFileSync(join(f.root, "a.md"), "one"); // rewritten with the same bytes: still unchanged, the hash is the identity
  expect((await checkDeliverables([records[0]!], f.ports()))[0]!.state).toBe("unchanged");
});

test("a file replaced by a link to the outside after delivery is unknown, never unchanged", async () => {
  const f = folder({ "a.md": "inside" });
  const [record] = await hashDeliverables([claim("a.md")], f.ports());
  const outside = mkdtempSync(join(tmpdir(), "ahub-outside-")); dirs.push(outside); writeFileSync(join(outside, "x.md"), "inside"); // identical bytes
  rmSync(join(f.root, "a.md")); symlinkSync(join(outside, "x.md"), join(f.root, "a.md"));
  expect((await checkDeliverables([record!], f.ports()))[0]).toMatchObject({ state: "unknown" });
});

test("stored records are re-validated on read: a damaged row is refused, never trusted", () => {
  const good: DeliverableRecord = { id: deliverableId("a.md", "md"), path: "a.md", format: "md", sha256: sha("x"), bytes: 1 };
  expect(parseDeliverableRecords([good])).toEqual([good]);
  for (const bad of [[], "x", [{ ...good, sha256: "ABC" }], [{ ...good, bytes: -1 }], [{ ...good, bytes: 1.5 }], [{ ...good, id: "d-000000000000" }], [{ ...good, path: "../x" }], [{ ...good, format: "MD" }], [{ ...good, private: false }], [{ ...good, extra: 1 }], [good, good]])
    expect(() => parseDeliverableRecords(bad), JSON.stringify(bad)?.slice(0, 50)).toThrow();
});

test("latest and approved records come from the right entries", () => {
  const a: DeliverableRecord = { id: deliverableId("a.md", "md"), path: "a.md", format: "md", sha256: sha("1"), bytes: 1 }, b = { ...a, sha256: sha("2") };
  const history = [{ event: "proposed" }, { event: "done", deliverables: [a] }, { event: "lifecycle", deliverables: [b] }, { event: "approved", deliverables: [b] }];
  expect(latestDeliverables(history)).toEqual([b]); // an approval's own copy is not a delivery
  expect(latestDeliverables(history.slice(0, 2))).toEqual([a]);
  expect(approvedDeliverables(history)).toEqual([b]);
  expect(approvedDeliverables(history.slice(0, 3))).toBeUndefined();
  expect(latestDeliverables([{ event: "proposed" }])).toBeUndefined();
});

test("a file swapped for another between the vetting and the open is refused, not read", async () => {
  const f = folder({ "a.md": "original" });
  const outside = mkdtempSync(join(tmpdir(), "ahub-outside-")); dirs.push(outside); writeFileSync(join(outside, "secret.md"), "outside secret");
  // the swap: after the path was vetted as a regular file inside the project, it becomes a different file (new inode) with other content
  deliverableHooks.beforeOpen = path => { rmSync(join(f.root, path)); writeFileSync(join(f.root, path), "swapped in after the check"); };
  await expect(hashDeliverables([claim("a.md")], f.ports())).rejects.toThrow(/changed while it was being checked/);
  // and a swap for a link to the outside is never followed: O_NOFOLLOW refuses it
  deliverableHooks.beforeOpen = path => { rmSync(join(f.root, path)); symlinkSync(join(outside, "secret.md"), join(f.root, path)); };
  await expect(hashDeliverables([claim("a.md")], f.ports())).rejects.toThrow(/cannot be opened|changed while/);
  delete deliverableHooks.beforeOpen;
  writeFileSync(join(f.root, "b.md"), "stable");
  expect((await hashDeliverables([claim("b.md")], f.ports()))[0]!.sha256).toBe(sha("stable")); // no swap: hashed normally
});
