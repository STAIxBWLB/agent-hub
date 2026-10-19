import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerPrintPeer, type ReviewerBackend, type ReviewerLaunch, type ReviewerPrintOptions } from "../src/adapters/reviewer-print.ts";
import { stopOwnedProcess } from "../src/hub/child-process.ts";
import { HUB, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../src/hub/peers.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-lifecycle-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}
const review = () => newEnvelope(HUB, "Review the fixture task", {
  kind: "review", to: ["fixture-review"], refs: { task: "71", commit: "a".repeat(40), reviewRevision: "3" },
});
function launch(root: string, marker: string): ReviewerLaunch {
  return {
    command: [process.execPath, "-e", `await new Response(Bun.stdin.stream()).text();await Bun.write(${JSON.stringify(marker)},"model-started");process.stdout.write('{"type":"fixture-completed"}\\n');`],
    args: [], cwd: root,
    isolation: { backend: "fixture", version: "fixture", binary: process.execPath, profile: "fixture-only",
      readOnly: true, strictMcp: true, ephemeral: true, evidence: ["short owned fixture; no native isolation claim"] },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("review admission revoked during preparation prevents model spawn and cleans owned preparation", async () => {
  const base = scratch(), marker = join(base, "model-started"), receipts: DeliveryReceipt[] = [];
  let allowed = true, preparing = false, preparations = 0, reviewRoot: string | undefined, closed = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const backend: ReviewerBackend = { id: "fixture", taskMcp: true, prepare: async () => {
    const root = mkdtempSync(join(base, "private-"));
    if (++preparations > 1) { reviewRoot = root; preparing = true; await held; }
    return launch(root, marker);
  } };
  // The intersection keeps this red regression type-safe before the optional host port is added.
  const options: ReviewerPrintOptions & { admit(env: Envelope): boolean } = {
    cwd: base, mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 5000, backend,
    verdictSince: () => false, admit: () => allowed,
    taskMcp: () => ({ config: "{}", close: () => { closed++; } }),
  };
  const peer = new ReviewerPrintPeer("fixture-review", options);
  cleanup.push(() => peer.stop("fixture teardown"));
  cleanup.push(() => release());
  peer.onDelivery = receipt => receipts.push(receipt);
  await peer.start();
  await peer.deliver([review()], "admission-drift");
  await until(() => preparing);
  expect(existsSync(reviewRoot!)).toBe(true);
  allowed = false;
  release();
  await until(() => peer.state === "idle");
  expect(closed).toBe(1);
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(reviewRoot!)).toBe(false);
  expect(peer.reviewToken(71)).toBeUndefined();
  const settled = receipts.filter(receipt => receipt.state !== "accepted");
  expect(settled).toHaveLength(1);
  expect(["failed_safe", "needs_review"]).toContain(settled[0]!.state);
  expect(receipts.some(receipt => receipt.state === "completed")).toBe(false);
});

test("unconfirmed group cleanup retains private root until a later successful stop", async () => {
  const base = scratch(), marker = join(base, "model-started"), receipts: DeliveryReceipt[] = [];
  let preparations = 0, confirmations = 0, reviewRoot: string | undefined;
  const backend: ReviewerBackend = { id: "fixture", prepare: async () => {
    const root = mkdtempSync(join(base, "private-"));
    const prepared = launch(root, marker);
    if (++preparations === 1) return prepared; // startup has its own cleanup, not the review's state
    reviewRoot = root;
    return { ...prepared, stop: async child => {
      // A real short child has exited; simulate an uncertain first group confirmation.
      await stopOwnedProcess(child, { group: true });
      if (++confirmations === 1) throw new Error("fixture first group confirmation unavailable");
    } };
  } };
  const peer = new ReviewerPrintPeer("fixture-review", {
    cwd: base, mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 5000, backend, verdictSince: () => false,
  });
  cleanup.push(() => peer.stop("fixture teardown"));
  peer.onDelivery = receipt => receipts.push(receipt);
  await peer.start();
  await peer.deliver([review()], "cleanup-unconfirmed");
  await until(() => confirmations === 1 && receipts.some(receipt => receipt.state === "needs_review"));
  expect(existsSync(marker)).toBe(true);
  expect(peer.state).toBe("busy");
  expect(peer.reviewToken(71)).toBeUndefined();
  expect(existsSync(reviewRoot!)).toBe(true);
  await peer.stop("person requested stop");
  expect(confirmations).toBe(2);
  expect(peer.state).toBe("offline");
  expect(existsSync(reviewRoot!)).toBe(false);
  expect(receipts.some(receipt => receipt.state === "completed")).toBe(false);
});

test("running native policy drift revokes authority immediately and stays latched", async () => {
  const base = scratch(), marker = join(base, "policy-model-started"), receipts: DeliveryReceipt[] = [];
  let current = true, preparations = 0, reviewRoot: string | undefined, closed = 0;
  const backend: ReviewerBackend = { id: "fixture", taskMcp: true, prepare: async () => {
    const root = mkdtempSync(join(base, "private-"));
    const prepared = launch(root, marker);
    if (++preparations === 1) return prepared;
    reviewRoot = root;
    return { ...prepared, watchCurrent: true, current: () => current,
      command: [process.execPath, "-e", `await new Response(Bun.stdin.stream()).text();await Bun.write(${JSON.stringify(marker)},"ready");setInterval(()=>{},1000);`] };
  } };
  const peer = new ReviewerPrintPeer("fixture-review", { cwd: base, mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 5000, backend, verdictSince: () => false, taskMcp: () => ({ config: "{}", close: () => { closed++; } }) });
  cleanup.push(() => peer.stop("fixture teardown")); peer.onDelivery = receipt => receipts.push(receipt);
  await peer.start(); await peer.deliver([review()], "native-policy-drift");
  await until(() => existsSync(marker)); expect(peer.reviewToken(71)).toBeDefined();
  current = false; expect(peer.reviewToken(71)).toBeUndefined();
  current = true; expect(peer.reviewToken(71)).toBeUndefined();
  await until(() => peer.state !== "busy");
  expect(closed).toBe(1);
  expect(existsSync(reviewRoot!)).toBe(false);
  expect(receipts.some(receipt => receipt.state === "needs_review")).toBe(true);
  expect(receipts.some(receipt => receipt.state === "completed")).toBe(false);
});


test("task MCP closes once after a normal child exit", async () => {
  const base=scratch(), marker=join(base,"normal-child-started");let closed=0;
  const peer=new ReviewerPrintPeer("fixture-review",{cwd:base,mcpConfig:"{}",systemPrompt:"fixture",watchdogMs:5000,
    backend:{id:"fixture",taskMcp:true,prepare:async()=>launch(mkdtempSync(join(base,"private-")),marker)},
    verdictSince:()=>true,taskMcp:()=>({config:"{}",close:()=>{closed++;}})});
  cleanup.push(()=>peer.stop("fixture teardown"));
  await peer.start();await peer.deliver([review()],"normal-task-mcp");await until(()=>peer.state==="idle");
  expect(existsSync(marker)).toBe(true);expect(closed).toBe(1);
  await peer.stop("person stop after exit");expect(closed).toBe(1);
});
