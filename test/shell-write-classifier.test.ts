import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyShellWrite } from "../src/hub/task-shell-command.ts";
import { Facts, MAX_RECEIPTS_PER_PEER } from "../src/hub/facts.ts";

const k = (c: string) => classifyShellWrite(c).kind;
test("writes", () => {
  for (const c of ["sed -i 's/a/b/' f.ts", "perl -pi -e 's/a/b/' f", "awk -i inplace '{print}' f", "echo x > f", "echo x >> f", "echo x | tee f", "dd if=a of=f", "cp a f", "mv a f", "patch -p1 f", "git apply x.diff"])
    expect([c, k(c)]).toEqual([c, "write"]);
  expect(classifyShellWrite("echo hi>f.ts")).toEqual({ kind: "write", targets: ["f.ts"] });
  expect(classifyShellWrite("sed -i '' 's/a/b/' f.ts")).toEqual({ kind: "write", targets: ["f.ts"] });
  expect(classifyShellWrite("cat <<EOF > out.ts\na > b\nEOF")).toEqual({ kind: "write", targets: ["out.ts"] });
  expect(k("sed -i -e 's/a/b/' f.ts")).toBe("unknown");
  expect(classifyShellWrite("echo 'a; tee victim.ts; b'")).toEqual({ kind: "read", targets: [] });
  for (const c of ["bash <<EOF\necho hi > f.ts\nEOF", "cat <<EOF | sh\nrm f\nEOF", "python3 - <<EOF\nopen('f','w')\nEOF", "echo \"<<X\"\nsed -i s/a/b/ f.ts", "cat <<EOF\nnever ends", "echo 'unbalanced"])
    expect([c, k(c)]).toEqual([c, c.startsWith("echo \"<<X") ? "write" : "unknown"]);
  expect(k("python3 -c \"open('f','w').write('x')\"")).toBe("unknown");
});
test("not writes", () => {
  for (const c of ["bun test 2>&1", "ls > /dev/null", "grep '>' src/a.ts", "grep -rn \"a > b\" .", "cat <<EOF > /tmp/x\nhi\nEOF", "git diff", "git apply --check x.diff", "cat <<EOF > /tmp/x\na > b\nEOF", "cat <<'EOF'\necho hi>g.ts\nEOF", "sed -n 1,5p f"])
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

test("a whole Read records full only when Read does not cut the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-"));
  const f = new Facts({ root: dir, tmp: join(dir, ".t"), instance: "i", scope: () => ({ paths: [], plans: [], task: { id: 7, title: "t" } }), peers: () => [], nameable: () => true } as any);
  const read = (name: string, text: string | undefined, input: Record<string, unknown> = {}) => {
    if (text !== undefined) writeFileSync(join(dir, name), text);
    f.preTool("p" as any, `u-${name}`, "Read", { file_path: join(dir, name), ...input });
    f.postTool("p" as any, `u-${name}`, "Read", { file_path: join(dir, name), ...input });
    return f.readReceipt("p" as any, 7, name);
  };
  expect(read("small.ts", "a\nb\n")?.scope).toBe("full");
  expect(read("off.ts", "a\nb\n", { offset: 1 })?.scope).toBe("partial");
  expect(read("long.ts", "x\n".repeat(2500))?.scope).toBe("partial");
  expect(read("missing.ts", undefined)).toBeUndefined();
});
