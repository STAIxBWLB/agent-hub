// @bun
// src/adapters/kimi-review-policy-worker.ts
import { isMainThread, parentPort, workerData, Worker } from "worker_threads";

// src/adapters/kimi-review-policy.ts
import { createHash } from "crypto";
import { lstatSync, readFileSync } from "fs";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "path";

// node_modules/@staix/agent-mem/src/memory/platform.ts
import { realpathSync } from "fs";
import { basename, dirname, join, resolve, sep } from "path";
import { createRequire } from "module";
var require2 = createRequire(import.meta.url);
var processes;
var childProcess = () => processes ??= require2("node:child_process");
function realPath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!resolve(path).includes("\\"))
      throw error;
    const argv = process.platform === "darwin" ? ["/bin/realpath", "--", path] : ["realpath", "-e", "--", path];
    const r = childProcess().spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout.endsWith(`
`))
      throw error;
    return r.stdout.slice(0, -1);
  }
}
var DENY_NAMES = ["^\\.env", "\\.pem$", "\\.key$", "^id_rsa", "^id_ed25519", "^credentials(\\.|$)", "^auth\\.json$", "^\\.netrc$", "^\\.npmrc$", "^\\.pypirc$"];
var denyNamePatterns = new Map(DENY_NAMES.map((source) => [source, new RegExp(source)]));
var CREDENTIAL_KEYS = new Set(["credential.helper=", "core.askpass="]);
// src/adapters/kimi-review-policy.ts
var kimiReviewFingerprint = (text) => createHash("sha256").update(text).digest("hex");
function readKimiReviewFile(file, limit = 262144) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > limit)
    throw new Error("unsupported reviewer file");
  return readFileSync(file, "utf8");
}
function assertCleanCwdAncestors(...candidates) {
  const seen = new Set;
  for (const candidate of candidates) {
    let ancestor = resolve2(candidate);
    for (;; ) {
      if (!seen.has(ancestor)) {
        seen.add(ancestor);
        for (const marker of [".git", ".kimi-code", "AGENTS.md"]) {
          if (lstatSync(join2(ancestor, marker), { throwIfNoEntry: false }) !== undefined) {
            throw new Error("private cwd ancestor contains ambient configuration");
          }
        }
      }
      const parent = dirname2(ancestor);
      if (parent === ancestor)
        break;
      ancestor = parent;
    }
  }
}
function projectKimiReviewPolicyBinding(binding) {
  return Object.freeze({
    lexicalCwd: binding.lexicalCwd,
    physicalCwd: binding.physicalCwd,
    sourcePath: binding.sourcePath,
    source: binding.source,
    sourceConfig: binding.sourceConfig,
    sourceConfigHash: binding.sourceConfigHash,
    executable: binding.executable,
    executableStat: Object.freeze({
      dev: binding.executableStat.dev,
      ino: binding.executableStat.ino,
      size: binding.executableStat.size,
      mtimeMs: binding.executableStat.mtimeMs,
      ctimeMs: binding.executableStat.ctimeMs
    }),
    privateFiles: Object.freeze(binding.privateFiles.map((file) => Object.freeze({ path: file.path, hash: file.hash }))),
    tool: binding.tool,
    authTargets: Object.freeze(binding.authTargets.map((target) => target))
  });
}
function checkKimiReviewPolicy(binding) {
  try {
    assertCleanCwdAncestors(binding.lexicalCwd, binding.physicalCwd);
    const now = lstatSync(binding.executable), expected = binding.executableStat;
    return realPath(binding.sourcePath) === binding.source && now.dev === expected.dev && now.ino === expected.ino && now.size === expected.size && now.mtimeMs === expected.mtimeMs && now.ctimeMs === expected.ctimeMs && kimiReviewFingerprint(readKimiReviewFile(binding.sourceConfig)) === binding.sourceConfigHash && binding.privateFiles.length === 3 && binding.privateFiles.every((file) => kimiReviewFingerprint(readKimiReviewFile(file.path, 2097152)) === file.hash) && binding.authTargets.length === 3 && ["credentials", "oauth", "device_id"].every((name, index) => realPath(join2(binding.source, name)) === binding.authTargets[index] && realPath(join2(binding.tool, name)) === binding.authTargets[index]);
  } catch {
    return false;
  }
}

// src/adapters/kimi-review-policy-worker.ts
function startKimiReviewPolicyWatch(binding, options = {}) {
  const projected = projectKimiReviewPolicyBinding(binding);
  if (options.gate && options.gate.byteLength !== 8)
    throw new Error("review policy fixture gate is invalid");
  let worker;
  try {
    worker = new Worker(new URL("./kimi-review-policy-worker.js", import.meta.url), {
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      workerData: { binding: projected, ...options.gate ? { gate: options.gate } : {} }
    });
  } catch {
    throw new Error("review policy worker could not start; retry the review");
  }
  let failed = false, stopping = false, exited = false, sequence = 0;
  let pending;
  let stopWork;
  let resolveExit, resolveFailure;
  const exit = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const failure = new Promise((resolve) => {
    resolveFailure = resolve;
  });
  const settle = (current) => {
    const request = pending;
    pending = undefined;
    request?.resolve(current);
  };
  const fail = () => {
    failed = true;
    resolveFailure();
    settle(false);
  };
  worker.on("error", fail);
  worker.on("exit", () => {
    exited = true;
    fail();
    resolveExit();
  });
  try {
    worker.stdout?.on("data", fail);
    worker.stderr?.on("data", fail);
    worker.on("message", (message) => {
      if (stopping || failed)
        return;
      if (!message || typeof message !== "object" || Array.isArray(message))
        return fail();
      const reply = message;
      if (Object.keys(reply).sort().join() !== "current,id" || !pending || reply.id !== pending.id || typeof reply.current !== "boolean")
        return fail();
      if (!reply.current)
        return fail();
      settle(true);
    });
  } catch {
    fail();
  }
  return {
    failure,
    check() {
      if (failed || stopping || exited)
        return Promise.resolve(false);
      if (pending || sequence >= Number.MAX_SAFE_INTEGER) {
        fail();
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        pending = { id: ++sequence, resolve };
        try {
          worker.postMessage({ id: sequence });
        } catch {
          fail();
        }
      });
    },
    stop() {
      if (stopWork)
        return stopWork;
      stopping = true;
      fail();
      stopWork = (async () => {
        if (!exited)
          await worker.terminate();
        await exit;
      })().catch(() => {
        stopWork = undefined;
        throw new Error("review policy worker stop is unconfirmed; retry stopping the review");
      });
      return stopWork;
    }
  };
}
if (!isMainThread) {
  const port = parentPort;
  if (!port || Object.keys(process.env).length !== 0 || process.execArgv.length !== 0)
    throw new Error("review policy worker environment is invalid");
  const data = workerData;
  const binding = projectKimiReviewPolicyBinding(data.binding);
  const gate = data.gate ? new Int32Array(data.gate) : undefined;
  if (gate && gate.length !== 2)
    throw new Error("review policy fixture gate is invalid");
  let last = 0;
  port.on("message", (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message))
      throw new Error("review policy request is invalid");
    const request = message;
    if (Object.keys(request).join() !== "id" || request.id !== last + 1)
      throw new Error("review policy request is invalid");
    last++;
    if (gate) {
      Atomics.add(gate, 0, 1);
      Atomics.notify(gate, 0);
      while (Atomics.load(gate, 1) === 0)
        Atomics.wait(gate, 1, 0);
    }
    port.postMessage({ id: last, current: checkKimiReviewPolicy(binding) });
  });
}
export {
  startKimiReviewPolicyWatch
};
