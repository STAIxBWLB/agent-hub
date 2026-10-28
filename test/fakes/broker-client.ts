/** Test-only transport client. Queue ACKs are not application-delivery receipts. */
import { canonicalBytes } from "../../src/rooms/wire.ts";
import { createBrokerAuth, decodeBrokerChallenge } from "../../src/broker/protocol.ts";
import type { HubIdentity } from "../../src/rooms/crypto.ts";

const decoder = new TextDecoder();
export const packetObject = (wire: Uint8Array): Record<string, unknown> => JSON.parse(decoder.decode(wire));
export class FakeBrokerClient {
  readonly ws: WebSocket;
  readonly packets: Uint8Array[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private closeResult?: { code: number; reason: string };
  private readonly waiters: { type: string; resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private constructor(readonly url: string, readonly room: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(`${url}v1/rooms/${room}`, headers ? { headers } : undefined);
    this.ws.binaryType = "arraybuffer";
    this.closed = new Promise(resolve => {
      this.ws.addEventListener("close", event => {
        this.closeResult = { code: event.code, reason: event.reason }; resolve(this.closeResult);
        for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error("broker client closed")); }
      });
    });
    this.ws.addEventListener("message", event => {
      const wire = typeof event.data === "string" ? new TextEncoder().encode(event.data) : new Uint8Array(event.data as ArrayBuffer);
      let type = ""; try { type = String(packetObject(wire).type); } catch { /* retained for test diagnostics */ }
      const index = this.waiters.findIndex(waiter => waiter.type === type);
      if (index < 0) this.packets.push(wire);
      else { const waiter = this.waiters.splice(index, 1)[0]!; clearTimeout(waiter.timer); waiter.resolve(wire); }
    });
  }
  static async connect(url: string, room: string, headers?: Record<string, string>): Promise<FakeBrokerClient> {
    const client = new FakeBrokerClient(url, room, headers);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("broker open timeout")), 10_000);
      client.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      client.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("broker open refused")); }, { once: true });
    });
    return client;
  }
  take(type: string): Promise<Uint8Array> {
    const index = this.packets.findIndex(wire => { try { return packetObject(wire).type === type; } catch { return false; } });
    if (index >= 0) return Promise.resolve(this.packets.splice(index, 1)[0]!);
    if (this.closeResult) return Promise.reject(new Error("broker client closed"));
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject, timer: setTimeout(() => { const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1); reject(new Error(`broker packet timeout: ${type}`)); }, 10_000) };
      this.waiters.push(waiter);
    });
  }
  send(wire: Uint8Array): void { this.ws.send(wire); }
  control(value: unknown): void { this.send(canonicalBytes(value)); }
  async authenticate(identity: HubIdentity, initialRoster?: Uint8Array, broker = this.url): Promise<Uint8Array> {
    const challenge = decodeBrokerChallenge(await this.take("challenge"));
    this.send(await createBrokerAuth({ challenge, identity, broker, room: this.room, ...(initialRoster ? { initialRoster } : {}) }));
    const roster = await this.take("roster"), ready = packetObject(await this.take("ready"));
    this.control({ v: 1, type: "roster_ready", digest: ready.digest });
    return roster;
  }
  async rosterReady(): Promise<Uint8Array> {
    const roster = await this.take("roster"), ready = packetObject(await this.take("ready"));
    this.control({ v: 1, type: "roster_ready", digest: ready.digest }); return roster;
  }
  async ack(digest: string): Promise<void> {
    this.control({ v: 1, type: "received", digest }); await this.take("queue_ack");
  }
  close(): void { if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(); }
}
