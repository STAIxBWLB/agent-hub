import { KINDS, MemoryStore, type Kind, type Tier, type View } from "../memory/store.ts";
import { memoryProjectKey, promotionScreen, withoutPii } from "../memory/recall.ts";
import { currentRouting } from "../hub/routing.ts";
import { loadConfig } from "../hub/daemon.ts";

/** The project's config, or none when there is no valid one (reading memory needs none). */
const loadConfigSafe = (cwd: string) => { try { return loadConfig(cwd); } catch { return undefined; } };

/**
 * #258: `ahub memory`, straight on the machine's store (no hub needed). Reading is anyone's; promote, demote, forget,
 * supersede and rebuild are a person's (the identity gate refuses agent shells).
 */
export const MEMORY_USAGE = "usage: ahub memory [list] [--tier short|long] [--kind <kind>] [--peer <p>] [--machine <id>] [--since <iso>] [--limit N] | search <words> | show <id> | graph <id|node> [--hops 1|2] | promote|demote|forget <id> | supersede <old> <new> | rebuild  [--json]";

const fail = (message: string): never => { throw new Error(message); };
const one = (v: View) => `${v.id.slice(0, 8)}  ${v.at.slice(0, 16).replace("T", " ")}  ${v.tier.padEnd(5)} ${v.kind.padEnd(8)} ${v.peer.padEnd(8)} ${v.scope === "shared" ? "shared " : ""}${`${v.title ? `${v.title}: ` : ""}${v.text}`.replace(/\s+/g, " ").slice(0, 100)}${v.supersededBy ? `  (superseded by ${v.supersededBy.slice(0, 8)})` : ""}`;
function detail(v: View): string[] {
  return [`${v.id}  ${v.kind}, ${v.tier}-term${v.expiresAt ? ` until ${v.expiresAt}` : ""}, ${v.scope}`, `by ${v.peer} on machine ${v.machine}, ${v.at}, project ${v.project}${v.task ? `, task ${v.task}` : ""}`,
    ...(v.promotedFrom ? [`promoted from ${v.promotedFrom}`] : []), ...(v.supersededBy ? [`superseded by ${v.supersededBy}`] : []), ...(v.about.length ? [`about: ${v.about.join(", ")}`] : []), "", ...(v.title ? [v.title] : []), v.text];
}

