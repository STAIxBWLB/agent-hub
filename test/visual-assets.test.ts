import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deliverableHooks, hashDeliverables, readGuardedDeliverable, type DeliverablePorts } from "../src/hub/deliverable-files.ts";
import { DELIVERABLE_LIMITS } from "../src/hub/deliverables.ts";
import { readVisualAsset, resolveVisualAssets, VISUAL_ASSET_BYTES } from "../src/hub/visual-assets.ts";
import type { VisualFile, VisualInput } from "../src/hub/visual.ts";

const roots: string[] = [];
afterEach(() => { delete deliverableHooks.beforeOpen; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const png = () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const jpeg = () => Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const webp = () => Buffer.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-visual-assets-")); roots.push(root);
  const write = (path: string, bytes: Uint8Array | string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), bytes); };
  write("before.png", png()); write("after.png", png());
  const ports: DeliverablePorts = { cwd: root, deny: [], private: () => false };
  return { root, ports, write };
}
const pair = (before = "before.png", after = "after.png"): VisualInput => ({ kind: "beforeAfter", caption: "Fixture", before: { path: before, alt: "Before" }, after: { path: after, alt: "After" } });
async function posted(f: ReturnType<typeof fixture>): Promise<VisualFile> {
  const result = await resolveVisualAssets(pair(), "visual-fixture", f.ports);
  const file = result.files[0]; if (!file) throw new Error("fixture asset missing"); return file;
}

test("guarded deliverable read reuses host hashing and leaves legacy private deliverables unchanged", async () => {
  const f = fixture(), read = await readGuardedDeliverable("before.png", f.ports);
  expect(read.data).toEqual(png()); expect(read.sha256).toBe(sha(png())); expect(read.bytes).toBe(png().length);
  expect(Number.isFinite(read.identity.dev)).toBe(true); expect(Number.isFinite(read.identity.ino)).toBe(true);
  const privatePorts = { ...f.ports, private: () => true };
  await expect(readGuardedDeliverable("before.png", privatePorts)).rejects.toThrow("private file");
  const legacy = await hashDeliverables([{ path: "before.png", format: "png" }], privatePorts);
  expect(legacy[0]?.private).toBe(true); expect(legacy[0]?.sha256).toBe(read.sha256);
  await expect(readGuardedDeliverable("before.png", f.ports, DELIVERABLE_LIMITS.fileBytes + 1)).rejects.toThrow("invalid read limit");
});

test("beforeAfter paths become only exact asset references and host-owned metadata", async () => {
  const f = fixture(), result = await resolveVisualAssets(pair(), "visual-1", f.ports);
  expect(result.payload).toEqual({ kind: "beforeAfter", caption: "Fixture", before: { asset: "visual-1:before", alt: "Before" }, after: { asset: "visual-1:after", alt: "After" } });
  expect(result.files).toEqual(["before", "after"].map(side => ({ asset: `visual-1:${side}`, path: `${side}.png`, sha256: sha(png()), bytes: png().length, mime: "image/png" })));
  expect(JSON.stringify(result)).not.toContain("data"); expect(JSON.stringify(result)).not.toContain(f.root);
  const served = await readVisualAsset(result.files[0]!, f.ports);
  expect(served.bytes).toEqual(png()); expect(served.mime).toBe("image/png"); expect(served.name).toBe("before.png");
});

for (const [path, bytes, mime] of [["shot.png", png(), "image/png"], ["shot.JPG", jpeg(), "image/jpeg"], ["shot.jpeg", jpeg(), "image/jpeg"], ["shot.webp", webp(), "image/webp"]] as const)
  test(`asset extension and magic admit ${path}`, async () => {
    const f = fixture(); f.write(path, bytes);
    const result = await resolveVisualAssets({ kind: "beforeAfter", before: { text: "Before text" }, after: { path, alt: "After image" } }, "v", f.ports);
    expect(result.files[0]?.mime).toBe(mime); expect(result.files[0]?.asset).toBe("v:after");
    expect((await readVisualAsset(result.files[0]!, f.ports)).bytes).toEqual(bytes);
  });

test("non-beforeAfter payloads pass unchanged and text sides open no files", async () => {
  const f = fixture(); let opens = 0; deliverableHooks.beforeOpen = () => { opens++; };
  const payloads: VisualInput[] = [{ kind: "mermaid", source: "flowchart TD\n A-->B" }, { kind: "comparison", options: [{ title: "One" }, { title: "Two" }] }, { kind: "table", columns: [{ key: "a", label: "A" }], rows: [{ a: "value" }] }, { kind: "beforeAfter", before: { text: "old" }, after: { text: "new" } }];
  for (const input of payloads) { const result = await resolveVisualAssets(input, "v", f.ports); expect(result.payload).toEqual(input); expect(result.files).toEqual([]); }
  expect(opens).toBe(0);
});

for (const [path, bytes] of [["image.svg", "<svg>synthetic-content</svg>"], ["renamed.png", "<svg>synthetic-content</svg>"], ["renamed.jpg", png()], ["renamed.webp", png()], ["image.svg", png()], ["image.gif", "GIF89a"], ["empty.png", ""]] as const)
  test(`unsupported or mismatched image ${path} refuses without echoing bytes`, async () => {
    const f = fixture(); f.write(path, bytes);
    await expect(resolveVisualAssets(pair(path), "v", f.ports)).rejects.toThrow("before.path");
    await expect(resolveVisualAssets(pair(path), "v", f.ports)).rejects.not.toThrow("synthetic-content");
  });

