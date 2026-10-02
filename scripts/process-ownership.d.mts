export function daemonProjectRoot(command: string): string | undefined;
export function daemonProjectRootFromArgv(argv: string[], executable: string): string | undefined;
export function processBelongsToRun(command: string, runRoot: string): boolean;
export interface ProcessRow { pid: string; ppid: string; pgid: string; started: string; command: string }
export function processIdentity(row: ProcessRow): string;
export function commandRuntime(command: string): string;
export function parseProcessSnapshot(snapshot: string): ProcessRow[];
export interface DaemonBirth { pid: string; pgid: string; started: string; root: string; command: string; runtime: string; exclusive: boolean; kind: "daemon" | "owned_process" }
export function ownedProcesses(rows: ProcessRow[], runRoot: string, births: DaemonBirth[]): ProcessRow[];
