/** Keep rejected owned listeners bound until a replacement cannot reuse their ports. */
export function listenWithoutPortCollision<T extends { port?: number; stop(closeActiveConnections?: boolean): void }>(listen: () => T, reservedPorts: readonly number[]): T {
  const reserved = new Set(reservedPorts.filter(port => Number.isSafeInteger(port) && port > 0));
  const temporary: T[] = [];
  try {
    for (let attempt = 0; attempt <= reserved.size; attempt++) {
      const candidate = listen();
      if (!reserved.has(candidate.port ?? -1)) return candidate;
      temporary.push(candidate);
    }
    throw new Error("automatic control listener could not avoid requested peer ports");
  } finally {
    for (const listener of temporary) listener.stop(true);
  }
}