export function memoryCommand(args: string[], cwd: string, opts: { store?: MemoryStore } = {}): string {
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const flag = (name: string) => { const i = rest.indexOf(name); if (i < 0) return undefined; const v = rest[i + 1] ?? fail(`${name} needs a value`); rest.splice(i, 2); return v; };
  const sub = rest[0] && !rest[0].startsWith("--") ? rest.shift()! : "list";
  // The project's private paths (`pii.paths`): a note about one is withheld like a note matching a PII pattern. A config
  // that does not load fails the read closed: its privacy policy is not dropped for agent-readable output.
  const privatePaths = (): string[] => { try { return loadConfig(cwd).pii?.paths ?? []; } catch (e) { return fail(`the project's config does not load (${(e as Error).message}); fix it before reading hub memory`); } };
  // A store opened here promotes this project's notes only through its current policy (privatePaths fails closed).
  // The project's own short-term lifetime, so a deadline this command writes (a demotion) matches what its hub would write.
  const store = opts.store ?? new MemoryStore({ ttlMs: (loadConfigSafe(cwd)?.memory.short_ttl_days ?? 14) * 24 * 3600_000, screen: promotionScreen(memoryProjectKey(cwd), cwd, () => currentRouting(cwd), () => privatePaths()) });
  const actor = "user";
  const project = memoryProjectKey(cwd);
  const need = (v: View | undefined, id: string) => v ?? fail(`no memory entry ${id} (ahub memory list shows the ids)`);
  try {
    switch (sub) {
      case "list": case "search": {
        const tier = flag("--tier"), kind = flag("--kind"), peer = flag("--peer"), machine = flag("--machine"), since = flag("--since"), limit = flag("--limit");
        if (since !== undefined && Number.isNaN(Date.parse(since))) fail(`--since needs a date or time (ISO 8601), not ${since}`);
        if (tier && tier !== "short" && tier !== "long") fail("--tier takes short or long");
        if (kind && !KINDS.includes(kind as Kind)) fail(`--kind takes ${KINDS.join(", ")}`);
        if (limit && !(Number(limit) > 0)) fail("--limit takes a positive number");
        const q = sub === "search" ? rest.join(" ") || fail("usage: ahub memory search <words>") : rest.length ? fail(MEMORY_USAGE) : undefined;
        // Agent shells may run this: notes are screened under this project's current PII policy, as briefs and recall are
        // (a shared note was accepted under another project's patterns). The dashboard shows a person everything.
        const all = store.list({ project, ...(tier ? { tier: tier as Tier } : {}), ...(kind ? { kind: kind as Kind } : {}), ...(peer ? { peer } : {}), ...(machine ? { machine } : {}), ...(since ? { since } : {}), ...(q ? { q } : {}), limit: Number.MAX_SAFE_INTEGER });
        // Screened first, then cut to the limit: withheld entries never crowd out readable ones.
        const readable = withoutPii(all, currentRouting(cwd), cwd, privatePaths()), rows = readable.slice(0, limit ? Number(limit) : 50);
        if (json) return JSON.stringify(rows, null, 2);
        const c = store.counts(project);
        const withheld = all.length - readable.length;
        return [`hub memory for ${project} on machine ${c.machine.label}: ${c.long} long-term, ${c.short} short-term`, ...(rows.length ? rows.map(one) : ["(nothing)"]),
          ...(withheld ? [`(${withheld} withheld: they match a PII pattern; the dashboard shows them)`] : [])].join("\n");
      }
      case "show": {
        const id = rest[0] ?? fail("usage: ahub memory show <id>");
        const v = need(store.get(id, project), id);
        if (!withoutPii([v], currentRouting(cwd), cwd, privatePaths()).length) fail(`${v.id.slice(0, 8)} is withheld: it matches a PII pattern (the dashboard shows it)`);
        return json ? JSON.stringify(v, null, 2) : detail(v).join("\n");
      }
      case "graph": {
        const hops = Number(flag("--hops") ?? 1);
        if (hops !== 1 && hops !== 2) fail("--hops takes 1 or 2");
        const start = rest[0] ?? fail("usage: ahub memory graph <id|node>");
        const node = start.includes(":") && !start.startsWith("mem:") ? start : `mem:${need(store.get(start, project), start).id}`;
        const g = store.graph(project, node, hops);
        return json ? JSON.stringify(g, null, 2) : [`${g.nodes.length} nodes, ${g.edges.length} edges around ${node}`, ...g.edges.map((e) => `${e.from} -${e.rel}-> ${e.to}`)].join("\n");
      }
      case "promote": { const v = need(store.get(rest[0] ?? fail(MEMORY_USAGE), project), rest[0]!); if (v.supersededBy) fail(`${v.id.slice(0, 8)} is replaced by ${v.supersededBy.slice(0, 8)}: promote that one instead`); const id = store.promote(v.id, actor, project) ?? fail(v.project !== project ? `${v.id.slice(0, 8)} is another project's note: promote it from that project` : `${v.id.slice(0, 8)} stays short-term: it holds a secret, matches a PII pattern or is about a private path`); return id === v.id ? `${v.id.slice(0, 8)} is already long-term` : `promoted to long-term as ${id.slice(0, 8)}`; }
      case "demote": { const v = need(store.get(rest[0] ?? fail(MEMORY_USAGE), project), rest[0]!); if (v.tier !== "long") return `${v.id.slice(0, 8)} is already short-term`; store.demote(v.id, actor, project); return `demoted ${v.id.slice(0, 8)}: it expires ${store.get(v.id, project)?.expiresAt ?? "with its short-term lifetime"}`; }
      case "forget": { const v = need(store.forget(rest[0] ?? fail(MEMORY_USAGE), actor, project), rest[0]!); return `forgot ${v.id.slice(0, 8)}${v.local ? "" : "; it stays in the sync remote's git history until a person rewrites it (docs/memory.md)"}`; }
      case "supersede": {
        if (rest.length !== 2) fail("usage: ahub memory supersede <old> <new>");
        return store.supersede(rest[0]!, rest[1]!, actor, project) ? `${rest[0]} is superseded by ${rest[1]}` : fail("both ids must name different entries, and the newer one must reach as far: shared for a shared entry, long-term for a long-term one (ahub memory promote it first)");
      }
      case "rebuild": { store.rebuild(); const c = store.counts(); return `rebuilt the index from ${c.segments} segment${c.segments === 1 ? "" : "s"}: ${c.long} long-term, ${c.short} short-term entries`; }
      default: return fail(MEMORY_USAGE);
    }
  } finally { if (!opts.store) store.close(); }
}
