/** Managed launch authority is ephemeral and scoped to one peer, daemon and native session. */
export interface NativeHookLaunch {
  id: string;
  home?: string;
  session?: string;
  transcript?: string;
  generation?: string;
  baseline?: number;
  turn?: string;
  active: boolean;
  completed?: string;
}
export class NativeHookLaunches {
  private readonly launches = new Map<string, NativeHookLaunch>();
  private readonly owners = new Map<string, object>();
  begin(peer: string, owner: object, home?: string): NativeHookLaunch {
    if (this.launches.has(peer)) throw new Error("a managed native launch is already active; end it in its terminal first");
    const launch: NativeHookLaunch = { id: crypto.randomUUID(), active: false, ...(home ? { home } : {}) };
    this.launches.set(peer, launch);
    this.owners.set(peer, owner);
    return launch;
  }
  current(peer: string): NativeHookLaunch | undefined { return this.launches.get(peer); }
  get(peer: string, id: unknown): NativeHookLaunch | undefined {
    const launch = this.launches.get(peer);
    return launch && typeof id === "string" && launch.id === id ? launch : undefined;
  }
  end(peer: string, id: unknown): boolean {
    if (!this.get(peer, id)) return false;
    this.owners.delete(peer);
    return this.launches.delete(peer);
  }
  endOwner(owner: object): { peer: string; launch: NativeHookLaunch }[] {
    const ended: { peer: string; launch: NativeHookLaunch }[] = [];
    for (const [peer, current] of this.owners) {
      if (current !== owner) continue;
      const launch = this.launches.get(peer);
      if (launch) ended.push({ peer, launch });
      this.launches.delete(peer);
      this.owners.delete(peer);
    }
    return ended;
  }
}
