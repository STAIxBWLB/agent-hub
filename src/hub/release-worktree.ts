import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { ReleaseGit } from "./sdlc-release.ts";

/** Filter-free tracked checkout comparison. Unknown or transformed content refuses. */
// ponytail: 4096 entries, 4 MiB/file, 32 MiB total and 250 ms; larger/gitlink/transformed checkouts require a future bounded artifact attestation.
export function releaseTrackedClean(root: string, git: ReleaseGit): boolean {
  const start = performance.now(), deadline = () => performance.now() - start <= 250;
  const run = (args: string[]) => {
    if (!deadline()) return;
    const result = git(args);
    return deadline() && result.code === 0 && Buffer.byteLength(result.stdout) <= 2 * 1024 * 1024 ? result.stdout : undefined;
  };
  try {
    const base = resolve(root);
    if (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()) return false;
    if (run(["diff-index", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"]) === undefined) return false;
    const inventory = run(["ls-files", "--stage", "-z"]);
    if (inventory === undefined || inventory && !inventory.endsWith("\0")) return false;
    const entries = inventory ? inventory.slice(0, -1).split("\0") : [];
    if (entries.length > 4096) return false;
    let total = 0;
    for (const entry of entries) {
      if (!deadline()) return false;
      const match = /^([0-7]{6}) ([0-9a-f]{40}) ([0-3])\t([\s\S]+)$/.exec(entry);
      if (!match) return false;
      const [, mode, oid, stage, name] = match;
      if (stage !== "0" || !["100644", "100755", "120000"].includes(mode!)) return false;
      if (!name || name.length > 4096 || name.startsWith("/") || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || /[\p{Cc}]/u.test(name)) return false;
      const file = resolve(base, name), within = relative(base, file);
      if (!within || within === ".." || within.startsWith("../")) return false;
      for (let parent = dirname(file); parent !== base; parent = dirname(parent)) {
        if (!deadline()) return false;
        const info = lstatSync(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) return false;
      }
      const before = lstatSync(file);
      if (before.size > 4 * 1024 * 1024 || total + before.size > 32 * 1024 * 1024) return false;
      let bytes: Buffer;
      if (mode === "120000") {
        if (!before.isSymbolicLink()) return false;
        bytes = readlinkSync(file, { encoding: "buffer" });
      } else {
        if (!before.isFile() || before.isSymbolicLink() || !!(before.mode & 0o111) !== (mode === "100755")) return false;
        bytes = readFileSync(file);
      }
      total += bytes.length;
      if (bytes.length > 4 * 1024 * 1024 || total > 32 * 1024 * 1024 || !deadline()) return false;
      const after = lstatSync(file);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return false;
      if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== oid) return false;
    }
    return deadline();
  } catch { return false; }
}
