/** WebSocket-shaped adapter over the daemon-created Bun IPC channel, never a network socket. */
export class InstructedIpcSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  private readonly message = (value: unknown) => {
    try {
      const data = JSON.stringify(value);
      if (typeof data !== "string" || Buffer.byteLength(data) > this.maxFrame) throw new Error("invalid inherited control frame");
      this.onmessage?.({ data });
    } catch { this.close(); }
  };
  private readonly disconnected = () => { this.readyState = WebSocket.CLOSED; this.onclose?.({ code: 1006, reason: "inherited control channel closed" }); };
  constructor(private readonly maxFrame: number) {
    if (typeof process.send !== "function") throw new Error("inherited control channel unavailable");
    process.on("message", this.message);
    process.once("disconnect", this.disconnected);
    queueMicrotask(() => { if (this.readyState === WebSocket.CONNECTING) { this.readyState = WebSocket.OPEN; this.onopen?.(); } });
  }
  send(message: string): void {
    if (this.readyState !== WebSocket.OPEN || Buffer.byteLength(message) > this.maxFrame || typeof process.send !== "function") throw new Error("invalid inherited control frame");
    process.send(JSON.parse(message));
  }
  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    process.removeListener("message", this.message);
    process.removeListener("disconnect", this.disconnected);
    if (process.connected && typeof process.disconnect === "function") process.disconnect();
  }
}
