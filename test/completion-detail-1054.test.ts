import { expect, test } from "bun:test";
import { PRIVATE_DETAIL, PROMPT_HEAD_MAX, promptHead, resultDetail, WITHHELD_DETAIL } from "../src/hub/completion-detail.ts";

// #1054 T6: the detail of a result is built at display from facts the daemon passes in; nothing here stores, logs or emits anything.
const safe = (text: string) => !/SECRET|sk-[a-z0-9]{20}/i.test(text);

test("a private run is a stub and its body is never read, even when one is passed", () => {
  let read = false;
  const input = { private: true, safe: () => { read = true; return true; } } as { private: boolean; body?: string; safe: (text: string) => boolean };
  Object.defineProperty(input, "body", { get() { read = true; return "SECRET private words"; } });
  expect(resultDetail(input)).toEqual({ kind: "stub", text: PRIVATE_DETAIL });
  expect(read).toBe(false);                                                               // neither the body nor the screen was touched
  expect(resultDetail({ private: true, body: "anything", safe })).toEqual({ kind: "stub", text: PRIVATE_DETAIL });
});

test("no body is no detail, a head the screens refuse is a withheld stub, and a clean head is the head", () => {
  expect(resultDetail({ private: false, safe })).toEqual({ kind: "none" });
  expect(resultDetail({ private: false, body: "", safe })).toEqual({ kind: "none" });
  expect(resultDetail({ private: false, body: " \n\t ", safe })).toEqual({ kind: "none" });
  expect(resultDetail({ private: false, body: "my SECRET is here", safe })).toEqual({ kind: "stub", text: WITHHELD_DETAIL });
  expect(resultDetail({ private: false, body: "summarise the notes", safe })).toEqual({ kind: "head", text: "summarise the notes" });
  // no screen at all is not "clean": a head is shown only when a screen cleared it
  expect(resultDetail({ private: false, body: "summarise the notes" })).toEqual({ kind: "stub", text: WITHHELD_DETAIL });
});

test("the screen sees what could leak even when the bound would cut it off: a secret after the head's cut still withholds", () => {
  const body = `${"a".repeat(PROMPT_HEAD_MAX + 40)} then a SECRET far past the shown head`;
  expect(promptHead(body).includes("SECRET")).toBe(false);                                // the shown head does not contain it
  expect(resultDetail({ private: false, body, safe })).toEqual({ kind: "stub", text: WITHHELD_DETAIL });   // yet the request is withheld: the screen reads the longer span
});

test("the head is one bounded line, cut by code point with an ellipsis, control characters and blanks collapsed", () => {
  expect(promptHead("  a \n\t b\u0007c\u2028d  ")).toBe("a b c d");
  const long = promptHead("x".repeat(500));
  expect(Array.from(long)).toHaveLength(PROMPT_HEAD_MAX); expect(long.endsWith("\u2026")).toBe(true);
  const emoji = promptHead("\u{1F642}".repeat(300), 10);
  expect(Array.from(emoji)).toHaveLength(10);                                              // never half an emoji
  expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  // the bound counts code points: six emoji are twelve UTF-16 units, under a bound of ten code points, so nothing is cut
  expect(promptHead("\u{1F642}".repeat(6), 10)).toBe("\u{1F642}".repeat(6));
  expect(promptHead("short")).toBe("short");
  expect(promptHead("x".repeat(PROMPT_HEAD_MAX))).toHaveLength(PROMPT_HEAD_MAX);          // exactly the bound is not cut
});
