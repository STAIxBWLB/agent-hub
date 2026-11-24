/**
 * #1646 T2: what the checkout the reviewer read held when the verdict was given. The hub reads it, never the reviewer, and it
 * lives on the verdict's history entry: the approval's coverage receipt is hashed from `sdlc`, so evidence kept there would
 * invalidate an in-flight verdict against itself.
 *
 * Every list is empty only because the read said so. An unreadable checkout is no evidence at all, never an empty one.
 */

/**
 * Which checkout the evidence describes. `peer-cwd` is the checkout the reviewing session reported for itself on the control
 * socket, so the record names the bytes that session read; `project-root` is the hub's own project checkout, recorded only
 * when the hub knows no checkout of its own for that reviewer. A later count separates "the reviewer read other bytes" from
 * "the hub looked at the root" only because every record says which of the two it is.
 */
export type ReviewCheckoutSource = "peer-cwd" | "project-root";

export interface ReviewCheckoutEvidence {
  /** The checkout that was read: the reviewing session's own, or the project checkout. */
  source: ReviewCheckoutSource;
  /** That checkout's HEAD, or null when it could not be read. */
  head: string | null;
  /** Reviewed paths whose worktree content differs from the reviewed commit. */
  differing: string[];
  /** Reviewed paths the checkout holds as untracked files. */
  untracked: string[];
}
