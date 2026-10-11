import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";

import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { realPath } from "./project.ts";
import { profile, sandboxAvailable } from "../local/sandbox.ts";
export type ProjectionConfig = Record<string, string[]>;
export const MAX_PROJECTION_INPUT = 16 * 1024 * 1024;
const MAX_INPUT = MAX_PROJECTION_INPUT, MAX_TEXT = 256 * 1024;
/** Only machine-local config chooses programs; no implicit shell or command-string parsing. */
export function projectionConfig(raw: unknown): ProjectionConfig {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 16) throw new Error("text_projection must be a bounded extension-to-argv map");
  const out: ProjectionConfig = Object.create(null);
  for (const [ext, argv] of Object.entries(raw)) {
    if (!/^\.[a-z0-9]{1,16}$/.test(ext) || !Array.isArray(argv) || !argv.length || argv.length > 16 || argv.some(arg => typeof arg !== "string" || !arg || arg.length > 2000 || /[\x00-\x1f\x7f]/.test(arg)) || argv.filter(arg => arg === "{input}").length !== 1 || argv[0] === "{input}") throw new Error("text_projection entries require a bounded argv with one separate {input} argument");
    out[ext] = [...argv];
  }
  return out;
}
export interface ProjectedText { inputHash: string; rawHash: string; rawBlob: string; configHash: string; text: string }
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function commandFingerprint(cwd: string, argv: string[]): string {
  const parts = [JSON.stringify(argv)];
  for (const [index, arg] of argv.entries()) {
    if (index !== 0 && !/\.(?:sh|py|js|ts|rb)$/.test(arg)) continue;
    const choices = isAbsolute(arg) ? [arg] : index === 0 && !arg.includes("/") ? (process.env.PATH ?? "/usr/bin:/bin").split(":").slice(0, 32).map(dir => join(dir, arg)) : [resolve(cwd, arg)];
    for (const file of choices) try { const st = statSync(file); if (!st.isFile()) continue; parts.push(file, String(st.size), String(st.mtimeMs), String(st.ctimeMs)); break; } catch { /* another PATH entry */ }
  }
  return hash(parts.join("\\n"));
}
function boundedCache(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_TEXT * 2) throw new Error("invalid cache file");
    const bytes = Buffer.alloc(st.size); let got = 0;
    while (got < bytes.length) { const n = readSync(fd, bytes, got, bytes.length - got, got); if (!n) break; got += n; }
    if (got !== st.size) throw new Error("cache changed");
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}
/** Projections are presentation evidence, never proof of who wrote the original bytes. */
export class TextProjections {
  private readonly sandbox: string;
  private readonly warned = new Set<string>();
  constructor(private readonly options: { cwd: string; stateDir: string; config: ProjectionConfig; deny?: string[]; readAllow?: string[]; log?: (line: string) => void }) {
    this.sandbox = Object.keys(options.config).length ? profile(options.cwd, false, options.readAllow, options.deny, ["."]) : "";
  }
  private warn(ext: string): void {
    if (this.warned.has(ext)) return;
    this.warned.add(ext); this.options.log?.("text projection " + ext + " unavailable; retained original facts behavior");
  }
  project(file: string): ProjectedText | undefined {
    const ext = extname(file).toLowerCase(), argv = this.options.config[ext];
    if (!argv) return undefined;
    let fd: number | undefined, scratch: string | undefined;
    try {
      const root = realPath(this.options.cwd), input = realPath(file);
      if (!input.startsWith(root + "/")) throw new Error("input outside project");
      fd = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > MAX_INPUT) throw new Error("input cap");
      const bytes = Buffer.alloc(before.size); let got = 0;
      while (got < bytes.length) { const n = readSync(fd, bytes, got, bytes.length - got, got); if (!n) break; got += n; }
      const after = fstatSync(fd);
      if (got !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("input changed");
      const rawHash = createHash("sha1").update(bytes).digest("hex"), rawBlob = createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
      const inputHash = hash(bytes), configHash = commandFingerprint(this.options.cwd, argv), key = hash(inputHash + "\n" + configHash);
      const cacheDir = join(this.options.stateDir, "text-projections"), cache = join(cacheDir, key + ".json");
      try {
        const cached = boundedCache(cache);
        if (Buffer.byteLength(cached) <= MAX_TEXT * 2) {
          const value = JSON.parse(cached) as ProjectedText;
          if (value.inputHash === inputHash && value.rawHash === rawHash && value.rawBlob === rawBlob && value.configHash === configHash && typeof value.text === "string" && Buffer.byteLength(value.text) <= MAX_TEXT) return value;
        }
      } catch { /* missing/invalid cache is not evidence */ }
      if (!sandboxAvailable()) throw new Error("sandbox unavailable");
      const inputs = join(this.options.stateDir, "projection-inputs"); mkdirSync(inputs, { recursive: true });
      scratch = mkdtempSync(join(inputs, "owned-")); const snapshot = join(scratch, "input" + ext);
      writeFileSync(snapshot, bytes, { mode: 0o400 });
      const result = spawnSync(process.execPath, [join(import.meta.dir, "projection-exec.ts")], {
        cwd: this.options.cwd, timeout: 8000, maxBuffer: MAX_TEXT * 2, encoding: "utf8",
        input: JSON.stringify({ cwd: this.options.cwd, sandbox: this.sandbox, argv: argv.map(arg => arg === "{input}" ? snapshot : arg) }),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), LANG: "en_US.UTF-8", TERM: "dumb" },
      });
      if (result.error || result.status !== 0) throw new Error("conversion failed");
      const converted = JSON.parse(result.stdout) as { ok?: boolean; text?: string };
      if (converted.ok !== true || typeof converted.text !== "string" || Buffer.byteLength(converted.text) > MAX_TEXT || converted.text.includes("\\0")) throw new Error("conversion failed");
      const final = fstatSync(fd);
      if (final.size !== before.size || final.mtimeMs !== before.mtimeMs) throw new Error("input changed during conversion");
      const value = { inputHash, rawHash, rawBlob, configHash, text: converted.text };
      mkdirSync(cacheDir, { recursive: true });
      const temporary = cache + "." + crypto.randomUUID() + ".tmp";
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, cache);
      return value;
    } catch { this.warn(ext); return undefined; }
    finally { if (fd !== undefined) closeSync(fd); if (scratch) rmSync(scratch, { recursive: true, force: true }); }
  }
}
