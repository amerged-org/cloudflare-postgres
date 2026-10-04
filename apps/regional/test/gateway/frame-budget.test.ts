// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { setImmediate as turn } from "node:timers/promises";
import { newDatabaseId } from "@pgcf/contracts";
import {
  BudgetedWebSocketSocket,
  DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  DEFAULT_MEMORY_LIMIT_BYTES,
  GatewayMemoryBudget,
} from "../../src/gateway/frame-budget.ts";

const mib = 1024 * 1024;

test("memory leases aggregate across a database, isolate another database and release exactly once", () => {
  const budget = new GatewayMemoryBudget(8 * mib, 4 * mib);
  const database = newDatabaseId();
  const first = budget.owner(database);
  const second = budget.owner(database);
  const other = budget.owner(newDatabaseId());
  const firstLease = first.lease();
  const secondLease = second.lease();
  const otherLease = other.lease();
  assert.equal(firstLease.grow(3 * mib), true);
  assert.equal(secondLease.grow(2 * mib), false);
  assert.equal(otherLease.grow(3 * mib), true);
  assert.equal(budget.used, 6 * mib);
  assert.equal(budget.databaseUsed(database), 3 * mib);
  first.close();
  first.close();
  firstLease.release();
  assert.equal(budget.used, 3 * mib);
  assert.equal(firstLease.grow(1), false);
  assert.equal(first.lease().grow(1), false);
  assert.equal(secondLease.grow(2 * mib), true);
  secondLease.release();
  second.close();
  other.close();
  otherLease.release();
  assert.equal(budget.used, 0);
  assert.equal(budget.databaseUsed(database), 0);
  assert.equal(budget.peak, 6 * mib);
});

test("large assemblies cannot consume the space reserved for fifty concurrent small streams", () => {
  const budget = new GatewayMemoryBudget(
    DEFAULT_MEMORY_LIMIT_BYTES,
    DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  );
  const first = budget.owner(newDatabaseId());
  const second = budget.owner(newDatabaseId());
  const firstLease = first.lease();
  const secondLease = second.lease();
  assert.equal(firstLease.grow(88 * mib), true);
  assert.equal(secondLease.grow(88 * mib), true);
  assert.equal(secondLease.grow(1), false);
  const healthy = budget.owner(newDatabaseId());
  const small = Array.from({ length: 50 }, () => healthy.lease());
  for (const lease of small) assert.equal(lease.grow(64 * 1024), true);
  assert.equal(budget.used, 176 * mib + 50 * 64 * 1024);
  healthy.close();
  first.close();
  second.close();
  assert.equal(budget.used, 0);
});

test("large holders leave per-database headroom for a healthy 1 MiB assembly and small query", () => {
  const budget = new GatewayMemoryBudget(
    DEFAULT_MEMORY_LIMIT_BYTES,
    DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  );
  const database = newDatabaseId();
  const large = budget.owner(database).lease();
  assert.equal(large.grow(88 * mib), true);
  assert.equal(
    large.grow(mib),
    false,
    "large holders cannot consume the database small-traffic reserve",
  );
  const healthy = budget.owner(database);
  const moderate = healthy.lease();
  assert.equal(moderate.grow(2 * mib + 4096, 2 * mib), true);
  assert.equal(healthy.lease().grow(200 * 2 + 256), true);
  assert.ok(
    budget.databaseUsed(database) <= DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  );
  healthy.close();
  large.release();
  assert.equal(budget.used, 0);
});

test("a doubled healthy 1 MiB assembly is protected by global headroom beside two large holders", () => {
  const budget = new GatewayMemoryBudget(
    DEFAULT_MEMORY_LIMIT_BYTES,
    DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  );
  const first = budget.owner(newDatabaseId());
  const second = budget.owner(newDatabaseId());
  assert.equal(first.lease().grow(88 * mib), true);
  assert.equal(second.lease().grow(88 * mib), true);
  const healthy = budget.owner(newDatabaseId());
  assert.equal(
    healthy.lease().grow(2 * mib + 4096, 2 * mib),
    true,
    "wire bytes, assembly copy and metadata fit the healthy reserve",
  );
  healthy.close();
  first.close();
  second.close();
  assert.equal(budget.used, 0);
});

