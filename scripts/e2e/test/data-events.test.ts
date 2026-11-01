// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import worker, { type Env, verifySignature } from "../receiver/worker.ts";
import {
  idempotencyHeaders,
  arrivalInversions,
  isInSeqOrder,
  latencySummary,
  sameEventIds,
} from "../src/data-events.ts";

const secret = "whsec_test_secret";
const body = '{"id":"1:1:1","type":"data.orders"}';
const now = 1_800_000_000;

// An independent signer: the header format of PGCF-Signature, t=<unix>,v1=<hex HMAC of t.body>.
function signed(timestamp: number, payload: string, key = secret): string {
  const mac = createHmac("sha256", key)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

test("a signature over the timestamp and the exact body verifies", async () => {
  assert.equal(
    await verifySignature(secret, signed(now, body), body, now),
    true,
  );
});

test("a wrong secret, a changed body or a missing secret does not verify", async () => {
  const header = signed(now, body);
  assert.equal(await verifySignature("whsec_other", header, body, now), false);
  assert.equal(await verifySignature(secret, header, body + " ", now), false);
  assert.equal(await verifySignature("", header, body, now), false);
});

test("the timestamp must be within 300 seconds in either direction", async () => {
  assert.equal(
    await verifySignature(secret, signed(now - 300, body), body, now),
    true,
  );
  assert.equal(
    await verifySignature(secret, signed(now - 301, body), body, now),
    false,
  );
  assert.equal(
    await verifySignature(secret, signed(now + 301, body), body, now),
    false,
  );
});

test("a header outside the exact grammar does not verify", async () => {
  const mac = signed(now, body).split("v1=")[1]!;
  for (const header of [
    "",
    `v1=${mac}`,
    `t=${now},v1=${mac.slice(2)}`,
    `t=${now},v1=${mac.toUpperCase()}`,
    `t=${now},v1=${mac},v0=${mac}`,
    `t=${now} v1=${mac}`,
  ]) {
    assert.equal(await verifySignature(secret, header, body, now), false);
  }
});

test("every mutation carries an Idempotency-Key and a GET does not", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.deepEqual(idempotencyHeaders(method, "key-1"), {
      "Idempotency-Key": "key-1",
    });
  }
  assert.deepEqual(idempotencyHeaders("GET", "key-1"), {});
});

test("an unset or empty secret never verifies, even for a matching MAC over the empty key", async () => {
  const header = signed(now, body, "");
  assert.equal(await verifySignature("", header, body, now), false);
  assert.equal(
    await verifySignature(undefined as unknown as string, header, body, now),
    false,
  );
});

test("the receiver admin routes refuse a bearer when READ_TOKEN is unset", async () => {
  const unset = {} as unknown as Env;
  for (const authorization of ["Bearer undefined", "Bearer ", ""]) {
    const response = await worker.fetch(
      new Request("https://receiver.invalid/admin/receipts", {
        headers: { Authorization: authorization },
      }),
      unset,
    );
    assert.equal(response.status, 401);
  }
});

test("sameEventIds accepts the same ids in any order and nothing else", () => {
  assert.equal(sameEventIds(["a", "b", "c"], ["c", "a", "b"]), true);
  assert.equal(sameEventIds(["a", "b"], ["a", "b", "c"]), false);
  assert.equal(sameEventIds(["a", "b", "c"], ["a", "b"]), false);
  assert.equal(sameEventIds(["a", "a", "b"], ["a", "b", "b"]), false);
  assert.equal(sameEventIds([], []), true);
});

test("isInSeqOrder requires strictly increasing (epoch, seq)", () => {
  assert.equal(
    isInSeqOrder([
      { epoch: 1, seq: 1 },
      { epoch: 1, seq: 2 },
      { epoch: 2, seq: 1 },
    ]),
    true,
  );
  assert.equal(
    isInSeqOrder([
      { epoch: 1, seq: 2 },
      { epoch: 1, seq: 1 },
    ]),
    false,
  );
  assert.equal(
    isInSeqOrder([
      { epoch: 1, seq: 1 },
      { epoch: 1, seq: 1 },
    ]),
    false,
  );
  assert.equal(
    isInSeqOrder([
      { epoch: 2, seq: 1 },
      { epoch: 1, seq: 9 },
    ]),
    false,
  );
});

test("latencySummary gives nearest-rank p50 and p95, and null for none", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.deepEqual(latencySummary(values), { n: 100, p50: 50, p95: 95 });
  assert.deepEqual(latencySummary([7]), { n: 1, p50: 7, p95: 7 });
  assert.deepEqual(latencySummary([]), { n: 0, p50: null, p95: null });
});

test("arrivalInversions counts the pairs that arrived against their (epoch, seq) order", () => {
  const at = (...seqs: number[]) => seqs.map((seq) => ({ epoch: 1, seq }));
  assert.equal(arrivalInversions(at(1, 3, 4, 5, 6, 7)), 0);
  assert.equal(arrivalInversions(at(1, 3, 4, 5, 7, 6)), 1);
  assert.equal(arrivalInversions(at(3, 2, 1)), 3);
  assert.equal(
    arrivalInversions([
      { epoch: 2, seq: 1 },
      { epoch: 1, seq: 9 },
    ]),
    1,
  );
  assert.equal(arrivalInversions([]), 0);
});
