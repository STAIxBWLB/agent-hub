# Bounded text projections (#259)

- Optional machine-local text_projection maps lowercase extensions to argv arrays. Each uses one separate {input} argument. No shell string, automatic converter install or default command.
- Example: { "text_projection": { ".docx": ["/usr/bin/textutil", "-convert", "txt", "-stdout", "{input}"] } }. Configure the converter explicitly for the machine. Shared/tracked config cannot choose these programs.
- Facts excludes private paths before conversion. The converter reads an immutable snapshot in an owned temporary directory, with a literal read grant for that file only, uses the existing macOS no-network/read-only sandbox and has a 5-second deadline, 16 MiB input cap and 256 KiB stdout/stderr cap. A trusted helper owns and stops its process group; converter stderr is never published.
- Output caches in state by raw content hash and argv/program/script metadata fingerprint. Invalid/oversized cache or failing/unavailable conversion falls back to the existing raw/binary facts behavior, with one bounded notice per extension.
- Raw hashes and git blob identities remain the change identities. Projected text only supplies presentation diffs. A projected read or patch cannot establish raw-file write attribution. Existing text privacy checks and header sanitization still apply.
- Converter programs may require temporary writes/caches; those fail under this read-only policy. Use a converter that emits stdout. The owner and other native same-user processes remain outside this boundary.
- Linux retains no-sandbox/no-converter behavior. No native model/account study runs. Rich-file review/undo preview integration, shadow repositories and profile override/glob follow-ups remain open in #259.
