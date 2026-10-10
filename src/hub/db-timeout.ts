// hub.db is shared by the board, journal, budgets, turns and Pi receipts.
// Bound each SQLite contention wait; callers must not multiply it with retries.
export const HUB_DB_BUSY_TIMEOUT_MS = 3000;
