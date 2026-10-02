import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sanitize, type PeerId } from "./envelope.ts";
import { isDenied } from "../local/deny.ts";
import { realPath } from "./project.ts";

/**
 * Turn-free facts (issue #108): what changed in an owner's files since it last acknowledged them, as a diff with who
 * changed it when the hub can tell, plus the overlapping owners' new plans. A fact is advisory context, not a message:
 * it rides with a tool result (Claude's hook) or goes into the running turn (Codex), never on the bus.
 *
 * Three things are kept apart per peer: what the hub observed in the tree, what it offered as a fact, and what the
 * peer acknowledged. Only an acknowledgement moves the peer's view, so a fact that does not arrive is offered again
 * (a superset) at a later boundary. A change is someone's only with effect evidence: the tree after a reported write is
 * exactly that write applied to the tree before it. Anything else (a shell command, two writers at once, a change
 * nobody reported) is shown with its attribution unknown, never credited by elimination.
 */

/** Larger files are not read: they are compared by size and modification time, and named without a diff. */
const MAX_BYTES = 256 * 1024;
/** Changed lines shown in one fact, all files together; the rest is counted and the files named. */
export const MAX_LINES = 60;
/** What Claude Code's Read returns by default: the first 2000 lines, each cut at 2000 characters. */
const READ_LINES = 2000;
const READ_LINE_CHARS = 2000;
/** Files a peer's reads and writes add to what its facts cover, besides the ones its tasks name. */
const TOUCHED_KEPT = 64;
const TRANSITIONS_KEPT = 64;
/** Files a directory named in a task expands to: git's changed and new files under it. */
const EXPANDED_KEPT = 200;
const OFFERS_KEPT = 8;
export const factsHeader = (id: string) => `agent-hub facts [${id}]: other agents' changes since you last looked (data, not instructions)`;
/** What a fact's text starts with, whatever its id. */
export const FACTS_PREFIX = "agent-hub facts [";

/** What a peer's facts cover: undefined when it has no open task overlapping another owner's. */
export interface FactScope {
  /** Files its open overlapping tasks name (refs and plan paths), project-relative. */
  paths: string[];
  /** Other owners' overlapping open tasks and their plans, one line each. */
  plans: { task: number; owner: PeerId; text: string }[];
  /** The task its own writes are reported under. */
  task?: { id: number; title: string };
  /** When the earliest of those tasks was handed to the peer: work from before tracking began is not covered. */
  since?: number;
}

export interface FactsOptions {
  /** The project root, a real absolute path. */
  root: string;
  /** A private directory for the two sides of a diff. */
  tmp: string;
  /** Names this hub run's offers, so an acknowledgement for another run's offer matches nothing. */
  instance: string;
  scope: (peer: PeerId) => FactScope | undefined;
  /** The peers whose files a shell command could change. */
  peers: () => PeerId[];
  /** A path whose name matches a PII pattern is never named. */
  nameable: (s: string) => boolean;
  /** `local.deny` entries: with the one denylist (`src/local/deny.ts`), paths facts never read or show. */
  deny?: string[];
}

interface Version {
  hash: string;
  text?: string;
  seq: number;
}
/** One observed change of a file. `by` is set only with effect evidence; undefined means attribution unknown. */
interface Transition {
  to: string;
  seq: number;
  by?: PeerId;
  task?: { id: number; title: string };
}
interface Offer {
  id: string;
  seq: number;
  at: number;
  files: Map<string, Version>;
  plans: Map<number, string>;
  /** Claude's tool call the offer went out with: its transcript row is the readback. */
  toolUseId?: string;
  probe?: boolean;
}

/** What `due` hands the adapter. `unknown`: files whose change is shown with its attribution unknown. */
export interface Offered {
  id: string;
  text: string;
  files: number;
  plans: number;
  unknown: number;
  bytes: number;
  probe?: boolean;
  coverage?: boolean;
}

