import { expect, test } from "bun:test";
import vectors from "./fixtures/execution-reference-v1.json";
import { parseExecutionReference } from "../src/hub/execution-reference.ts";

for (const vector of vectors.vectors) test(`ExecutionReferenceV1: ${vector.name}`, () => {
  if (vector.valid) expect(parseExecutionReference(vector.input) as unknown).toEqual(vector.input);
  else expect(() => parseExecutionReference(vector.input)).toThrow("ExecutionReferenceV1 contract");
});
test("addresses are data: no accessors, symbols, inherited fields or resolver options", () => {
  const ref = vectors.vectors[0]!.input;
  let invoked = false;
  expect(() => parseExecutionReference({ ...ref, get revision() { invoked = true; return "1"; } })).toThrow();
  expect(invoked).toBe(false);
  expect(() => parseExecutionReference({ ...ref, [Symbol("authority")]: true })).toThrow();
  expect(() => parseExecutionReference(Object.create(ref))).toThrow();
  expect(() => parseExecutionReference({ ...ref, resolve: true })).toThrow();
  // Path/URL-looking opaque ids do not initiate resolution. They remain exact data.
  expect(parseExecutionReference({ ...ref, id: "/not/a/resolver" }).id).toBe("/not/a/resolver");
});
