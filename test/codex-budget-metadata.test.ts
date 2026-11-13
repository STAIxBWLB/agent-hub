import { renderBudget } from "../src/cli/output.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAccountUsage, codexQuotaWindowInput } from "../src/adapters/definitions/native-quota.ts";
import { quotaAccountUsage, quotaAccountReading } from "../src/hub/quota-account.ts";
import { Budget, DEFAULT_BUDGET, type BudgetHooks } from "../src/hub/budget.ts";
import { publicPeerBudget } from "../src/hub/conductor.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const expiresAt = Date.parse("2026-12-13T00:00:00Z") / 1000;
const row = (expires: number | null = expiresAt) => ({ id: "CREDIT_ID_CANARY", title: "TITLE_CANARY", description: "DESCRIPTION_CANARY", grantedAt: 1, resetType: "codexRateLimits", status: "available", expiresAt: expires });
const snapshot = () => ({ accountId: "ACCOUNT_ID_CANARY", ordinaryUsageAllowed: false,
  rateLimitResetCredits: { availableCount: 1, credits: [row()] },
  rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_900_000_000, balance: "WINDOW_BALANCE_CANARY" }, secondary: null, rateLimitReachedType: "rate_limit_reached", credits: { hasCredits: true, unlimited: false, balance: "BALANCE_CANARY" } } });
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
};
function setup(account?: BudgetHooks["account"]) {
  const root = mkdtempSync(join(tmpdir(), "ahub-account-quota-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = { now: 1_800_000_000_000 }, resumed: unknown[] = [];
  const hooks: BudgetHooks = { account, pause: () => {}, resume: () => {}, attached: () => true, canHandOff: () => false,
    requestCheckpoint: async () => undefined, platformContext: async () => undefined, handoff: async () => [], resumed: value => resumed.push(value), notify: () => {} };
  const file = join(root, "hub.db"), budget = new Budget(file, DEFAULT_BUDGET, hooks, () => clock.now);
  cleanup.push(() => budget.close());
  return { budget, clock, resumed, file, hooks };
}

test("#1440 native quota projection keeps only flags, counts and times and preserves false", () => {
  const raw = snapshot(), info = codexAccountUsage(raw);
  expect(info).toEqual({ resetCreditsAvailable: 1, resetCreditsExpireAt: expiresAt * 1000, resetCreditsExpiryKnown: true, ordinaryUsageAllowed: false, hasCredits: true, unlimited: false });
  const windows = codexQuotaWindowInput(raw.rateLimits);
  expect(windows).toEqual({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: null, rateLimitReachedType: "rate_limit_reached" });
  expect(JSON.stringify({ info, windows })).not.toMatch(/CANARY|balance|accountId|grantedAt|description|title/);
  expect(codexQuotaWindowInput({ rateLimitReachedType: "SECRET_REASON_CANARY" })).toMatchObject({ rateLimitReachedType: "usageLimitExceeded" });
  expect(codexAccountUsage({ ordinaryUsageAllowed: null, rateLimits: { credits: { hasCredits: false, unlimited: true } } })).toEqual({ hasCredits: false, unlimited: true });
  expect(codexAccountUsage(null)).toEqual({});
});

test("#1440 summary count is authoritative and capped or absent details cannot prove a global expiry", () => {
  for (const credits of [null, undefined, [row()], Array.from({ length: 129 }, () => row())]) {
    const info = codexAccountUsage({ rateLimitResetCredits: { availableCount: credits?.length === 129 ? 129 : 2, credits } });
    expect(info.resetCreditsAvailable).toBe(credits?.length === 129 ? 129 : 2);
    expect(info.resetCreditsExpiryKnown).toBe(false); expect(info.resetCreditsExpireAt).toBeUndefined();
  }
  expect(codexAccountUsage({ rateLimitResetCredits: { availableCount: 2, credits: [row(expiresAt + 100), row()] } })).toEqual({ resetCreditsAvailable: 2, resetCreditsExpiryKnown: true, resetCreditsExpireAt: expiresAt * 1000 });
  expect(codexAccountUsage({ rateLimitResetCredits: { availableCount: 1, credits: [row(null)] } })).toEqual({ resetCreditsAvailable: 1, resetCreditsExpiryKnown: true });
  expect(codexAccountUsage({ rateLimitResetCredits: { availableCount: 0, credits: null } })).toEqual({ resetCreditsAvailable: 0, resetCreditsExpiryKnown: true });
});

test("#1440 malformed metadata stays unknown without inventing zero or an expiry", () => {
  for (const count of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    expect(codexAccountUsage({ rateLimitResetCredits: { availableCount: count, credits: [row()] } })).toEqual({});
  }
  for (const bad of [{ ...row(), status: "redeeming" }, { ...row(), resetType: "unknown" }, { ...row(), expiresAt: undefined }, { ...row(), expiresAt: Infinity }, { ...row(), expiresAt: 1.5 }]) {
    expect(codexAccountUsage({ rateLimitResetCredits: { availableCount: 1, credits: [bad] } })).toEqual({ resetCreditsAvailable: 1, resetCreditsExpiryKnown: false });
  }
  expect(quotaAccountUsage({ hasCredits: "true", unlimited: 1, ordinaryUsageAllowed: null, balance: "CANARY" })).toEqual({});
  expect(quotaAccountReading({ at: Infinity, stale: false, hasCredits: true })).toBeUndefined();
});

test("#1440 credits never prevent a pause or lift one, and account diagnostics are RAM-only", async () => {
  const f = setup(), info = codexAccountUsage(snapshot()), windows = [{ id: "5h" as const, used: 1, resetsAt: f.clock.now + 100_000, source: "native quota" }];
  f.budget.report("codex", windows, false, f.clock.now, { ...info, unlimited: true });
  await until(() => !!f.budget.record("codex") && f.budget.recoverySettled);
  const pause = f.budget.record("codex");
  f.clock.now++;
  f.budget.report("codex", [], false, f.clock.now, { hasCredits: true, unlimited: true, ordinaryUsageAllowed: true });
  await until(() => f.budget.recoverySettled);
  expect(f.budget.record("codex")).toEqual(pause); expect(f.resumed).toEqual([]);
  const metadata = f.budget.status().codex!.accountUsage!;
  expect(metadata).toMatchObject({ hasCredits: true, unlimited: true, ordinaryUsageAllowed: true, stale: false });
  metadata.hasCredits = false; expect(f.budget.status().codex!.accountUsage!.hasCredits).toBe(true);
  const publicStatus = publicPeerBudget(f.budget.status(), () => true);
  expect(JSON.stringify(publicStatus)).not.toMatch(/CANARY|balance|accountId|creditId/);
  f.clock.now += DEFAULT_BUDGET.stale_min * 60_000 + 1;
  expect(f.budget.status().codex!.accountUsage!.stale).toBe(true);
  const reopened = new Budget(f.file, DEFAULT_BUDGET, f.hooks, () => f.clock.now); cleanup.push(() => reopened.close());
  expect(reopened.status().codex!.paused).toBeDefined(); expect(reopened.status().codex!.accountUsage).toBeUndefined();
});

test("#1440 pause observation uses the canonical account and stale unsubscribe cannot remove a new observer", async () => {
  const f = setup(peer => peer.startsWith("codex") ? "codex" : peer), seen: boolean[] = [];
  const changed = () => seen.push(!!f.budget.record("codex"));
  const stop = f.budget.watchPause("codex-extra", changed); stop();
  const stopCurrent = f.budget.watchPause("codex", changed); stop(); // old unsubscribe is idempotent
  f.budget.report("codex-extra", [{ id: "5h", used: 1, resetsAt: f.clock.now + 100_000, source: "native quota" }], true);
  await until(() => f.budget.recoverySettled); expect(seen).toEqual([true]);
  f.clock.now++;
  f.budget.report("codex", [{ id: "5h", used: 0.1, resetsAt: f.clock.now + 100_000, source: "native quota" }]);
  await until(() => !f.budget.record("codex")); expect(seen).toEqual([true, false]);
  stopCurrent();
});


test("#1440 public projections discard extra account fields and stale diagnostics do not predict credit-funded turns", () => {
  const status = { codex: { windows: [], paused: { reason: "quota", since: 1, resetsAt: 2 }, accountUsage: {
    at: 1, stale: true, ordinaryUsageAllowed: false, hasCredits: true, unlimited: false,
    resetCreditsAvailable: 3, resetCreditsExpiryKnown: false,
    balance: "BALANCE_CANARY", accountId: "ACCOUNT_ID_CANARY", creditId: "CREDIT_ID_CANARY",
  } } };
  const projected = publicPeerBudget(status, () => true);
  expect(JSON.stringify(projected)).not.toMatch(/CANARY|balance|accountId|creditId/);
  const text = renderBudget({ budget: projected }, 80, 10).map(line => line.map(part => part.text).join("")).join("\n");
  expect(text).toContain("stale snapshot"); expect(text).toContain("expiry unknown");
  expect(text).not.toContain("turns would use paid credits"); expect(text).not.toContain("CANARY");
});


test("#1440 every accepted native expiry retains its complete ISO date", () => {
  const expiry = Date.parse("+010000-01-02T00:00:00.000Z"), info = codexAccountUsage({ rateLimitResetCredits: { availableCount: 1, credits: [row(expiry / 1000)] } });
  expect(info.resetCreditsExpireAt).toBe(expiry);
  const text = renderBudget({ budget: { codex: { windows: [], paused: { reason: "quota" }, accountUsage: { ...info, at: 1, stale: false } } } }, undefined, 1).map(line => line.map(part => part.text).join("")).join("\n");
  expect(text).toContain("expires +010000-01-02");
});