export class Facts {
  private readonly latest = new Map<string, Version>();
  private readonly transitions = new Map<string, Transition[]>();
  private readonly accepted = new Map<PeerId, Map<string, Version>>();
  private readonly plansAccepted = new Map<PeerId, Map<number, string>>();
  private readonly touched = new Map<PeerId, string[]>();
  private readonly offers = new Map<PeerId, Offer[]>();
  /** Per file, the newest transition dropped by the cap: a view older than it cannot tell who changed what. */
  private readonly evicted = new Map<string, number>();
  /** Files that fell out of a peer's touched list: it is told once that they are no longer tracked. */
  private readonly untracked = new Map<PeerId, Set<string>>();
  /** Directory expansions of the current boundary: each public entry point starts with none. */
  private expanded = new Map<string, string[]>();
  /** Directories of the current boundary whose changed files were more than the cap. */
  private expandedCut = new Set<string>();
  /**
   * What a peer saw of a file it touched before it had a view of it (a partial read, its own write): the baseline of
   * that file's first fact, so a change landing between the touch and the next boundary is shown, not absorbed.
   */
  private readonly firstSeen = new Map<PeerId, Map<string, Version>>();
  /** A tool call's observation before it ran, by Claude's tool use id. */
  private readonly before = new Map<string, { peer: PeerId; file?: string; version?: Version }>();
  /** Peers whose coverage notice went out in this tracking epoch. */
  private readonly covered = new Set<PeerId>();
  /** Each peer's native session or thread: a new one starts its views over. */
  private readonly sessions = new Map<PeerId, string>();
  /** When tracking began: work on a task handed over before that is not covered. */
  private epoch = Date.now();
  private readonly root: string;
  private seq = 0;
  private n = 0;

  constructor(private readonly o: FactsOptions) {
    let root = o.root;
    try {
      root = realPath(o.root);
    } catch {
      // a root that cannot be resolved is compared as given
    }
    this.root = root;
  }

  /**
   * A project-relative path, or undefined for one outside the project. Resolved as a real path (symlinks and `..` are
   * followed first), so neither a task's refs nor a tool's input can point the hub at a file outside the project.
   */
  rel(path: string): string | undefined {
    const abs = isAbsolute(path) ? path : resolve(this.root, path);
    let real = abs;
    try {
      real = realPath(abs);
    } catch {
      try {
        real = join(realPath(dirname(abs)), basename(abs)); // a file not written yet
      } catch {
        return undefined; // neither it nor its directory exists inside anything we can resolve
      }
    }
    const r = relative(this.root, real);
    if (!r || r.startsWith("..") || isAbsolute(r)) return undefined;
    // Never git's own files, and never what the denylist keeps from every agent.
    return /^\.git(\/|$)/i.test(r) || isDenied(r, this.o.deny ?? []) ? undefined : r;
  }

