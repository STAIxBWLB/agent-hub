export function packEntry(stdout: string, npmVersion?: string): { name: string; version: string; files: { path: string }[]; [key: string]: unknown };
