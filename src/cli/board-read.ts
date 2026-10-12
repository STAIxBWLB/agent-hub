/** Older same-protocol daemons may ignore newly added filter arguments. */
export function supportsBoardReleaseFilter(status: unknown): boolean {
  if (!status || typeof status !== "object") return false;
  const capability = (status as Record<string,unknown>).boardReadCapabilities;
  return !!capability && typeof capability === "object" && (capability as Record<string,unknown>).releaseFilter === true;
}
