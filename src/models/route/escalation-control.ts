import type { EscalationCategory, EscalationReply } from "./judge-replies.ts";

export interface EscalationSnapshot {
  latched: boolean;
  streak: number;
  category?: Exclude<EscalationCategory, "none">;
}
const CONFIRMATIONS = 2;
const CONFIRMATION_LIMIT = 200_000;

/** Whether-to escalation remains a host rule, separate from model/effort choice. */
export class EscalationControl {
  private state: EscalationSnapshot = { latched: false, streak: 0 };

  snapshot(): EscalationSnapshot { return { ...this.state }; }

  apply(reply: EscalationReply | undefined, confirmations = CONFIRMATIONS): EscalationSnapshot {
    if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > CONFIRMATION_LIMIT) {
      throw new RangeError("invalid escalation confirmation bound");
    }
    if (this.state.latched || reply === undefined) return this.snapshot();
    if (!reply.escalate || !reply.newEvidence || reply.category === "none") {
      this.state = { latched: false, streak: 0 };
      return this.snapshot();
    }
    const streak = reply.category === this.state.category ? this.state.streak + 1 : 1;
    this.state = { latched: streak >= confirmations, streak, category: reply.category };
    return this.snapshot();
  }
}
