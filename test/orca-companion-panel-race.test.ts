import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

// Run the actual panel script with only DOM/host ports replaced. No Orca, CLI, browser, storage or real timers.
class Element {
  children: Element[] = [];
  textContent = "";
  className = "";
  type = "";
  disabled = false;
  hidden = false;
  attributes = new Map<string, string>();
  listeners = new Map<string, () => unknown>();
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(event: string, listener: () => unknown) { this.listeners.set(event, listener); }
  click() { return Promise.resolve(this.listeners.get("click")?.()); }
}
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const workspaces = ["a", "b"].map(id => ({ id, name: id, branch: "main", root: `/fixture/${id}`, hostId: "local", kind: "worktree", selectable: true }));
function fixture() {
  const elements = new Map(["rows", "status", "link", "refresh", "dashboard", "console", "family"].map(id => [id, new Element()]));
  for (const id of ["dashboard", "console", "family"]) elements.get(id)!.disabled = true;
  elements.get("link")!.hidden = true;
  const requests: { name: string; input: any; reply: ReturnType<typeof deferred> }[] = [];
  const external: { url: string; reply: ReturnType<typeof deferred> }[] = [];
  const timers = new Map<number, () => void>(); let nextTimer = 0;
  const context = createContext({
    document: { getElementById: (id: string) => elements.get(id), createElement: () => new Element() },
    orca: { plugin: { request(name: string, input: unknown) { const reply = deferred(); requests.push({ name, input, reply }); return reply.promise; } },
      shell: { openExternal(url: string) { const reply = deferred(); external.push({ url, reply }); return reply.promise; } } },
    setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  const html = readFileSync(join(import.meta.dir, "../integrations/orca/panel/index.html"), "utf8");
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script || !/\nrefresh\(\);\s*$/.test(script)) throw Error("actual panel entry point missing");
  // Expose only the initial call's completion, without changing any panel decision or asynchronous branch.
  runInContext(script.replace(/\nrefresh\(\);\s*$/, "\nglobalThis.initialRefresh = refresh();"), context);
  const get = (id: string) => elements.get(id)!;
  const choose = (index: number) => get("rows").children[index]!.children.at(-1)!.click();
  const state = () => runInContext("({selected, pendingLink, generation})", context) as { selected: { id: string } | null; pendingLink: string | null; generation: number };
  const initial = async () => { requests[0]!.reply.resolve({ ok: true, rows: workspaces }); await context.initialRefresh; };
  return { requests, external, timers, get, choose, state, initial };
}
const linkReply = { ok: true, status: "link", url: "http://127.0.0.1:43111/auth?ticket=fixture-only" };
function noLink(f: ReturnType<typeof fixture>) {
  expect(f.state().pendingLink).toBeNull(); expect(f.get("link").hidden).toBe(true); expect(f.timers.size).toBe(0);
}

for (const result of ["link", "terminal", "refusal", "error"] as const) test(`actual Orca panel discards delayed A ${result} after B selection, including finally`, async () => {
  const f = fixture(); await f.initial(); await f.choose(0);
  const first = f.get("dashboard").click(), a = f.requests.at(-1)!;
  expect(a.name).toBe("entry.open"); expect(a.input.snapshot.id).toBe("a"); expect(Object.isFrozen(a.input.snapshot)).toBe(true);
  await f.choose(1);
  const second = f.get("console").click(), b = f.requests.at(-1)!;
  expect(b.input.snapshot.id).toBe("b"); expect(a.input.snapshot.id).toBe("a");
  if (result === "error") a.reply.reject(Error("fixture failure"));
  else a.reply.resolve(result === "link" ? linkReply : result === "terminal" ? { ok: true, status: "terminal_created" } : { ok: false, guidance: "OLD A FAILURE", command: "old command" });
  await first;
  expect(f.state().selected?.id).toBe("b"); expect(f.get("status").textContent).toBe("Opening...");
  for (const id of ["dashboard", "console", "family"]) expect(f.get(id).disabled).toBe(true);
  noLink(f); expect(f.external).toEqual([]);
  b.reply.resolve({ ok: true, status: "terminal_created" }); await second;
  expect(f.get("status").textContent).toContain("A terminal was created"); expect(f.get("console").disabled).toBe(false);
});

test("actual panel refresh invalidates selection immediately and rejects a late dashboard ticket", async () => {
  const f = fixture(); await f.initial(); await f.choose(0);
  const opening = f.get("dashboard").click(), old = f.requests.at(-1)!;
  const refresh = f.get("refresh").click(), listing = f.requests.at(-1)!;
  expect(f.state().selected).toBeNull(); expect(f.get("console").disabled).toBe(true);
  old.reply.resolve(linkReply); await opening;
  expect(f.get("status").textContent).toBe("Reading Orca's workspaces..."); noLink(f);
  listing.reply.resolve({ ok: true, rows: workspaces }); await refresh; await f.choose(1);
  expect(f.state().selected?.id).toBe("b"); expect(f.get("status").textContent).toBe("Selected. Choose a screen to open.");
});

test("a new open invalidates the previous request even for the same selection", async () => {
  const f = fixture(); await f.initial(); await f.choose(0);
  const first = f.get("dashboard").click(), old = f.requests.at(-1)!;
  const second = f.get("family").click(), current = f.requests.at(-1)!;
  old.reply.resolve(linkReply); await first;
  expect(f.get("status").textContent).toBe("Opening..."); expect(f.get("family").disabled).toBe(true); noLink(f);
  current.reply.resolve({ ok: true, status: "terminal_created" }); await second;
  expect(f.get("status").textContent).toContain("A terminal was created");
});

test("an expired old link callback and delayed external-open reply cannot alter the new selection", async () => {
  const f = fixture(); await f.initial(); await f.choose(0);
  const opening = f.get("dashboard").click(); f.requests.at(-1)!.reply.resolve(linkReply); await opening;
  expect(f.get("link").hidden).toBe(false); const oldTimer = [...f.timers.values()][0]!;
  const navigation = f.get("link").click(); expect(f.external.map(value => value.url)).toEqual([linkReply.url]);
  await f.choose(1); const current = f.get("console").click();
  oldTimer(); f.external[0]!.reply.resolve({ opened: true }); await navigation;
  expect(f.get("status").textContent).toBe("Opening..."); expect(f.get("console").disabled).toBe(true); noLink(f);
  f.requests.at(-1)!.reply.resolve({ ok: true, status: "terminal_created" }); await current;
  expect(f.get("status").textContent).toContain("A terminal was created");
});

test("a delayed failed refresh cannot erase a newer refresh and its selection", async () => {
  const f = fixture(); await f.initial();
  const oldRefresh = f.get("refresh").click(), old = f.requests.at(-1)!;
  const freshRefresh = f.get("refresh").click(); f.requests.at(-1)!.reply.resolve({ ok: true, rows: workspaces }); await freshRefresh;
  await f.choose(1); old.reply.reject(Error("fixture failure")); await oldRefresh;
  expect(f.get("rows").children).toHaveLength(2); expect(f.state().selected?.id).toBe("b");
  expect(f.get("status").textContent).toBe("Selected. Choose a screen to open."); expect(f.get("console").disabled).toBe(false); noLink(f);
});