test("visual size ceiling is exactly eight MiB and refuses larger files before opening", async () => {
  const f = fixture(); truncateSync(join(f.root, "before.png"), VISUAL_ASSET_BYTES);
  expect((await resolveVisualAssets(pair(), "v", f.ports)).files[0]?.bytes).toBe(VISUAL_ASSET_BYTES);
  truncateSync(join(f.root, "before.png"), VISUAL_ASSET_BYTES + 1);
  let opens = 0; deliverableHooks.beforeOpen = () => { opens++; };
  await expect(resolveVisualAssets(pair(), "v", f.ports)).rejects.toThrow("8 MiB"); expect(opens).toBe(0);
});

test("privacy refuses before the first open, including a public alias of a private target", async () => {
  const f = fixture(); let opens = 0; deliverableHooks.beforeOpen = () => { opens++; };
  const ports = { ...f.ports, private: (path: string) => path === "before.png" || path.startsWith("private/") };
  await expect(resolveVisualAssets(pair(), "v", ports)).rejects.toThrow("not allowed"); expect(opens).toBe(0);
  f.write("private/screenshot.png", png()); symlinkSync(join(f.root, "private/screenshot.png"), join(f.root, "alias.png"));
  await expect(resolveVisualAssets(pair("alias.png"), "v", ports)).rejects.toThrow("not allowed"); expect(opens).toBe(0);
  await expect(readGuardedDeliverable("after.png", { ...f.ports, private: () => { throw new Error("synthetic-private-policy"); } })).rejects.toThrow("privacy policy"); expect(opens).toBe(0);
});

test("traversal, outside, deny, hub state and unreadable files refuse without resolved paths", async () => {
  const f = fixture(), outside = fixture(); outside.write("outside.png", png());
  for (const path of [".agenthub/image.png", ".git/image.png", "secrets/image.png"]) f.write(path, png());
  symlinkSync(join(outside.root, "outside.png"), join(f.root, "outside.png"));
  symlinkSync(join(f.root, "absent.png"), join(f.root, "dangling.png"));
  mkdirSync(join(f.root, "folder.png"));
  const ports = { ...f.ports, deny: ["secrets"] };
  for (const path of ["../outside.png", "sub/../before.png", join(outside.root, "outside.png"), ".agenthub/image.png", ".git/image.png", "secrets/image.png", "outside.png", "dangling.png", "missing.png", "folder.png"]) {
    let error: unknown; try { await resolveVisualAssets(pair(path), "v", ports); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain("before.path"); expect((error as Error).message).not.toContain(f.root); expect((error as Error).message).not.toContain(outside.root);
  }
});

for (const link of ["same-path", "symlink", "hardlink"] as const) test(`before and after must be different physical files through ${link}`, async () => {
  const f = fixture(); let path = "before.png";
  if (link === "symlink") { symlinkSync(join(f.root, path), join(f.root, "alias.png")); path = "alias.png"; }
  if (link === "hardlink") { linkSync(join(f.root, path), join(f.root, "alias.png")); path = "alias.png"; }
  await expect(resolveVisualAssets(pair("before.png", path), "v", f.ports)).rejects.toThrow("same physical file");
});

test("a symlink swap between vetting and open is refused without reading the replacement", async () => {
  const f = fixture(), outside = fixture(); outside.write("replacement.png", png());
  deliverableHooks.beforeOpen = path => { rmSync(join(f.root, path)); symlinkSync(join(outside.root, "replacement.png"), join(f.root, path)); };
  await expect(resolveVisualAssets(pair(), "v", f.ports)).rejects.toThrow("not allowed");
});

test("a mutation after the opened descriptor stat refuses the whole read", async () => {
  const f = fixture(); let opened = false, mutated = false;
  deliverableHooks.beforeOpen = () => { opened = true; };
  const ports = { ...f.ports, private: () => { if (opened && !mutated) { mutated = true; f.write("before.png", Buffer.concat([png(), Buffer.from("changed")])); } return false; } };
  await expect(resolveVisualAssets(pair(), "v", ports)).rejects.toThrow("not allowed"); expect(mutated).toBe(true);
});

test("metadata-restored content drift is refused at asset serving by its full hash", async () => {
  const f = fixture(), timestamp = new Date("2026-11-08T00:00:00Z"); utimesSync(join(f.root, "before.png"), timestamp, timestamp);
  const file = await posted(f), changed = png(); changed[changed.length - 1] = 9;
  f.write(file.path, changed); utimesSync(join(f.root, file.path), timestamp, timestamp);
  expect(readFileSync(join(f.root, file.path)).length).toBe(file.bytes);
  await expect(readVisualAsset(file, f.ports)).rejects.toThrow("changed since posted");
});

test("serving reruns path/privacy/size/MIME guards and never echoes a resolved path", async () => {
  const f = fixture(), file = await posted(f);
  for (const ports of [{ ...f.ports, private: () => true }, { ...f.ports, deny: ["before.png"] }]) await expect(readVisualAsset(file, ports)).rejects.toThrow("changed since posted");
  await expect(readVisualAsset({ ...file, mime: "image/jpeg" }, f.ports)).rejects.toThrow("changed since posted");
  truncateSync(join(f.root, file.path), VISUAL_ASSET_BYTES + 1);
  await expect(readVisualAsset(file, f.ports)).rejects.not.toThrow(f.root);
  rmSync(join(f.root, file.path)); await expect(readVisualAsset(file, f.ports)).rejects.toThrow("changed since posted");
});
