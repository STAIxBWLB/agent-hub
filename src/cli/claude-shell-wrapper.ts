import { request } from "node:http";
import { isAbsolute, basename } from "node:path";

export const HOST_SHELL_PROTOCOL = Object.freeze({ chunkBytes: 16 * 1024, frameBytes: 24 * 1024, failure: 125, maximumMs: 3_600_000, refusal: "host shell execution refused" });

async function output(stream: NodeJS.WriteStream, data: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => stream.write(data, error => error ? reject(error) : resolve()));
}

async function main(): Promise<number> {
  const [socket, ticket, ...extra] = process.argv.slice(2);
  if (!socket || !isAbsolute(socket) || socket.length > 4096 || !ticket || !/^[a-f0-9]{64}$/.test(ticket) || extra.length) throw new Error();
  const body = JSON.stringify({ ticket });
  const call = request({ socketPath: socket, path: "/execute", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" } });
  const connection = new Promise<import("node:http").IncomingMessage>((resolve, reject) => { call.once("response", resolve); call.once("error", reject); });
  const opening = setTimeout(() => call.destroy(new Error()), 5000);
  const total = setTimeout(() => call.destroy(new Error()), HOST_SHELL_PROTOCOL.maximumMs + 10_000);
  let response: import("node:http").IncomingMessage | undefined;
  try {
    call.end(body); response = await connection; clearTimeout(opening);
    if (response.statusCode !== 200 || response.headers["content-type"] !== "application/x-ndjson") throw new Error();
    let pending = "", status: number | undefined;
    for await (const raw of response) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (chunk.length > 1024 * 1024) throw new Error();
      pending += chunk.toString("utf8");
      for (let end; (end = pending.indexOf("\n")) >= 0;) {
        if (end > HOST_SHELL_PROTOCOL.frameBytes) throw new Error();
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line || status !== undefined) throw new Error();
        const frame = JSON.parse(line);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error();
        const keys = Object.keys(frame).sort().join(",");
        if (frame.type === "exit" && keys === "code,type" && Number.isSafeInteger(frame.code) && frame.code >= 0 && frame.code <= 255) { status = frame.code; continue; }
        if (!["stdout", "stderr"].includes(frame.type) || keys !== "data,type" || typeof frame.data !== "string" || frame.data.length > 4 * Math.ceil(HOST_SHELL_PROTOCOL.chunkBytes / 3)) throw new Error();
        const bytes = Buffer.from(frame.data, "base64");
        if (bytes.length > HOST_SHELL_PROTOCOL.chunkBytes || bytes.toString("base64") !== frame.data) throw new Error();
        await output(frame.type === "stdout" ? process.stdout : process.stderr, bytes);
      }
      if (pending.length > HOST_SHELL_PROTOCOL.frameBytes) throw new Error();
    }
    if (pending || status === undefined) throw new Error();
    return status;
  } finally { clearTimeout(opening); clearTimeout(total); response?.destroy(); call.destroy(); }
}

// The filename fence also keeps this inert if a host imports the protocol constants through a bundle.
if (import.meta.main && basename(process.argv[1] ?? "") === "claude-shell-wrapper.ts") {
  process.stdout.on("error", () => {}); process.stderr.on("error", () => {});
  void main().then(code => { process.exitCode = code; }, async () => {
    try { await output(process.stderr, Buffer.from(`${HOST_SHELL_PROTOCOL.refusal}\n`)); } catch { /* broken caller pipe */ }
    process.exitCode = HOST_SHELL_PROTOCOL.failure;
  });
}
