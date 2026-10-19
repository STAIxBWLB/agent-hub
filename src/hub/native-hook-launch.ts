/** Managed launch authority is ephemeral and scoped to one peer, daemon and native session. */
export interface NativeHookLaunch {
  id: string;
  session?: string;
  generation?: string;
  baseline?: number;
  turn?: string;
  active: boolean;
  completed?: string;
}
export class NativeHookLaunches {
  private readonly launches = new Map<string, NativeHookLaunch>();
  begin(peer: string): NativeHookLaunch {
    if (this.launches.has(peer)) throw new Error("a managed native launch is already active; end it in its terminal first");
    const launch: NativeHookLaunch = { id: crypto.randomUUID(), active: false };
    this.launches.set(peer, launch);
    return launch;
  }
  get(peer: string, id: unknown): NativeHookLaunch | undefined {
    const launch = this.launches.get(peer);
    return launch && typeof id === "string" && launch.id === id ? launch : undefined;
  }
  end(peer: string, id: unknown): boolean {
    if (!this.get(peer, id)) return false;
    return this.launches.delete(peer);
  }
}
