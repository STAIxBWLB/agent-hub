export interface VerifiedRun { id: number; head_sha: string; html_url: string; conclusion: string; event: string }
export function findVerifiedRun(api: (path: string) => Promise<any>, tree: string): Promise<VerifiedRun | undefined>;
