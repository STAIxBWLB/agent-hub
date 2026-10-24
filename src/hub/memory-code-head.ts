import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { hubGitSync } from "./git.ts";
import { realPath } from "./project.ts";
export interface MemoryCodeHead { head: string; current(): string | undefined }
const SHA = /^[a-f0-9]{40}$/;
function text(file: string, cap: number): string | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = fstatSync(fd); if (!before.isFile() || before.size > cap) throw Error();
    const bytes = Buffer.alloc(cap + 1), count = readSync(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd), named = lstatSync(file);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink()) throw Error();
    return bytes.subarray(0, count).toString("utf8").trim();
  } finally { closeSync(fd); }
}
/** One hardened Git probe per admitted derive; cache validation reads bounded Git-owned HEAD/ref files, never launches Git. */
export function readMemoryCodeHead(repo: string): MemoryCodeHead | undefined {
  try {
    const found = hubGitSync(["-C", repo, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "HEAD"], { encoding: "utf8", timeout: 250 });
    const lines = found.stdout.trim().split("\n");
    if (found.status !== 0 || lines.length !== 3 || !SHA.test(lines[2]!)) return;
    const git = realPath(lines[0]!), common = realPath(lines[1]!), marker = join(repo, ".git"), markerStat = lstatSync(marker);
    if (markerStat.isSymbolicLink()) return;
    const binding = markerStat.isDirectory() ? `${markerStat.dev}:${markerStat.ino}` : text(marker, 4096);
    const headFile = join(git, "HEAD"), initial = text(headFile, 1024); if (!initial) return;
    const branch = initial.startsWith("ref: ") ? initial.slice(5) : undefined;
    if (branch && (!branch.startsWith("refs/heads/") || /[\\\p{Cc}\p{Cf}]/u.test(branch) || branch.split("/").some(part => !part || part === "." || part === ".."))) return;
    const current = (): string | undefined => {
      try {
        const now = lstatSync(marker); if (now.isSymbolicLink() || (now.isDirectory() ? `${now.dev}:${now.ino}` : text(marker, 4096)) !== binding || text(headFile, 1024) !== initial) return;
        if (!branch) return SHA.test(initial) ? initial : undefined;
        const loose = text(join(common, branch), 128);
        if (loose !== null) return SHA.test(loose) ? loose : undefined;
        // ponytail: very large packed-ref inventories remain unknown; use a bounded native ref service if this ceiling matters.
        const packed = text(join(common, "packed-refs"), 1024 * 1024);
        const matches = (packed ?? "").split("\n").filter(line => line.slice(41) === branch && SHA.test(line.slice(0, 40)) && line[40] === " ");
        return matches.length === 1 ? matches[0]!.slice(0, 40) : undefined;
      } catch { return undefined; }
    };
    return current() === lines[2] ? { head: lines[2]!, current } : undefined;
  } catch { return undefined; }
}
