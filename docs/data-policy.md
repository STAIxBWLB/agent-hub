# Private and read-only data paths (#259)

- Optional shared or machine-local config declares `pii.paths` and `data.readonly`, each at most 64 bounded project-relative paths. Entries name exact paths/subtrees, with no command execution. Empty or absent lists preserve existing behavior. These initial policies apply at daemon start; edit config deliberately and restart to refresh them.
- Example: `{ "pii": { "paths": ["data/private"] }, "data": { "readonly": ["data/raw"] } }`.
- Matching compares declared spellings and real targets, including symlink aliases and case variants. Unknown resolution conservatively matches an active policy. Paths outside the project cannot be selected as policy entries; managed tools retain their existing project boundary.

# Private task flow

- Declared refs, plan paths and section file anchors matching pii.paths receive a hard private signal before triage, board writes, notices or memory. The task remains local-only even if ordinary pattern-based PII routing is off.
- Public titles/views stay stubs, private envelopes stay private, and automatic notes skip memory. Newly accepted plans cannot silently add a private path to an ordinary task. Existing pattern screening and unknown verdict handling remain in force.
- This governs declared task paths and the managed flow. It does not contain a same-user external shell or another native peer reading arbitrary files outside its declared task.

# Read-only managed tools

- Local/Pi read operations retain access. Managed write/edit refuse protected paths before asking for approval and re-check real targets after approval. With an active read-only policy, hardlinked write targets are refused because their identity cannot be attributed safely to one declared name.
- Managed command execution (bash and git) becomes filesystem read-only whenever data.readonly is active. It keeps reads and stdout/stderr, allows /dev/null, and grants no project or temporary-directory writes. Commands that create output files or caches must instead return stdout or use managed write/edit for an unprotected output path. This restriction is required by the reproduced hardlink-alias bypass of path-only Seatbelt denies.
- The command profile and runner must both use read-only mode; the runner refuses a profile that still carries a broad project write grant. No approval or permission mode overrides the data policy. Existing network and credential boundaries stay in force.
- This policy controls managed local/Pi tools, not the owner or other native processes. The hub's state, receipts and temporary command directory are maintained by the daemon outside the managed command.

# Evidence boundary

- Source tests cover bounded config/layers, real-path aliases, private flow before triage, public redaction, approval re-checks and managed hardlink refusal.
- Native macOS command tests cover direct write, parent rename, existing/new hardlinks, temporary aliases and preserved reads. Linux runs the source guards and retains its existing no-sandbox/no-command behavior.
- Real-account/model execution remains unverified; no live research study runs as part of this implementation. Profile converters and shadow repositories are later #259 slices.
