import { expect, test } from "bun:test";
import { classifyShellWrite } from "../src/hub/task-shell-command.ts";
import { Facts, MAX_RECEIPTS_PER_PEER } from "../src/hub/facts.ts";

const k = (c: string) => classifyShellWrite(c).kind;
test("writes", () => {
  for (const c of ["sed -i 's/a/b/' f.ts", "perl -pi -e 's/a/b/' f", "awk -i inplace '{print}' f", "echo x > f", "echo x >> f", "echo x | tee f", "dd if=a of=f", "cp a f", "mv a f", "patch -p1 f", "git apply x.diff"])
    expect([c, k(c)]).toEqual([c, "write"]);
  expect(k("python3 -c \"open('f','w').write('x')\"")).toBe("unknown");
});
test("not writes", () => {
  for (const c of ["bun test 2>&1", "ls > /dev/null", "grep '>' src/a.ts", "grep -rn \"a > b\" .", "cat <<EOF > /tmp/x\nhi\nEOF", "git diff", "git apply --check x.diff", "sed -n 1,5p f"])
    expect([c, k(c)]).toEqual([c, "read"]);
});
test("receipts bounded, evicted on close, not persisted", () => {
  const f = new Facts({ root: "/tmp" } as any);
  for (let i = 0; i < MAX_RECEIPTS_PER_PEER + 5; i++) f.recordRead("p" as any, 1, `f${i}`, { sha256: "x", scope: "full", turnId: "t" });
  expect(f.readReceipt("p" as any, 1, "f0")).toBeUndefined();
  expect(f.readReceipt("p" as any, 1, `f${MAX_RECEIPTS_PER_PEER + 4}`)).toBeDefined();
  f.closeTask(1);
  expect(f.readReceipt("p" as any, 1, `f${MAX_RECEIPTS_PER_PEER + 4}`)).toBeUndefined();
});
