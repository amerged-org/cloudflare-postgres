// SPDX-License-Identifier: Apache-2.0
/**
 * A value kept in one isolate's memory for a bounded time. Isolates share nothing: a value cached
 * here can be as old as `ttlMs` after anything changed it somewhere else, so whatever is cached
 * must be safe at exactly that age, and whatever changes the value in this isolate drops the entry
 * at once with `delete`. At most `capacity` entries are held; the oldest entry makes room.
 *
 * Only a resolved value is cached, never a promise: a promise made for one request must not be
 * awaited by another.
 */
export class IsolateCache<V> {
  readonly #entries = new Map<string, { value: V; expiresAt: number }>();
  readonly ttlMs: number;
  readonly capacity: number;
  constructor(ttlMs: number, capacity: number) {
    this.ttlMs = ttlMs;
    this.capacity = capacity;
  }
  get(key: string, now = Date.now()): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    // An entry that ends further away than a time to live was set by a clock that has since been
    // set back: it is not trusted longer for that.
    if (entry.expiresAt <= now || entry.expiresAt > now + this.ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key: string, value: V, now = Date.now()): void {
    // Re-inserting moves the key to the back, so the front is always the longest held entry.
    this.#entries.delete(key);
    if (this.#entries.size >= this.capacity)
      this.#entries.delete(this.#entries.keys().next().value!);
    this.#entries.set(key, { value, expiresAt: now + this.ttlMs });
  }
  delete(key: string): void {
    this.#entries.delete(key);
  }
}
