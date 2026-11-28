import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessVersion, COMPAT, describe } from "../src/adapters/compat.ts";
import { renderAgents } from "../src/cli/agents-output.ts";
import { paint } from "../src/cli/console-state.ts";

test("agents reports verified notes and refused reasons in a counted table, with a bare empty state", () => {
  const rendered = renderAgents([
    { id: "pi", verdict: { ok: true, state: "trusted", version: "1.2.3", note: "trusted by the person" }, policy: describe("pi") },
    { id: "codex-review", verdict: { ok: false, state: "refused", version: "9.9.9", reason: "install a verified version" }, policy: describe("codex-review") },
  ]);
  const lines = rendered.map(line => paint(line, false));
  expect(lines[0]).toBe(" ahub Agents");
  expect(lines[2]).toContain("Versions");
  expect(lines[2]).toContain("2");
  expect(lines.join("\n")).toContain("trusted by the person");
  expect(lines.join("\n")).toContain("install a verified version");
  expect(renderAgents([]).map(line => paint(line, false))).toEqual(["no native agents"]);
});

test("agents trust and revoke show machine-local receipts, and list JSON keeps its exact shape", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agents-report-"));
  try {
    const fake = join(root, "probe.ts");
    writeFileSync(fake, `console.log(${JSON.stringify(COMPAT.pi.verified[0])});\n`);
    const commands = Object.fromEntries(Object.keys(COMPAT).map(id => [id, id === "pi" ? [process.execPath, fake] : [join(root, "missing")]]));
    const module = join(import.meta.dir, "../src/cli/agents.ts");
    const invoke = (args: string[]) => {
      const code = `import { runAgents } from ${JSON.stringify(module)}; runAgents(${JSON.stringify(args)}, ${JSON.stringify(commands)}, message => { throw new Error(message); });`;
      const result = Bun.spawnSync([process.execPath, "-e", code], { cwd: root,
        env: { ...process.env, AGENTHUB_HOME: root, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };
    const expected = Object.keys(COMPAT).map(raw => {
      const id = raw as keyof typeof COMPAT;
      return { id, executable: id === "pi" ? process.execPath : null,
        ...(id === "pi" ? assessVersion(id, COMPAT.pi.verified[0], []) : { ok: false, state: "unknown", reason: `${COMPAT[id].label} not found on PATH` }),
        policy: describe(id) };
    });
    expect(invoke(["--json"])).toBe(JSON.stringify(expected, null, 2) + "\n");
    const trust = invoke(["trust", "pi", "9.9.9"]);
    expect(trust).toContain("Scope");
    expect(trust).toContain("trusted on this machine: Pi 9.9.9");
    expect(trust).toContain(join(root, "agent-compat.json"));
    expect(trust).toContain("ahub agents trust pi 9.9.9 --revoke");
    const revoke = invoke(["trust", "pi", "9.9.9", "--revoke"]);
    expect(revoke).toContain("revoked: pi 9.9.9");
    expect(revoke).toContain(join(root, "agent-compat.json"));
    expect(revoke).toContain("ahub agents trust pi 9.9.9\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
