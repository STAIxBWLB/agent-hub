import { expect, test } from "bun:test";
import { listenWithoutPortCollision } from "../src/hub/listen.ts";

test("automatic control allocation keeps requested peer ports occupied until a distinct replacement exists", () => {
  const stopped: number[] = [], held: number[] = [], ports = [31001, 31002, 31003];
  const selected = listenWithoutPortCollision(() => {
    expect(stopped).toEqual([]);
    const port = ports[held.length]!; held.push(port);
    return { port, stop: (active?: boolean) => { expect(active).toBe(true); stopped.push(port); } };
  }, [31001, 31002]);
  expect(selected.port).toBe(31003); expect(stopped).toEqual([31001, 31002]);
});

test("automatic control allocation releases only its rejected listeners when replacement binding fails", () => {
  let calls = 0; const stopped: number[] = [];
  expect(() => listenWithoutPortCollision(() => {
    if (calls++) throw new Error("replacement bind failed");
    return { port: 31001, stop: () => { stopped.push(31001); } };
  }, [31001])).toThrow("replacement bind failed");
  expect(stopped).toEqual([31001]);
});

test("explicit control allocation preserves its first listener and bounded rejection cannot loop forever", () => {
  let stopped = 0, calls = 0;
  const listener = { port: 31001, stop: () => { stopped++; } };
  expect(listenWithoutPortCollision(() => listener, [])).toBe(listener); expect(stopped).toBe(0);
  expect(() => listenWithoutPortCollision(() => { calls++; return { ...listener }; }, [31001])).toThrow("automatic control listener could not avoid requested peer ports");
  expect(calls).toBe(2); expect(stopped).toBe(2);
});
