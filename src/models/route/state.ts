// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/escalation.rs at commit c8848511, modified.

import type { EscalationCategory, EscalationVerdict } from "./escalation.ts";

export interface EscalationStateSnapshot { latched: boolean; category?: EscalationCategory; streak: number }

/** Confirmation streak and session latch used by the trajectory escalation policy. */
export class EscalationState {
  private category?: EscalationCategory;
  private streak = 0;
  private latched = false;
  apply(verdict: EscalationVerdict | undefined, confirmations = 2): EscalationStateSnapshot {
    if (this.latched) return this.snapshot();
    if (verdict && verdict.escalate && verdict.category !== "none" && verdict.newEvidence) {
      this.streak = this.category === verdict.category ? this.streak + 1 : 1;
      this.category = verdict.category;
      if (this.streak >= confirmations) this.latched = true;
    } else if (verdict) {
      this.streak = 0;
      this.category = undefined;
    }
    return this.snapshot();
  }
  reset(): void { this.category = undefined; this.streak = 0; this.latched = false; }
  snapshot(): EscalationStateSnapshot { return { latched: this.latched, ...(this.category ? { category: this.category } : {}), streak: this.streak }; }
}

/** Bounded keyed state helper with one-hour idle expiry for independent sessions. */
export class SessionState<T> {
  private readonly values = new Map<string, { value: T; touchedAt: number }>();
  constructor(private readonly maxEntries = 1024, private readonly ttlMs = 60 * 60 * 1000) {}
  get(key: string, now = Date.now()): T | undefined {
    this.expire(now);
    const entry = this.values.get(key);
    if (entry) entry.touchedAt = now;
    return entry?.value;
  }
  set(key: string, value: T, now = Date.now()): void {
    this.expire(now);
    this.values.delete(key);
    while (this.values.size >= this.maxEntries) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    this.values.set(key, { value, touchedAt: now });
  }
  delete(key: string): void { this.values.delete(key); }
  private expire(now: number): void {
    for (const [key, entry] of this.values) if (now - entry.touchedAt >= this.ttlMs) this.values.delete(key);
  }
}
