export function mentioned(text: string, repo: string): Set<string>;
export function intentionalCloses(text: string, repo: string): Set<string>;
export function closingMisuse(text: string, closing: readonly { number: number; repository?: { name?: string; owner?: { login?: string }; nameWithOwner?: string } }[], repo: string): string[];
export function keywordReferences(text: string, repo: string): { id: string; negated: boolean }[];
export function commitMisuse(commits: readonly string[], prText: string, repo: string): string[];
