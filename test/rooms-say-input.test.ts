import { expect, test } from "bun:test";
import { sayRecipients } from "../src/cli/say-input.ts";

test("say keeps explicit remote and local addresses out of the message body", () => {
  expect(sayRecipients(["@codex@guest", "@claude", "hello", "there"])).toEqual({ to: ["codex@guest", "claude"], text: ["hello", "there"] });
  expect(sayRecipients(["hello", "@codex@guest"])).toEqual({ to: [], text: ["hello", "@codex@guest"] });
  expect(sayRecipients(["@claude", "hello"])).toEqual({ to: ["claude"], text: ["hello"] });
});
test("a malformed leading remote address refuses instead of silently broadcasting", () => {
  for (const invalid of ["@codex@guest\n", "@codex@guest@other", "@hub@guest", "@codex@../guest"]) {
    expect(() => sayRecipients(["@claude", invalid, "private intended recipient"])).toThrow("invalid remote peer address");
  }
});
