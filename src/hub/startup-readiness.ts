const STARTUP_NOTICE_MS = 12_000;
const STARTUP_OUTER_MS = 120_000;
const STARTUP_POLL_MS = 100;
const STARTUP_INSPECTION_MS = 3000;

export type StartupOwner = { state: "live"; pid: number } | { state: "gone" } | { state: "unknown" } | undefined;
export interface StartupReadinessPorts<T> {
  now(): number;
  sleep(ms: number): Promise<void>;
  inspect(timeoutMs: number): Promise<{ state: string; status?: T; error?: string }>;
  current(): void;
  /** A live result requires the bound spawned child and its full process identity, never PID-only evidence. */
  owner(): StartupOwner;
  confirm(status: T): void;
  starting?(pid: number): void;
}

/** Keep the existing status promise pending; only readiness confirms the retained runtime selection. */
export async function waitForStartupReadiness<T>(ports: StartupReadinessPorts<T>): Promise<T> {
  const started = ports.now(), deadline = started + STARTUP_OUTER_MS;
  let reported = false, owner: StartupOwner;
  const expired = (): never => {
    throw new Error(owner?.state === "live"
      ? `hub readiness remains unconfirmed after ${STARTUP_OUTER_MS / 1000} s; its daemon was last observed running as pid ${owner.pid}; run ahub status and inspect hub.log before retrying`
      : `hub readiness remains unconfirmed after ${STARTUP_OUTER_MS / 1000} s; run ahub status and inspect hub.log before retrying`);
  };
  for (;;) {
    ports.current();
    const remaining = deadline - ports.now();
    if (remaining <= 0) return expired();
    // inspectProject has a connect and a status timeout. A zero timeout would disable the request timer.
    const timeout = Math.min(STARTUP_INSPECTION_MS, Math.floor(remaining / 2));
    if (timeout < 1) {
      await ports.sleep(remaining);
      ports.current();
      if (ports.now() >= deadline) return expired();
      continue;
    }
    const observed = await ports.inspect(timeout);
    ports.current();
    if (ports.now() >= deadline) return expired();
    if (observed.state === "running") {
      if (observed.status === undefined) throw new Error("hub readiness reply has no status; run ahub status before retrying");
      ports.current();
      if (ports.now() >= deadline) return expired();
      ports.confirm(observed.status);
      return observed.status;
    }
    if (observed.state === "incompatible" || observed.state === "missing") throw new Error(observed.error ?? observed.state);
    if (observed.state === "stopping") throw new Error(observed.error ?? "hub shutdown is pending; wait until it stops before retrying");
    owner = ports.owner();
    ports.current();
    if (ports.now() >= deadline) return expired();
    if (owner?.state === "gone") throw new Error("hub daemon exited before readiness was confirmed; inspect hub.log and run ahub status before retrying");
    if (!reported && ports.now() - started >= STARTUP_NOTICE_MS && owner?.state === "live") {
      reported = true;
      try { ports.starting?.(owner.pid); } catch { /* Advisory progress never changes startup or confirmation. */ }
    }
    const sleep = Math.min(STARTUP_POLL_MS, deadline - ports.now());
    if (sleep <= 0) return expired();
    await ports.sleep(sleep);
    ports.current();
    if (ports.now() >= deadline) return expired();
  }
}
