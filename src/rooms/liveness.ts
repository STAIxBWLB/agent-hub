/** Host timing only; signed presence remains the existing v1 ids/state payload. */
export const ROOM_REFRESH_MS = 30_000;
export const ROOM_PRESENCE_MISSES = 3;
export const ROOM_STOP_TIMEOUT_MS = 2_000;

export function roomRefreshPeriod(value = ROOM_REFRESH_MS): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > Math.floor(2_147_483_647 / ROOM_PRESENCE_MISSES)) {
    throw new Error("room refresh period is invalid; use a positive whole duration within the timer bound");
  }
  return value;
}
