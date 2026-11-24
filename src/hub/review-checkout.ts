/**
 * #1646 T2: what the reviewer's checkout held when the verdict was given. The hub reads it, never the reviewer, and it
 * lives on the verdict's history entry: the approval's coverage receipt is hashed from `sdlc`, so evidence kept there
 * would invalidate an in-flight verdict against itself.
 *
 * Every list is empty only because the read said so. An unreadable checkout is no evidence at all, never an empty one.
 */
export interface ReviewCheckoutEvidence {
  /** The checkout's HEAD, or null when it could not be read. */
  head: string | null;
  /** Reviewed paths whose worktree content differs from the reviewed commit. */
  differing: string[];
  /** Reviewed paths the checkout holds as untracked files. */
  untracked: string[];
}