test("zero-payload fragment metadata cannot consume the reserve protected for received medium traffic", async () => {
  const budget = new GatewayMemoryBudget(
    DEFAULT_MEMORY_LIMIT_BYTES,
    DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  );
  const first = budget.owner(newDatabaseId());
  const second = budget.owner(newDatabaseId());
  assert.equal(first.lease().grow(88 * mib), true);
  assert.equal(second.lease().grow(88 * mib), true);
  const raw = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const guarded = new BudgetedWebSocketSocket(
    raw,
    budget.owner(newDatabaseId()),
    32 * mib,
    Buffer.alloc(0),
  );
  let rejected = 0;
  guarded.on("rejected", (code) => {
    rejected = code;
  });
  guarded.resume();
  const frames = Array.from({ length: 513 }, (_, index) => {
    const frame = Buffer.alloc(6);
    frame[0] = index === 0 ? 2 : 0;
    frame[1] = 0x80;
    return frame;
  });
  raw.push(Buffer.concat(frames));
  await turn();
  assert.equal(
    rejected,
    1013,
    "received payload eligibility must not widen the existing fragment metadata guard",
  );
  const closed = once(guarded, "close");
  guarded.destroy();
  await closed;
  first.close();
  second.close();
  assert.equal(budget.used, 0);
});

test("invalid memory limits and noninteger reservations fail closed", () => {
  assert.throws(() => new GatewayMemoryBudget(0, 1), RangeError);
  assert.throws(() => new GatewayMemoryBudget(1, 2), RangeError);
  const budget = new GatewayMemoryBudget(1024, 1024);
  const lease = budget.owner(newDatabaseId()).lease();
  assert.throws(() => lease.grow(-1), RangeError);
  assert.throws(() => lease.grow(0.5), RangeError);
  assert.throws(() => lease.grow(1, 2), RangeError);
  assert.throws(() => lease.grow(1, -1), RangeError);
  assert.throws(() => lease.grow(1, 0.5), RangeError);
  assert.equal(budget.used, 0);
});

test("split extended headers reserve a whole announced frame before forwarding any payload", async () => {
  const budget = new GatewayMemoryBudget(
    DEFAULT_MEMORY_LIMIT_BYTES,
    DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  );
  const raw = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const guarded = new BudgetedWebSocketSocket(
    raw,
    budget.owner(newDatabaseId()),
    32 * mib,
    Buffer.alloc(0),
  );
  const header = Buffer.alloc(14);
  header[0] = 0x82;
  header[1] = 0xff;
  header.writeBigUInt64BE(BigInt(32 * mib), 2);
  crypto.getRandomValues(header.subarray(10));
  const forwarded = once(guarded, "data");
  for (let byte = 0; byte < header.length; byte++)
    raw.push(header.subarray(byte, byte + 1));
  const [actual] = await forwarded;
  assert.deepEqual(actual, header);
  assert.ok(budget.used >= 64 * mib);
  const closed = once(guarded, "close");
  guarded.destroy();
  await closed;
  assert.equal(budget.used, 0);
});

test("outbound queued writes reserve memory before the first socket callback and free it on error", async () => {
  const budget = new GatewayMemoryBudget(8 * mib, 4 * mib);
  const callbacks: ((error?: Error | null) => void)[] = [];
  const raw = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  raw.on("error", () => {});
  const guarded = new BudgetedWebSocketSocket(
    raw,
    budget.owner(newDatabaseId()),
    32 * mib,
    Buffer.alloc(0),
  );
  guarded.write(Buffer.alloc(mib));
  guarded.write(Buffer.alloc(mib));
  assert.equal(callbacks.length, 1);
  assert.equal(budget.used, 2 * mib + 512);
  const closed = once(guarded, "close");
  raw.destroy();
  await closed;
  assert.equal(budget.used, 0);
  callbacks[0]?.(new Error("socket closed"));
  assert.equal(budget.used, 0);
});
