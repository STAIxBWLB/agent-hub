import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { stopOwnedProcess, trackGroup } from "../hub/child-process.ts";
import { realPath } from "../hub/project.ts";
import type { ReviewerBackend, ReviewerPrepareContext } from "./reviewer-print.ts";

const VERSION = "2.2.0", MANAGED = "managed:kimi-code";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (file: string, limit = 262_144) => {
  const stat = lstatSync(file); if (!stat.isFile() || stat.size > limit) throw new Error("unsupported reviewer file");
  return readFileSync(file, "utf8");
};
const scalar = (value: unknown, depth = 0): string => {
  if (depth > 4) throw new Error("managed model setting too deeply nested");
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value) && value.every(v => typeof v === "string")) return JSON.stringify(value);
  if (object(value) && Object.keys(value).length <= 32) return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${scalar(item, depth + 1)}`).join(", ")} }`;
  throw new Error("unsupported managed model setting");
};
function managedConfig(raw: string): { config: string; lock: string } {
  const config = Bun.TOML.parse(raw) as Record<string, unknown>;
  if (!object(config.providers) || !object(config.models) || typeof config.default_model !== "string") throw new Error("managed Kimi configuration required");
  const provider = config.providers[MANAGED], model = config.models[config.default_model];
  if (!object(provider) || provider.type !== "kimi" || provider.api_key && provider.api_key !== "" || !object(provider.oauth) || provider.oauth.storage !== "file" || !object(model) || model.provider !== MANAGED) throw new Error("managed file-backed Kimi OAuth required");
  const oauth = provider.oauth;
  const key = oauth.key;
  const lock = !key || key === "kimi-code" || key === "oauth/kimi-code" ? "kimi-code" : typeof key === "string" && key.startsWith("oauth/") ? key.slice(6) : key;
  if (typeof lock !== "string" || !lock || basename(lock) !== lock || lock.startsWith(".")) throw new Error("unsupported OAuth slot");
  if (typeof provider.base_url !== "string") throw new Error("managed Kimi endpoint required");
  const endpoint = new URL(provider.base_url);
  if (endpoint.protocol !== "https:" || !["api.kimi.ai", "api.kimi.com"].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw new Error("unsupported managed Kimi endpoint");
  if (oauth.oauth_host !== undefined) {
    const auth = new URL(String(oauth.oauth_host));
    if (auth.protocol !== "https:" || !["auth.kimi.ai", "auth.kimi.com"].includes(auth.hostname) || auth.username || auth.password) throw new Error("unsupported OAuth endpoint");
  }
  const lines = ["telemetry = false", "hooks = []", `default_model = ${scalar(config.default_model)}`,
    ...(config.thinking === undefined ? [] : [`thinking = ${scalar(config.thinking)}`]),
    `[providers.${scalar(MANAGED)}]`, 'type = "kimi"', `base_url = ${scalar(provider.base_url)}`, `[providers.${scalar(MANAGED)}.oauth]`];
  for (const name of ["storage", "key", "oauth_host"]) if (oauth[name] !== undefined) lines.push(`${name} = ${scalar(oauth[name])}`);
  lines.push(`[models.${scalar(config.default_model)}]`);
  const modelFields = ["provider", "model", "protocol", "max_context_size", "max_input_size", "capabilities", "display_name", "support_efforts", "default_effort", "beta_api", "adaptive_thinking", "overrides"];
  if (Object.keys(model).some(name => !modelFields.includes(name))) throw new Error("unsupported managed model setting");
  if (model.overrides !== undefined && (!object(model.overrides) || Object.keys(model.overrides).some(name => !modelFields.includes(name) || ["provider", "overrides"].includes(name)))) throw new Error("unsupported managed model override");
  for (const name of modelFields) if (model[name] !== undefined) lines.push(`${name} = ${scalar(model[name])}`);
  return { config: lines.join("\n") + "\n", lock };
}
function mcpConfig(context: ReviewerPrepareContext): string {
  const config: unknown = JSON.parse(context.mcpConfig);
  if (!object(config) || !object(config.mcpServers)) throw new Error("review MCP unavailable");
  if (context.task === undefined && Object.keys(config.mcpServers).length === 0) return context.mcpConfig;
  if (Object.keys(config.mcpServers).join() !== "agent-hub") throw new Error("ambient MCP refused");
  const server = config.mcpServers["agent-hub"];
  if (!object(server) || Object.keys(server).some(k => !["transport", "url", "headers"].includes(k)) || server.transport !== "http" || typeof server.url !== "string" || !object(server.headers) || Object.keys(server.headers).join() !== "Authorization" || typeof server.headers.Authorization !== "string" || !server.headers.Authorization.startsWith("Bearer ")) throw new Error("task-bound HTTP MCP required");
  const url = new URL(server.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) throw new Error("local review MCP required");
  return context.mcpConfig;
}
async function version(command: readonly string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  return await new Promise((accept, reject) => {
    const child = spawn(command[0]!, [...command.slice(1), "--version"], { cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let text = "", done = false;
    const finish = async (code: number | null) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      try { await stopOwnedProcess(child, { group: true }); } catch { reject(new Error("version probe cleanup failed")); return; }
      if (code !== 0 || signal.aborted) reject(new Error("version probe failed")); else accept(text.trim());
    };
    const abort = () => { void finish(null); };
    const timer = setTimeout(abort, 5_000);
    signal.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => trackGroup(child));
    child.stdout.on("data", (bytes: Buffer) => { text += bytes.toString(); if (text.length > 4096) abort(); });
    child.once("error", () => { void finish(null); }); child.once("close", code => { void finish(code); });
    if (signal.aborted) abort();
  });
}
/** Do not SIGKILL a live native refresh holder. A bounded incomplete stop retains the peer handle. */
export async function stopKimiReview(child: ChildProcess, locks: readonly string[], graceMs = 10_000): Promise<void> {
  const locked = () => locks.some(file => existsSync(file));
  if (child.exitCode === null && child.signalCode === null && locked()) {
    child.kill("SIGTERM");
    const end = Date.now() + graceMs;
    while (child.exitCode === null && child.signalCode === null && locked() && Date.now() < end) await Bun.sleep(50);
    if (child.exitCode === null && child.signalCode === null && locked()) throw new Error("Kimi OAuth refresh still locked; graceful stop incomplete");
  }
  await stopOwnedProcess(child, { group: true });
}

export const kimiReviewerBackend: ReviewerBackend = {
  id: "kimi", taskMcp: true, nativePolicy: true,
  async prepare(context) {
    let own: string | undefined;
    try {
      if (context.signal.aborted) throw new Error("cancelled");
      const sourcePath = process.env.KIMI_CODE_HOME ?? join(process.env.HOME ?? homedir(), ".kimi-code"), source = realPath(sourcePath);
      const sourceConfig = join(source, "config.toml"), original = read(sourceConfig), selected = managedConfig(original);
      const sources = ["credentials", "oauth", "device_id"].map(name => realPath(join(source, name)));
      if (!sources.every((file, index) => index < 2 ? lstatSync(file).isDirectory() : lstatSync(file).isFile())) throw new Error("native OAuth directories and device identity required");
      const mcp = mcpConfig(context);
      if (Buffer.byteLength(context.input ?? "") > 1_048_576) throw new Error("review facts exceed limit");
      own = realPath(mkdtempSync(join(tmpdir(), "ahub-kimi-review-")));
      const root = own, home = join(root, "home"), tool = join(root, "tool"), cwd = join(root, "workspace"), skills = join(root, "empty-skills"), temporary = join(root, "tmp");
      for (const dir of [home, tool, cwd, skills, temporary]) mkdirSync(dir, { mode: 0o700 });
      ["credentials", "oauth", "device_id"].forEach((name, index) => symlinkSync(sources[index]!, join(tool, name), index < 2 ? "dir" : "file"));
      const agentFile = join(cwd, "reviewer.md"), configFile = join(tool, "config.toml"), mcpFile = join(tool, "mcp.json");
      writeFileSync(configFile, selected.config, { mode: 0o600 }); writeFileSync(mcpFile, mcp, { mode: 0o600 });
      writeFileSync(agentFile, `---\nname: hub-reviewer\ndescription: Fresh agent-hub reviewer\ntools:\n  - mcp__agent-hub__hub_review\n  - mcp__agent-hub__hub_task_show\nsubagents: []\n---\n\n${context.systemPrompt}\n\nUse only the supplied public facts and hub_task_show. Never claim to have read evidence that was not supplied.\n\n${context.input ?? "No review is active; startup self-check only."}\n`, { mode: 0o600 });
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KIMI_CODE_HOME: tool, TMPDIR: `${temporary}/`, XDG_CONFIG_HOME: join(home, ".config"), LANG: process.env.LANG ?? "en_US.UTF-8", TERM: "dumb", ...(process.env.USER ? { USER: process.env.USER } : {}) };
      const native = context.command ?? [Bun.which("kimi", { PATH: process.env.PATH }) ?? "kimi"];
      const executable = realPath(Bun.which(native[0]!, { PATH: process.env.PATH }) ?? resolve(native[0]!));
      const command = [executable, ...native.slice(1)];
      const executableStat = lstatSync(executable);
      if (await version(command, cwd, env, context.signal) !== VERSION) throw new Error("unsupported Kimi version; receipt covers 2.2.0");
      const fingerprints = [configFile, mcpFile, agentFile].map(file => hash(read(file, 2_097_152)));
      let cleaned = false;
      const cleanup = () => { if (cleaned) return; rmSync(root, { recursive: true, force: true }); cleaned = true; };
      return { command, args: ["-p", "Review the supplied task facts and record the evidence-based verdict with hub_review.", "--output-format", "stream-json", "--agent-file", agentFile, "--skills-dir", skills],
        cwd, env, envMode: "replace", cleanup, watchCurrent: true,
        stop: child => stopKimiReview(child, [join(sources[1]!, "kimi-code.lock"), join(sources[1]!, `${selected.lock}.lock`)]),
        current: () => {
          try {
            const now = lstatSync(executable);
            return !cleaned && !context.signal.aborted && realPath(sourcePath) === source && now.dev === executableStat.dev && now.ino === executableStat.ino && now.size === executableStat.size && now.mtimeMs === executableStat.mtimeMs && now.ctimeMs === executableStat.ctimeMs && hash(read(sourceConfig)) === hash(original)
              && [configFile, mcpFile, agentFile].every((file, index) => hash(read(file, 2_097_152)) === fingerprints[index])
              && ["credentials", "oauth", "device_id"].every((name, index) => realPath(join(source, name)) === sources[index] && realPath(join(tool, name)) === sources[index]);
          } catch { return false; }
        },
        isolation: { backend: "kimi", version: VERSION, binary: executable, profile: "private-config-exact-two-tools-shared-native-oauth", readOnly: true, strictMcp: true, ephemeral: true,
          enforcement: "native-policy", freshSession: true, hubToolsOnly: true,
          evidence: ["#533 person ruling2026-10-19: native execution-time exact tool allowlist, no kernel sandbox", "private config/cwd/empty skills; shared OAuth directory symlinks and native lock/atomic rename", "task-bound in-process hub MCP; no full control token", "residual: interruption mid-refresh may require native re-login"] },
      };
    } catch (error) {
      if (own) rmSync(own, { recursive: true, force: true });
      return { unavailable: `Kimi reviewer unavailable: ${(error as Error).message}` };
    }
  },
};
