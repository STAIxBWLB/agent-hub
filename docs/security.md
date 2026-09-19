# Security notes

agent-hub connects agents that can each run commands. This page says what the hub defends, how, and what it does not.

## Trust boundaries

- **Other agents' text is untrusted.** Every message that crosses from one peer to another is framed as untrusted input (a channel tag with `meta.source` for Claude, a fixed header line plus a standing instruction for the others). A message body cannot forge the hub's own headers: such lines are quoted (`sanitize`). Replies inherit a hop count capped at 3, so agents cannot ping-pong forever; neither a digest nor a steer can reset it.
- **The control link is loopback plus a secret.** The daemon and the Codex proxy bind 127.0.0.1 only. The control WebSocket requires a per-run token (`.agenthub/state/control-token`, mode 600), and both servers refuse any request that carries an `Origin` header: any web page can open a WebSocket to localhost, and browsers always send `Origin`. External clients cannot claim the console user's id or a hub-managed peer's id.
- **Permission prompts stay on.** `ahub claude` and `ahub codex` add nothing that weakens the agents' own prompts. Kimi's and `local`'s permission requests are relayed to the console and cancelled after 120 s of silence. `--unattended` turns prompts off, says so loudly, and is never the default.
- **The local worker is boxed in.** Paths are resolved through symlinks and must stay inside the project; a secrets denylist (`.env*`, keys, credential files, the hub's own state) applies to its file tools, its git arguments and its memory capture alike; `.git` and `.agenthub` are not writable. Writes, edits, shell commands and mutating git wait for approval, and the approver sees what will be written or run, with control characters escaped. Everything it executes runs under the macOS sandbox, attended or not: no writes outside the project, its git dir and temp; the home directory is unreadable except toolchains; no `.git/hooks` or `.git/config` writes; no network, loopback included. Without the sandbox there is no `bash` tool.
- **PII has an enforced path.** A task matching `signals.pii_patterns` goes to `local` or to nobody; its text is absent from other peers' envelopes, the console stream, the log and the board listing; the console user reviews it; `local` answers such a turn to the console only, keeps it out of its history, refuses it when the only gateway is off campus, and may not save notes or spin off tasks during it. Nothing about it is sent to claude-mem, whose observer is a cloud model.
- **Secrets stay where they are read.** The gateway key and Cloudflare Access values are read inside the gateway client and go only into request headers: never into logs, errors, envelopes, tool output, memory, or the generated Switchyard config (the key travels by environment variable name). Subscription logins of Claude, Codex and Kimi are never proxied or pooled.
- **The hub's own model calls are fenced.** Digest condensation and task triage read agent-written text as data; their output is capped text framed as untrusted, or a value checked against a closed list. It is never used as a route, a peer id, a tool call or an instruction.

## What is not defended

- **A malicious local process running as you.** It can read the control token, `hub.db`, the project and your home directory without the hub's help. The token keeps web pages and other users out, not your own processes.
- **An agent you launched without its own safeguards.** The hub frames and routes; it does not sandbox Claude Code, Codex or Kimi. `--unattended` plus untrusted peer text is a risk you opt into.
- **What an approved command does inside the project.** The sandbox bounds where a command can write and what it can read, not whether `rm -rf src` was a good idea. Read what you approve.
- **Network-level proof for PII.** The hub proves at its own boundaries (tests search every output) that PII text does not leave; packet-level verification of your gateway path is an operations check.
- **Other operating systems' sandboxes.** Only macOS seatbelt is implemented.

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" on this repository rather than in a public issue.

## Local dashboard sessions (issue #6)

- `ahub ui` uses the authenticated console control connection to start an ephemeral HTTP listener on `127.0.0.1`. No UI listener exists before that command. The control and Codex proxy ports continue to refuse every `Origin` header.
- The daemon issues a cryptographically random, single-use bootstrap ticket valid for 60 seconds. The CLI opens the dashboard with that ticket in the URL fragment, never a query string or the control token. The static page removes the fragment immediately and exchanges it with a same-origin POST. Tickets are consumed once; expired tickets cannot create sessions.
- The exchange creates a separate random session, valid for one hour without renewal, in an `HttpOnly; SameSite=Strict; Path=/` cookie named for this listener's port. Sessions and tickets live only in memory and die with the daemon. HTTP is loopback-only; the cookie is not a substitute for the origin checks.
- Every request must have the exact listener Host. Every data or action request, including the ticket exchange and snapshot polling, must be POST with the exact listener Origin and JSON content type. Foreign and missing origins, missing or expired sessions, oversized bodies and unknown actions are rejected. There is no CORS support. The only unauthenticated GET is the fixed, data-free HTML shell. No files or paths are served dynamically.
- Responses are non-cacheable, cannot be framed, suppress referrers, and use a content security policy restricting scripts/styles to the shipped inline content and connections to this origin. Browser text is rendered with textContent, never interpreted as HTML.
- The browser receives a bounded redacted event stream, peer states and queue counts, public task views, budget windows and pending approvals. Private envelope bodies and PII task text never cross this endpoint. Local-worker approval titles can contain PII, so their details remain terminal-only; the dashboard identifies the request and directs the operator to `ahub tail` before allowing it. Budget checkpoint summaries are also omitted.
- The closed action list is permission response, peer pause/resume, console message, task proposal and task assignment. These use the existing daemon/task paths and budget pause rules. There is no generic control proxy, task-detail read, shell, file access, configuration edit, budget override, peer launch or daemon shutdown API.
- The listener stops with the daemon. Expired sessions must be reopened with `ahub ui`; the page does not silently obtain new credentials.


## Multi-project manager (protocol 7)

The manager has its own loopback session server and authenticated local control
endpoint. Browsers provide registered project IDs and expected daemon instance
IDs; they cannot submit arbitrary paths, ports, PIDs or control tokens. The
manager forwards the same closed, redacted dashboard operations as a project-local
page. It cannot expose private task history or allow local-worker tools.

Per-project control handshakes verify project, root and instance against the
runtime manifest. Shutdown removes only the owning instance's runtime files and
waits for owned child processes. Registry and manager startup claims serialize
concurrent starts; uncertain ownership is reported, not forcibly reclaimed.
A stale browser action against a restarted daemon is rejected, and mutations are
never automatically replayed after a connection failure.

The manager can start registered hubs in attended mode. Its project launches do
not inherit state, unattended or gateway URL/key overrides from the session that
opened the manager. Native memory is deliberately not a project-isolation boundary:
its existing basename/worktree aliases and provider accounts can remain shared.