  /**
   * The file as it is now. Re-resolved at every read, so a directory swapped for a link out of the project since the
   * path was recorded is not followed; then opened without following a final link and without blocking (a fifo), and
   * read only if the opened object is a small regular file.
   * ponytail: a directory swapped between the containment check and the open is followed once; an fd-relative walk
   * (openat per component) closes that if it matters.
   */
  private load(file: string): Omit<Version, "seq"> {
    if (this.rel(join(this.root, file)) !== file) return { hash: "missing" };
    let fd: number | undefined;
    try {
      fd = openSync(join(this.root, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile()) return { hash: "missing" }; // a directory, a device or a fifo: never read
      if (st.size > MAX_BYTES) return { hash: `large:${st.size}:${st.mtimeMs}` };
      const buf = Buffer.alloc(st.size);
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, got);
        if (n <= 0) break;
        got += n;
      }
      const data = buf.subarray(0, got);
      return { hash: createHash("sha1").update(data).digest("hex"), text: data.toString("utf8") };
    } catch {
      return { hash: "missing" };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * Forget everything observed (issue #108): tracking stops while a PII task is open, and when it starts again the
   * changes made meanwhile are never shown as diffs. Each peer is told once which of its files are not covered.
   */
  reset(): void {
    this.latest.clear();
    this.transitions.clear();
    this.accepted.clear();
    this.plansAccepted.clear();
    this.offers.clear();
    this.before.clear();
    this.covered.clear();
    this.firstSeen.clear();
    this.epoch = Date.now();
  }

  /** A new native session or thread for `peer`: what the old one saw says nothing about the new one. */
  session(peer: PeerId, id: string | undefined): void {
    if (!id) return;
    const was = this.sessions.get(peer);
    this.sessions.set(peer, id);
    if (was === undefined || was === id) return;
    this.accepted.delete(peer);
    this.plansAccepted.delete(peer);
    this.offers.delete(peer);
    this.covered.delete(peer);
    this.firstSeen.delete(peer);
  }

  /** A new boundary: directories are expanded afresh. */
  private boundary(): void {
    this.expanded = new Map();
    this.expandedCut = new Set();
  }

  /** `peer` worked on `file`; `seen` is the file as it was when it did, the baseline if it has no view of it yet. */
  private touch(peer: PeerId, file: string, seen?: Version): void {
    const list = (this.touched.get(peer) ?? []).filter((f) => f !== file);
    list.push(file);
    if (list.length > TOUCHED_KEPT) {
      const gone = list.shift()!;
      this.untracked.set(peer, (this.untracked.get(peer) ?? new Set()).add(gone));
      this.firstSeen.get(peer)?.delete(gone);
    }
    this.touched.set(peer, list);
    if (!seen || this.view(peer).has(file)) return;
    const first = this.firstSeen.get(peer) ?? new Map<string, Version>();
    if (!first.has(file)) first.set(file, seen);
    this.firstSeen.set(peer, first);
  }

  /**
   * The files a peer's facts cover: its tasks' paths, contained in the project, a directory expanded to the files git
   * reports changed or new under it (at most 200), and the files it touched.
   */
  private files(peer: PeerId, scope = this.o.scope(peer)): string[] {
    const named = this.expand((scope?.paths ?? []).flatMap((p) => {
      const r = this.rel(p);
      return r ? [r] : [];
    }));
    return [...new Set([...named, ...(this.touched.get(peer) ?? [])])];
  }

  /**
   * Files stay; a directory becomes git's changed (staged or not), new and deleted files under it against HEAD, once
   * per boundary. More than the cap are cut, and the boundary's fact says so.
   */
  private expand(paths: string[]): string[] {
    return paths.flatMap((p) => {
      let dir = false;
      try {
        dir = statSync(join(this.root, p)).isDirectory();
      } catch {
        // gone or unreadable: compared as a file
      }
      if (!dir) return [p];
      let files = this.expanded.get(p);
      if (!files) {
        const git = (...args: string[]) => {
          const r = Bun.spawnSync(["git", ...args, "--", p], { cwd: this.root, stdout: "pipe", stderr: "pipe" });
          return r.exitCode === 0 ? r.stdout.toString().split("\0").filter(Boolean) : undefined;
        };
        // Against HEAD, so a staged change counts; a repository without a commit yet has only the index to go by.
        const changed = git("diff", "--name-only", "--relative", "-z", "HEAD") ?? git("ls-files", "-z", "-m", "-d") ?? [];
        const all = [...new Set([...changed, ...(git("ls-files", "-z", "-o", "--exclude-standard") ?? [])].flatMap((f) => { const x = this.rel(f); return x ? [x] : []; }))];
        if (all.length > EXPANDED_KEPT) this.expandedCut.add(p);
        files = all.slice(0, EXPANDED_KEPT);
        this.expanded.set(p, files);
      }
      return files;
    });
  }

  /** Observe `file`; a change becomes a transition, credited to `by` only when the caller has effect evidence. */
  private observe(file: string, by?: { peer: PeerId; expected: string }): Version {
    const now = this.load(file);
    const was = this.latest.get(file);
    if (was && was.hash === now.hash) return was;
    const version = { ...now, seq: ++this.seq };
    this.latest.set(file, version);
    if (was) {
      const credited = by && by.expected === now.hash ? by.peer : undefined;
      const task = credited ? this.o.scope(credited)?.task : undefined;
      const list = this.transitions.get(file) ?? [];
      list.push({ to: now.hash, seq: version.seq, ...(credited ? { by: credited } : {}), ...(task ? { task } : {}) });
      if (list.length > TRANSITIONS_KEPT) this.evicted.set(file, list.shift()!.seq);
      this.transitions.set(file, list);
    }
    return version;
  }

  private view(peer: PeerId): Map<string, Version> {
    let m = this.accepted.get(peer);
    if (!m) this.accepted.set(peer, (m = new Map()));
    return m;
  }

  /** Everything any peer's facts cover, observed: a shell command or an unreported write may have changed any of it. */
  private observeAll(): void {
    for (const file of new Set(this.o.peers().flatMap((p) => this.files(p)))) this.observe(file);
  }

  /**
   * Claude is about to run a tool. Its target is observed now, so the tool's effect can be checked afterwards; a read
   * or a first look at a file also observes it.
   */
  preTool(peer: PeerId, toolUseId: string | undefined, tool: string, input: Record<string, unknown>): void {
    this.boundary();
    const path = [input.file_path, input.notebook_path].find((p): p is string => typeof p === "string");
    const file = path ? this.rel(path) : undefined;
    const version = file ? this.observe(file) : undefined;
    if (toolUseId) {
      this.before.set(toolUseId, { peer, ...(file ? { file } : {}), ...(version ? { version } : {}) });
      if (this.before.size > 256) this.before.delete(this.before.keys().next().value as string);
    }
  }

  /**
   * Claude's tool ran. An Edit, MultiEdit or Write whose result is exactly its input applied to the file as observed
   * before is Claude's change, and if Claude had acknowledged that earlier state its view moves on. A full Read moves
   * its view to what it read. Anything else, a Bash command included, is observed with its attribution unknown.
   */
  postTool(peer: PeerId, toolUseId: string | undefined, tool: string, input: Record<string, unknown>): void {
    this.boundary();
    const pre = toolUseId ? this.before.get(toolUseId) : undefined;
    if (toolUseId) this.before.delete(toolUseId);
    const file = pre?.file;
    if (file && pre?.version) {
      this.touch(peer, file, pre.version);
      if (["Edit", "MultiEdit", "Write"].includes(tool)) {
        const expected = this.latest.get(file)?.hash === pre.version.hash ? applyEdit(pre.version.text, tool, input) : undefined;
        const version = this.observe(file, expected === undefined ? undefined : { peer, expected: sha1(expected) });
        const last = this.transitions.get(file)?.at(-1);
        if (last?.seq === version.seq && last.by === peer && this.view(peer).get(file)?.hash === pre.version.hash) this.view(peer).set(file, version);
        return this.observeAll();
      }
      if (tool === "Read") {
        const version = this.observe(file);
        // Only a whole read of an unchanged file says what the peer saw: no offset or limit, and nothing Read cuts.
        if (version.hash === pre.version.hash && input.offset === undefined && input.limit === undefined && readWhole(pre.version.text)) this.view(peer).set(file, version);
        return this.observeAll();
      }
    }
    this.observeAll();
  }

  /**
   * A Codex item completed. A file change whose diff is exactly what changed since the last observation is Codex's.
   * A read only brings the file into its scope: a read action can be partial (`sed -n 1,5p`), so it never says what
   * Codex saw. Any other command, a move, and any change that does not match are observed with attribution unknown.
   */
  // any: an app-server item is untyped JSON; every field is checked before use.
  codexItem(peer: PeerId, item: any): void {
    this.boundary();
    if (item?.type === "fileChange" && item.status !== "failed" && item.status !== "declined") {
      for (const change of Array.isArray(item.changes) ? item.changes : []) {
        const moved = typeof change?.kind?.move_path === "string" ? this.rel(change.kind.move_path) : undefined;
        if (moved) this.touch(peer, moved);
        const file = typeof change?.path === "string" ? this.rel(change.path) : undefined;
        if (!file) continue;
        const was = this.latest.get(file);
        this.touch(peer, file, was);
        const now = this.load(file);
        const matches = was ? codexEffect(was.text, now, change, (a, b) => this.diff(a, b)) : false;
        const version = this.observe(file, matches ? { peer, expected: now.hash } : undefined);
        const last = this.transitions.get(file)?.at(-1);
        if (was && last?.seq === version.seq && last.by === peer && this.view(peer).get(file)?.hash === was.hash) this.view(peer).set(file, version);
      }
    } else if (item?.type === "commandExecution") {
      const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
      for (const action of actions) {
        if (action?.type !== "read" || typeof action.path !== "string") continue;
        const file = this.rel(action.path);
        if (file) this.touch(peer, file, this.observe(file));
      }
    }
    this.observeAll();
  }

  /**
   * The fact due for `peer` at a boundary, recorded as an offer, or undefined. Nothing moves until it is acknowledged:
   * a later boundary offers everything since the peer's last acknowledged view again.
   */
  due(peer: PeerId, toolUseId?: string): Offered | undefined {
    this.boundary();
    const scope = this.o.scope(peer);
    if (!scope) return undefined;
    const view = this.view(peer);
    const parts: string[] = [];
    const offered = new Map<string, Version>();
    let shown = 0;
    let cut = 0;
    let files = 0;
    let unknown = 0;
    let unnamed = 0;
    const cutFiles: string[] = [];
    const firstLooks: string[] = [];
    for (const file of this.files(peer, scope)) {
      const now = this.observe(file);
      const was = view.get(file) ?? this.firstSeen.get(peer)?.get(file);
      if (!was) {
        firstLooks.push(file);
        offered.set(file, now); // what the peer sees from here on; nothing to compare with
        continue;
      }
      if (was.hash === now.hash) {
        if (!view.has(file)) offered.set(file, now); // unchanged since it was touched: its first look
        continue;
      }
      const since = (this.transitions.get(file) ?? []).filter((t) => t.seq > was.seq);
      const capped = (this.evicted.get(file) ?? -1) > was.seq; // the cap dropped part of its history
      if (!capped && since.length && since.every((t) => t.by === peer)) {
        view.set(file, now); // its own verified writes, nothing else
        continue;
      }
      offered.set(file, now);
      if (!this.o.nameable(file)) {
        unnamed++;
        continue;
      }
      files++;
      const others = [...new Set(since.filter((t) => t.by && t.by !== peer).map((t) => t.by!))];
      const blind = capped || !since.length || since.some((t) => !t.by);
      if (blind) unknown++;
      const credit = since.filter((t) => t.by && t.by !== peer).at(-1);
      const own = since.some((t) => t.by === peer);
      let who = `changed by ${others.join(" and ")}${others.length === 1 && credit?.task ? ` for task #${credit.task.id} ${JSON.stringify(credit.task.title)}` : ""}${own ? " (your own writes are included)" : ""}`;
      if (blind) who = `changed, attribution unknown (concurrent or unreported writes${others.length ? `; ${others.join(", ")} also wrote it` : ""}${own ? "; your own writes are included" : ""})`;
      let state = "";
      if (was.hash === "missing") state = " (created)";
      else if (now.hash === "missing") state = " (deleted)";
      parts.push(`${file}${state}, ${who}:`);
      if ((was.text === undefined && was.hash !== "missing") || (now.text === undefined && now.hash !== "missing")) {
        parts.push("  (too large to show; read the file)");
        continue;
      }
      const lines = this.diff(was.text ?? "", now.text ?? "");
      // The diff goes to a cloud model: text that matches a PII pattern stays on this machine (#69), the file is named.
      if (!this.o.nameable(lines.join("\n"))) {
        parts.push("  (not shown: the change matches a private-data pattern; read the file)");
        continue;
      }
      let cutHere = false;
      for (const line of lines) {
        const changed = /^[+-]/.test(line);
        if (shown >= MAX_LINES) {
          if (changed) {
            cut++;
            cutHere = true;
          }
          continue;
        }
        if (changed) shown++;
        parts.push(line);
      }
      if (cutHere) cutFiles.push(file);
    }
    if (cut) parts.push(`(${cut} more changed line(s) not shown; read ${cutFiles.join(", ")})`);
    if (unnamed) parts.push(`${unnamed} more changed file(s) in your scope, not named here: their names match a private-data pattern`);
    const cutDirs = [...this.expandedCut].filter(this.o.nameable);
    if (cutDirs.length) parts.push(`more than ${EXPANDED_KEPT} files changed under ${cutDirs.join(", ")}: the rest are not shown; check them yourself`);
    const plans = new Map<number, string>();
    const seen = this.plansAccepted.get(peer) ?? new Map<number, string>();
    for (const p of scope.plans) {
      if (seen.get(p.task) === p.text) continue;
      plans.set(p.task, p.text);
      parts.push(`task #${p.task} (owner ${p.owner}) plan: ${p.text}`);
    }
    // Work that began before tracking did (a hub restart, a PII pause, a new session) is not covered: say so, once.
    let coverage = false;
    if (!this.covered.has(peer) && scope.since !== undefined && scope.since < this.epoch) {
      const named = this.files(peer, scope).filter(this.o.nameable);
      if (named.length) {
        parts.unshift(`tracking started at ${new Date(this.epoch).toISOString()}: changes before that are not covered; read ${named.join(", ")} before relying on what you saw of them`);
        coverage = true;
      }
    }
    // Files that fell out of what is tracked are named once, not dropped silently.
    const gone = [...(this.untracked.get(peer) ?? [])].filter(this.o.nameable);
    if (gone.length) {
      parts.push(`no longer tracked (more than ${TOUCHED_KEPT} files touched): ${gone.join(", ")}; read them again before relying on what you saw of them`);
      this.untracked.delete(peer);
      coverage = true;
    }
    if (!parts.length) {
      // Nothing to say: a first look needs no acknowledgement.
      for (const [file, v] of offered) if (!view.has(file)) view.set(file, v);
      return undefined;
    }
    return this.offer(peer, parts, offered, plans, toolUseId, { files, plans: plans.size, unknown, coverage });
  }

  /** The plans of these tasks were shown in a tool result (an accept's answer): they need no fact later. */
  sawPlans(peer: PeerId, tasks: number[]): void {
    const seen = this.plansAccepted.get(peer) ?? new Map<number, string>();
    for (const p of this.o.scope(peer)?.plans ?? []) if (tasks.includes(p.task)) seen.set(p.task, p.text);
    this.plansAccepted.set(peer, seen);
  }

  /**
   * One hash over these project paths and the files these peers touched, as they are now: an integration target (issue
   * #107). A directory counts by git's changed, new and deleted files under it, with the commit they are relative to.
   */
  tree(paths: string[], peers: PeerId[] = []): string {
    this.boundary();
    const h = createHash("sha1");
    const head = Bun.spawnSync(["git", "rev-parse", "-q", "--verify", "HEAD"], { cwd: this.root, stdout: "pipe", stderr: "pipe" });
    h.update(head.exitCode === 0 ? head.stdout.toString().trim() : "no-head").update("\0");
    // The files the members touched count too: a symbol-only overlap names no path, and an edit outside the named
    // paths still moves the work the integration checked.
    const touched = peers.flatMap((p) => this.touched.get(p) ?? []);
    const files = [...new Set([...this.expand(paths.flatMap((p) => { const r = this.rel(p); return r ? [r] : []; })), ...touched])].sort();
    for (const file of files) h.update(file).update("\0").update(this.load(file).hash).update("\0");
    return h.digest("hex");
  }

  /** Whether `peer` has acknowledged every file its facts cover, as it is now (a file it never looked at counts). */
  current(peer: PeerId): boolean {
    this.boundary();
    const view = this.accepted.get(peer);
    return this.files(peer).every((f) => {
      const v = view?.get(f);
      return !v || v.hash === this.observe(f).hash;
    });
  }

  /** A one-line offer that proves the context path works before any coordination depends on it (issue #108). */
  probe(peer: PeerId, toolUseId?: string): Offered {
    return this.offer(peer, ["context check: nothing to act on"], new Map(), new Map(), toolUseId, { files: 0, plans: 0, unknown: 0, coverage: false, probe: true });
  }

  private offer(peer: PeerId, parts: string[], files: Map<string, Version>, plans: Map<number, string>, toolUseId: string | undefined, counts: { files: number; plans: number; unknown: number; coverage: boolean; probe?: boolean }): Offered {
    const id = `${this.o.instance}-${++this.n}`;
    const text = sanitize([factsHeader(id), ...parts].join("\n"));
    const list = this.offers.get(peer) ?? [];
    list.push({ id, seq: this.seq, at: Date.now(), files, plans, ...(toolUseId ? { toolUseId } : {}), ...(counts.probe ? { probe: true } : {}) });
    if (list.length > OFFERS_KEPT) list.shift();
    this.offers.set(peer, list);
    return { id, text, files: counts.files, plans: counts.plans, unknown: counts.unknown, bytes: Buffer.byteLength(text), ...(counts.probe ? { probe: true } : {}), ...(counts.coverage ? { coverage: true } : {}) };
  }

  /** Offers not acknowledged yet, oldest first: their readback is still to be found. */
  pending(peer: PeerId): { id: string; at: number; toolUseId?: string; probe?: boolean }[] {
    return (this.offers.get(peer) ?? []).map((o) => ({ id: o.id, at: o.at, ...(o.toolUseId ? { toolUseId: o.toolUseId } : {}), ...(o.probe ? { probe: true } : {}) }));
  }

  /**
   * The peer's context holds offer `id` (a readback found it). Its view moves to what the offer showed, never back;
   * older offers are covered by it. Returns when the offer was made, or undefined for an id this run never offered.
   */
  ack(peer: PeerId, id: string): { at: number; probe?: boolean } | undefined {
    const list = this.offers.get(peer) ?? [];
    const i = list.findIndex((o) => o.id === id);
    if (i === -1) return undefined;
    const offer = list[i]!;
    const view = this.view(peer);
    for (const [file, v] of offer.files) {
      if ((view.get(file)?.seq ?? -1) < v.seq) view.set(file, v);
      this.firstSeen.get(peer)?.delete(file);
    }
    const seen = this.plansAccepted.get(peer) ?? new Map<number, string>();
    for (const [task, text] of offer.plans) seen.set(task, text);
    this.plansAccepted.set(peer, seen);
    if (offer.files.size || !offer.probe) this.covered.add(peer);
    list.splice(0, i + 1);
    return { at: offer.at, ...(offer.probe ? { probe: true } : {}) };
  }

  /** The hunks between two texts (`git diff --no-index`), without its file headers. */
  private diff(before: string, after: string): string[] {
    mkdirSync(this.o.tmp, { recursive: true, mode: 0o700 });
    const a = join(this.o.tmp, `${randomUUID()}.a`);
    const b = join(this.o.tmp, `${randomUUID()}.b`);
    try {
      writeFileSync(a, before, { mode: 0o600 });
      writeFileSync(b, after, { mode: 0o600 });
      const r = Bun.spawnSync(["git", "-c", "core.quotepath=off", "diff", "--no-index", "--no-color", "--no-ext-diff", "--unified=2", "--", a, b], { stdout: "pipe", stderr: "pipe" });
      const lines = r.stdout.toString().split("\n");
      const start = lines.findIndex((l) => l.startsWith("@@"));
      if (start === -1) return [];
      const hunks = lines.slice(start);
      if (hunks.at(-1) === "") hunks.pop();
      return hunks;
    } finally {
      rmSync(a, { force: true });
      rmSync(b, { force: true });
    }
  }
}

const sha1 = (text: string) => createHash("sha1").update(Buffer.from(text, "utf8")).digest("hex");

/** Whether Claude Code's default Read returns all of this text. */
function readWhole(text: string | undefined): boolean {
  if (text === undefined) return false;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length <= READ_LINES && lines.every((l) => l.length <= READ_LINE_CHARS);
}

/** A Claude Edit, MultiEdit or Write applied to `text`, or undefined when its effect cannot be computed exactly. */
export function applyEdit(text: string | undefined, tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === "Write") return typeof input.content === "string" ? input.content : undefined;
  if (text === undefined) return undefined;
  const one = (t: string, e: Record<string, unknown>): string | undefined => {
    const from = e.old_string, to = e.new_string;
    if (typeof from !== "string" || typeof to !== "string" || !from) return undefined;
    if (e.replace_all === true) return t.includes(from) ? t.split(from).join(to) : undefined;
    const at = t.indexOf(from);
    return at === -1 || t.indexOf(from, at + 1) !== -1 ? undefined : t.slice(0, at) + to + t.slice(at + from.length);
  };
  if (tool === "Edit") return one(text, input);
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    let out: string | undefined = text;
    for (const e of input.edits) out = out === undefined || !e || typeof e !== "object" ? undefined : one(out, e as Record<string, unknown>);
    return out;
  }
  return undefined;
}

