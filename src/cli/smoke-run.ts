import { closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assessVersion } from "../adapters/compat.ts";
import { hubGitSync } from "../hub/git.ts";
import { realPath } from "../hub/project.ts";
import { runPty } from "./smoke-pty.ts";
import type { SmokeTarget } from "./smoke-target.ts";

export interface SmokeReceipt {
  schemaVersion: 1;
  leg: "qwen-dual-output";
  outcome: "passed" | "failed" | "timeout";
  reason: "complete" | "protocol" | "timeout" | "cleanup" | "aborted";
  checks: { disposable: boolean; protocol: boolean; queued: boolean; cleaned: boolean };
  counts: { submits: number; users: number; assistants: number; stops: number; events: number; terminalBytes: number };
  timings: { totalMs: number; protocolMs: number };
}
export interface SmokeOptions { leg: "qwen-dual-output"; receipt: string; timeoutMs: number; signal?: AbortSignal }
/** Host-only test ports, never loaded from project configuration or accepted as CLI arguments. */
export interface SmokePorts { command?: readonly string[]; env?: NodeJS.ProcessEnv }
const FIRST = "AHUB_SMOKE_FIRST", SECOND = "AHUB_SMOKE_SECOND";
const FIRST_PROMPT = `Print ${FIRST} once, then list 64 short numbered lines. Do not use any tools.`;
const SECOND_PROMPT = `Reply with exactly ${SECOND}. Do not use any tools.`;
const protocolError = () => new Error("smoke protocol refused");
const inside = (root: string, value: string) => { const name = relative(root, value); return !!name && !isAbsolute(name) && name !== ".." && !name.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`); };

/** No model-selected commands, prompts or persisted output: this is one fixed Q2 protocol leg. */
export async function runSmoke(target: SmokeTarget, options: SmokeOptions, ports: SmokePorts = {}): Promise<SmokeReceipt> {
  target.check();
  if (options.leg !== "qwen-dual-output" || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 120_000) throw new Error("smoke arguments refused");
  const receiptPath = resolve(target.cwd, options.receipt), parent = dirname(receiptPath);
  if (!inside(target.cwd, receiptPath) || parent !== target.cwd || realPath(parent) !== parent || existsSync(receiptPath)) throw new Error("smoke receipt refused");
  const source = ports.env ?? process.env;
  if (!source.OPENAI_API_KEY?.trim() || !source.OPENAI_BASE_URL?.trim() || !source.OPENAI_MODEL?.trim()) throw new Error("smoke prerequisites unavailable");
  let endpoint: URL;
  try { endpoint = new URL(source.OPENAI_BASE_URL); } catch { throw new Error("smoke prerequisites unavailable"); }
  if (endpoint.username || endpoint.password || !["https:", "http:"].includes(endpoint.protocol)) throw new Error("smoke prerequisites unavailable");
  const command = ports.command ?? [Bun.which("qwen", { PATH: source.PATH }) ?? ""];
  if (!command.length || !command[0]) throw new Error("smoke prerequisites unavailable");
  const started = performance.now();
  const receipt: SmokeReceipt = { schemaVersion: 1, leg: "qwen-dual-output", outcome: "failed", reason: "protocol", checks: { disposable: true, protocol: false, queued: false, cleaned: true }, counts: { submits: 0, users: 0, assistants: 0, stops: 0, events: 0, terminalBytes: 0 }, timings: { totalMs: 0, protocolMs: 0 } };
  target.check();
  const run = mkdtempSync(join(target.cwd, ".smoke-run-"));
  const home = join(run, "home"), cwd = join(run, "project"), temporary = join(run, "tmp");
  for (const dir of [home, cwd, temporary, join(home, ".qwen")]) mkdirSync(dir, { mode: 0o700 });
  let cleaned = true;
  try {
    const git = hubGitSync(["-c", "init.templateDir=", "init", "-q", cwd], { encoding: "utf8" });
    if (git.status !== 0) throw protocolError();
    writeFileSync(join(home, ".qwen", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "openai" } }, general: { disableAutoUpdate: true, disableUpdateNag: true }, privacy: { usageStatisticsEnabled: false }, telemetry: { enabled: false }, mcpServers: {} }), { mode: 0o600, flag: "wx" });
    const input = join(run, "input.jsonl"), events = join(run, "events.jsonl"), mcp = join(run, "mcp.json");
    for (const file of [input, events]) writeFileSync(file, "", { mode: 0o600, flag: "wx" });
    writeFileSync(mcp, JSON.stringify({ mcpServers: {} }), { mode: 0o600, flag: "wx" });
    const env: NodeJS.ProcessEnv = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), PATH: source.PATH ?? "", TERM: "xterm-256color", LANG: "en_US.UTF-8", TMPDIR: temporary, OPENAI_API_KEY: source.OPENAI_API_KEY, OPENAI_BASE_URL: source.OPENAI_BASE_URL, OPENAI_MODEL: source.OPENAI_MODEL, QWEN_USAGE_STATISTICS_ENABLED: "false", NO_COLOR: "1" };
    const fd = openSync(events, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const inputFd = openSync(input, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    const decoder = new TextDecoder();
    let position = 0, partial = "", announced = false, assistant = false, queued = false;
    const deadline = performance.now() + options.timeoutMs;
    const submit = (text: string) => { target.check(); if (!fstatSync(inputFd).isFile() || fstatSync(inputFd).nlink !== 1) throw protocolError(); writeSync(inputFd, JSON.stringify({ type: "submit", text }) + "\n"); receipt.counts.submits++; };
    try {
      target.check(); cleaned = false; receipt.checks.cleaned = false;
      const result = await runPty([...command, "--input-file", input, "--json-file", events, "--mcp-config", mcp, "--approval-mode", "default", "--auth-type", "openai", "--model", source.OPENAI_MODEL], { cwd, env, timeoutMs: options.timeoutMs, signal: options.signal, ready: async () => {
        while (performance.now() < deadline && !options.signal?.aborted) {
          const info = fstatSync(fd);
          if (!info.isFile() || info.nlink !== 1 || info.size < position || info.size > 8 * 1024 * 1024) throw protocolError();
          if (position < info.size) {
            const chunk = Buffer.alloc(Math.min(64 * 1024, info.size - position));
            const got = readSync(fd, chunk, 0, chunk.length, position); position += got;
            partial += decoder.decode(chunk.subarray(0, got), { stream: true });
            if (Buffer.byteLength(partial) > 128 * 1024) throw protocolError();
            let newline: number;
            while ((newline = partial.indexOf("\n")) >= 0) {
              const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
              if (!line.trim()) continue;
              if (Buffer.byteLength(line) > 64 * 1024) throw protocolError();
              let event: any; try { event = JSON.parse(line); } catch { throw protocolError(); }
              receipt.counts.events++;
              if (!event || typeof event !== "object" || Array.isArray(event)) throw protocolError();
              if (event.type === "control_request") throw protocolError(); // this read-only leg never answers approvals
              if (event.type === "system" && event.subtype === "session_start") {
                if (announced || event.data?.protocol_version !== 2 || !assessVersion("qwen-dual", event.data?.version).ok || !Array.isArray(event.data?.supported_events) || !["user", "assistant", "stream_event"].every(name => event.data.supported_events.includes(name))) throw protocolError();
                announced = true; submit(FIRST_PROMPT);
              } else if (event.type === "user") {
                if (!announced || receipt.counts.users >= receipt.counts.submits || receipt.counts.users === 1 && receipt.counts.stops !== 1) throw protocolError();
                const content = event.message?.content;
                const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("") : "";
                if (text.trim() !== (receipt.counts.users === 0 ? FIRST_PROMPT : SECOND_PROMPT)) throw protocolError();
                receipt.counts.users++;
              } else if (event.type === "assistant") {
                const blocks = event.message?.content;
                const text = Array.isArray(blocks) ? blocks.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("") : "";
                if (event.message?.stop_reason === "tool_use" || !text.includes(receipt.counts.stops === 0 ? FIRST : SECOND) || receipt.counts.users !== receipt.counts.stops + 1 || assistant) throw protocolError();
                assistant = true; receipt.counts.assistants++;
              } else if (event.type === "stream_event") {
                if (!event.event || typeof event.event.type !== "string") throw protocolError();
                if (event.event?.type === "message_stop") {
                  if (!assistant || receipt.counts.stops === 0 && !queued) throw protocolError();
                  assistant = false; receipt.counts.stops++;
                  if (receipt.counts.stops === 2) { receipt.checks.protocol = true; receipt.checks.queued = queued; return; }
                } else if (receipt.counts.users === 1 && !queued && ["message_start", "content_block_start", "content_block_delta"].includes(event.event.type)) {
                  // Submit while the first streamed turn is observed running; the second user event must follow its stop.
                  submit(SECOND_PROMPT); queued = true;
                }
              }
            }
          }
          await Bun.sleep(20);
        }
        throw protocolError();
      } });
      receipt.counts.terminalBytes = result.outputBytes;
      receipt.checks.cleaned = result.cleaned;
      cleaned = result.cleaned;
      if (result.outcome === "completed" && receipt.checks.protocol && receipt.checks.queued && result.cleaned) { receipt.outcome = "passed"; receipt.reason = "complete"; }
      else if (result.outcome === "timeout") { receipt.outcome = "timeout"; receipt.reason = "timeout"; }
      else if (result.outcome === "aborted") receipt.reason = "aborted";
    } finally { closeSync(fd); closeSync(inputFd); }
  } catch { receipt.reason = "protocol"; }
  finally {
    // Remove only the directory this invocation made, after all owned processes were confirmed stopped.
    if (cleaned) rmSync(run, { recursive: true, force: true });
  }
  receipt.timings.totalMs = Math.round(performance.now() - started);
  receipt.timings.protocolMs = receipt.timings.totalMs;
  if (!receipt.checks.cleaned) { receipt.outcome = "failed"; receipt.reason = "cleanup"; }
  target.check();
  try { writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
  catch { throw new Error("smoke receipt refused"); }
  return receipt;
}
