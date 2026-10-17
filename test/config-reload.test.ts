import { expect, test } from "bun:test";
import { parseConfigSources, type ConfigSourceTexts } from "../src/hub/config-reload.ts";

const base = '[local]\nfixed_model = "fixed/model"\n';
const texts = (routing: string): ConfigSourceTexts => ({ "config.json": '{"research":{"enabled":true}}', "config.local.json": null, "routing.toml": routing, "routing.local.toml": null });

for (const [name, routing] of [
  ["unknown top key", 'routing_typo = true\n' + base],
  ["unknown local key", base + 'typo = true\n'],
  ["primitive peers", base + '[classes.implement]\npeers = "codex"\n'],
  ["invalid constraint", base + '[constraints]\npii = "send_cloud"\n'],
  ["invalid context number", base + '[signals]\nlong_context_tokens = -1\n'],
] as const) test(`#439 strict routing preflight rejects ${name} with simultaneous valid config edit`, () => {
  const accepted = parseConfigSources({ ...texts(base), "config.json": '{"research":{"enabled":false}}' });
  const snapshot = structuredClone(accepted), candidate = texts(routing);
  expect(() => parseConfigSources(candidate)).toThrow();
  expect(accepted).toEqual(snapshot);
  expect(candidate["config.json"]).toBe('{"research":{"enabled":true}}');
});

test("#439 strict routing preserves open Switchyard table fields and explicit startup fallback", () => {
  const routing = base + '[targets.custom]\nid = "provider/model"\ncustom_option = 1\n[targets.custom.extension]\nflag = true\n[routes.custom]\ntype = "custom_switchyard_type"\ncustom_option = "kept"\n';
  const accepted = parseConfigSources(texts(routing));
  expect(accepted.routing.targets.custom?.custom_option).toBe(1);
  expect(accepted.routing.routes.custom?.custom_option).toBe("kept");
  expect(parseConfigSources(texts(base + '[classes.implement]\npeers="codex"\n'), accepted.routing).routing).toBe(accepted.routing);
});