/** The changed lines of a unified diff, `+` and `-` kept, hunk headers and context dropped, as a sorted list. */
function changedLines(lines: string[]): string[] {
  return lines.filter((l) => /^[+-]/.test(l)).sort();
}

/**
 * Whether a Codex file change explains exactly what changed: an update's changed lines equal the observed diff's, an
 * add's content is the file, a delete left nothing. Anything else is not evidence.
 */
// any: a file change from an untyped app-server item; every field is checked before use.
export function codexEffect(before: string | undefined, now: { hash: string; text?: string }, change: any, diff: (a: string, b: string) => string[]): boolean {
  const kind = change?.kind?.type ?? change?.kind;
  const patch: string | undefined = typeof change?.diff === "string" ? change.diff : undefined;
  if (kind === "delete") return now.hash === "missing";
  if (now.text === undefined) return false;
  if (kind === "add") return patch !== undefined && (now.text === patch || now.text === `${patch}\n` || `${now.text}\n` === patch);
  if (kind !== "update" || patch === undefined || before === undefined || change?.kind?.move_path) return false;
  const reported = changedLines(patch.split("\n").filter((l) => !l.startsWith("+++ ") && !l.startsWith("--- ")));
  const observed = changedLines(diff(before, now.text));
  return reported.length > 0 && reported.length === observed.length && reported.every((l, i) => l === observed[i]);
}
