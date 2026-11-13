import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { projectionPath, snapshotBytes, PROJECTED_DIFF_BYTES } from "./projected-diff.ts";
import type { Repo } from "./snapshots.ts";
import type { TextProjections } from "./text-projection.ts";

export interface ReviewReadRequest { path: string; side?: "base" | "head" }
export type ReviewMaterial =
  | { state: "available"; path: string; side: "base" | "head"; text: string; rawHash: string; contentHash: string; projection?: { name: string; version: string } }
  | { state: "unavailable"; path: string; side: "base" | "head" };
export interface ReviewMaterialBatch { head: string; materials: ReviewMaterial[] }
export interface ReviewMaterialOptions {
  repo: Repo;
  base: string;
  head: string;
  /** Trusted execution-root-relative scopes, prepared by the host, never enlarged from a read request. */
  paths: readonly string[];
  projections: Pick<TextProjections, "handles" | "projectBytes">;
  deny?: readonly string[];
  privatePath?: (path: string) => boolean;
  nameable?: (text: string) => boolean;
  /** Host-only clock for the shared call budget. */
  now?: () => number;
  /** An earlier operation deadline includes the host's head/scope preparation in the same 8 s budget. */
  deadline?: number;
}

const MAX_FILES = 8, READ_MS = 8000;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Immutable Git material only. Create one reader per read/send operation so every side shares its budgets. */
export function createReviewMaterialReader(options: ReviewMaterialOptions): { readonly head: string; read(path: string, side?: "base" | "head"): ReviewMaterial } {
  const now = options.now ?? (() => performance.now()), deadline = Math.min(now() + READ_MS, options.deadline ?? Infinity);
  const files = new Set<string>(), scopes = [...options.paths];
  let presentationBytes = 0;
  const remaining = () => deadline - now();
  const allowed = (path: string, repoPath: string): boolean => {
    try {
      const deny = [...(options.deny ?? [])];
      return !/[\p{Cc}\p{Cf}]/u.test(path) && projectionPath({ ...options.repo, prefix: "" }, path, deny)
        && projectionPath(options.repo, repoPath, deny)
        && scopes.some(scope => scope === "" || path === scope || path.startsWith(scope + "/"))
        && (!options.privatePath || options.privatePath(path) === false) && (!options.nameable || options.nameable(path) === true);
    } catch { return false; }
  };
  return {
    head: options.head,
    read(path, side = "head") {
      const unavailable: ReviewMaterial = { state: "unavailable", path, side };
      try {
        if (typeof path !== "string" || (side !== "base" && side !== "head") || !Number.isFinite(deadline) || remaining() <= 0) return unavailable;
        const repoPath = options.repo.prefix + path;
        if (!allowed(path, repoPath) || !files.has(path) && files.size >= MAX_FILES) return unavailable;
        files.add(path);
        // The existing Git/converter ports use performance.now(); translate the host clock's remaining budget once per operation.
        const bytes = snapshotBytes(options.repo, side === "base" ? options.base : options.head, repoPath, performance.now() + remaining());
        if (!bytes || remaining() <= 0) return unavailable;
        const rawHash = hash(bytes), file = join(options.repo.top, repoPath);
        let text: string, projection: { name: string; version: string } | undefined;
        if (options.projections.handles(file)) {
          const converted = options.projections.projectBytes(file, bytes, performance.now() + remaining());
          if (!converted || converted.inputHash !== rawHash || !/^[a-f0-9]{64}$/.test(converted.configHash)) return unavailable;
          text = converted.text;
          // This is the existing configured converter fingerprint, not a claimed upstream semantic version.
          projection = { name: "text-projection:" + extname(path).toLowerCase(), version: converted.configHash };
        } else text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (typeof text !== "string" || text.includes("\0") || remaining() <= 0 || !allowed(path, repoPath) || options.nameable && options.nameable(text) !== true) return unavailable;
        const material: ReviewMaterial = { state: "available", path, side, text, rawHash, contentHash: projection ? hash(Buffer.from(text, "utf8")) : rawHash, ...(projection ? { projection } : {}) };
        const size = Buffer.byteLength(JSON.stringify(material), "utf8");
        if (presentationBytes + size > PROJECTED_DIFF_BYTES || remaining() <= 0) return unavailable;
        presentationBytes += size;
        return material;
      } catch { return unavailable; }
    },
  };
}
