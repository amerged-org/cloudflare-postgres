// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { IsolateCache } from "../../src/domain/isolate-cache.ts";

it("holds a value for its time to live and not a millisecond longer", () => {
  const cache = new IsolateCache<string>(1000, 4);
  cache.set("a", "one", 10_000);
  expect(cache.get("a", 10_999)).toBe("one");
  expect(cache.get("a", 11_000)).toBeUndefined();
  expect(cache.get("a", 10_500)).toBeUndefined();
});

it("makes room by dropping the entry that was set longest ago, and a set renews its key", () => {
  const cache = new IsolateCache<number>(1000, 2);
  cache.set("a", 1, 0);
  cache.set("b", 2, 0);
  cache.set("a", 3, 0);
  cache.set("c", 4, 0);
  expect(cache.get("b", 1)).toBeUndefined();
  expect(cache.get("a", 1)).toBe(3);
  expect(cache.get("c", 1)).toBe(4);
});

it("forgets an entry at once when asked", () => {
  const cache = new IsolateCache<number>(1000, 2);
  cache.set("a", 1, 0);
  cache.delete("a");
  expect(cache.get("a", 1)).toBeUndefined();
});

it("does not trust an entry for longer than its time to live when the clock was set back", () => {
  const cache = new IsolateCache<string>(1000, 4);
  cache.set("a", "one", 50_000);
  expect(cache.get("a", 50_500)).toBe("one");
  expect(cache.get("a", 10_000)).toBeUndefined();
});
