/**
 * The user skill directory each native host reads (#1622).
 *
 * `ahub setup` installs the hub's own skills into these directories, so the per-host knowledge lives here, with the
 * other native facts, and `src/cli/skills-install.ts` carries no host name of its own. Each entry is from that host's
 * own source or help output (docs/agent-notes/adapters.md): Codex `_codex_home()/skills`, Kimi
 * `$KIMI_CODE_HOME/skills`, Qwen `getGlobalQwenDir()/skills`, Jcode the global `~/.jcode/skills`, Pi the global agent
 * dir's `skills`, agy `~/.gemini/config/skills`.
 *
 * Claude Code is absent on purpose: it reads the skills from the installed plugin, never from a user skill directory.
 * The hub's own local worker is absent too, because it receives the hub tools directly.
 */
import { join } from "node:path";

export const SKILL_HOSTS = ["codex", "kimi", "qwen", "jcode", "pi", "agy"] as const;
export type SkillHost = (typeof SKILL_HOSTS)[number];

export function hostSkillDir(host: SkillHost, home: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.HOME?.trim() || home;
  const skills = (...segments: string[]) => join(...segments, "skills");
  switch (host) {
    case "codex": return skills(env.CODEX_HOME?.trim() || join(base, ".codex"));
    case "kimi": return skills(env.KIMI_CODE_HOME?.trim() || join(base, ".kimi-code"));
    case "qwen": return skills(env.QWEN_HOME?.trim() || join(base, ".qwen"));
    case "jcode": return skills(env.JCODE_HOME?.trim() || join(base, ".jcode"));
    case "pi": return skills(env.PI_CODING_AGENT_DIR?.trim() || join(base, ".pi", "agent"));
    case "agy": return skills(base, ".gemini", "config");
  }
}
