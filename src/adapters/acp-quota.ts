/** Provider refusal observed from Kimi Code CLI 2.1.1 on 2026-10-11. No weekly/monthly or Qwen text is verified. */
export const KIMI_2_1_1_5H_REFUSAL_PREFIX = "Authentication required: 403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.";
export interface ACPQuotaRefusal {
  id: "5h";
  used: 1;
  windowMins: 300;
  source: "kimi ACP usage-limit refusal";
}
/** Identity and turn/effect fencing are the caller's responsibility; an arbitrary 'quota' error is not a known refusal. */
export function acpQuotaRefusal(message: string): ACPQuotaRefusal | undefined {
  if (!message.startsWith(KIMI_2_1_1_5H_REFUSAL_PREFIX)) return undefined;
  return { id: "5h", used: 1, windowMins: 300, source: "kimi ACP usage-limit refusal" };
}
