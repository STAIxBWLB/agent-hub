import { expect, test } from "bun:test";
import { join } from "node:path";

test("sealed-study summary export is safe, reconciled and hash-bound (#171)", async () => {
  const child = Bun.spawn(["python3", "-B", join(import.meta.dir, "study_export_test.py")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
}, 20_000);
