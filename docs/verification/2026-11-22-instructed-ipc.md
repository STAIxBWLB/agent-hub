# Exact instruction IPC verification

Date: 2026-11-22. Refs #1622, hub task 1065.

- On macOS and Linux with Bun 1.4.4, `Bun.spawn` with JSON IPC completed a child hello, parent welcome, child request and parent reply, and the child exited 0. The first Linux probe incorrectly assumed exactly one socket and returned failure after observing two. The corrected probe required every observed child socket to refuse reopening; it exited 0 and both returned ENXIO.
- In the Linux container, Yama `ptrace_scope` was 1 and seccomp mode was 2. A same-user sibling could read a token from a child's environment and open another child's inherited ordinary pipe. It could not reopen the IPC socket through `/proc/<pid>/fd`; a `pidfd_getfd` attempt was denied with EPERM. Node's spawned fd was reported as a Unix socket on macOS. These observations do not establish the same restriction under other host policies.
- A same-user process able to debug a child, duplicate its socket, rewrite its managed transcript, or modify the installed hub package is outside this boundary.
- Claude Code 2.1.329, in a temporary home with a synthetic loopback API and no account, ran a model-requested Bash tool in headless mode. The hook supplied a session id and the Bash tool inherited the same session id. This is an environment-binding probe, not a real-account or interactive TUI receipt.
- The committed `test/instructed-tier.test.ts` exercises the IPC hello and request exchange, forbids a child WebSocket, and runs a real CLI from a copied installed fixture against a scratch daemon. It also tests receipt reuse, mode, PII, Stop, output cap and audit provenance. It does not prove a real-account run.
