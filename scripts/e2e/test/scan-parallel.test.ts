// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { fingerprint, HarnessError } from "../src/core.ts";
import { Run } from "../src/run.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(
  options: {
    ranges?: [number, number][];
    proof?: ReturnType<typeof deferred<Set<string>>>;
  } = {},
) {
  const host = [203, 0, 113, 17].join(".");
  const node = "pgcf-node";
  const scanId = fingerprint(`${node}:${host}`);
  const launched = deferred<void>();
  const nativeStarted = deferred<void>();
  const calls: {
    host: string;
    ports: number[];
    resolve(result?: Record<string, unknown>): void;
    reject(reason: unknown): void;
  }[] = [];
  const nativeCalls: string[][] = [];
  const events: string[] = [];
  const reports: { stage: string; pass: boolean; counts: unknown }[] = [];
  let active = 0;
  let peak = 0;
  let saves = 0;
  let autoComplete = false;
  const ranges = structuredClone(options.ranges ?? []);
  const run = Object.create(Run.prototype) as Run;
  Object.assign(run, {
    c: { values: { PGCF_E2E_REGIONAL_NAMESPACE: "pgcf-system" } },
    state: {
      completed: ["E5"],
      scans: [],
      operator_scans: [scanId],
      scan_ranges: ranges.length ? { [scanId]: ranges } : {},
    },
    deadline: Date.now() + 120_000,
    assertCluster: async () => undefined,
    kube: {
      read: async (resource: string) =>
        resource === "nodes"
          ? {
              items: [
                {
                  metadata: { name: node },
                  status: {
                    addresses: [{ type: "ExternalIP", address: host }],
                  },
                },
              ],
            }
          : { items: [] },
    },
    nativeProof: async (targets: readonly string[]) => {
      nativeCalls.push([...targets]);
      events.push("native");
      nativeStarted.resolve();
      return options.proof ? options.proof.promise : new Set([host]);
    },
    probe: async (path: string, body: unknown) => {
      assert.equal(path, "/scan");
      const request = body as { host: string; ports: number[] };
      assert.equal(request.host, host);
      assert(request.ports.length <= 256);
      assert(!request.ports.includes(25));
      const reply = deferred<Record<string, unknown>>();
      active++;
      peak = Math.max(peak, active);
      events.push("batch");
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          active--;
        }
      };
      const call = {
        host: request.host,
        ports: [...request.ports],
        resolve(result = { checked: request.ports.length, open: [] }) {
          finish();
          reply.resolve(result);
        },
        reject(reason: unknown) {
          finish();
          reply.reject(reason);
        },
      };
      calls.push(call);
      launched.resolve();
      if (autoComplete) call.resolve();
      return reply.promise;
    },
    save: async () => {
      saves++;
    },
    emit: async (
      stage: string,
      counts: unknown,
      _timings: unknown,
      pass: boolean,
    ) => {
      reports.push({ stage, counts, pass });
    },
  });
  return {
    run,
    host,
    scanId,
    calls,
    nativeCalls,
    nativeStarted,
    launched,
    events,
    reports,
    peak: () => peak,
    active: () => active,
    saves: () => saves,
    releaseAll() {
      autoComplete = true;
      for (const call of calls) call.resolve();
    },
  };
}

test("Run.scan overlaps exactly sixteen bounded batches with disjoint full segment coverage", async () => {
  const sample = fixture();
  const scanning = sample.run.scan();
  void scanning.catch(() => undefined);
  try {
    await sample.launched.promise;
    await nextTurn();
    assert.equal(sample.calls.length, 16);
    assert.equal(sample.peak(), 16);
    assert.equal(sample.active(), 16);
    assert.deepEqual(sample.nativeCalls, [[sample.host]]);
    assert.equal(sample.events[0], "native");
    const workerPorts = sample.calls.flatMap((call) => call.ports);
    assert.equal(workerPorts.length, 4095);
    assert.equal(new Set(workerPorts).size, workerPorts.length);
    assert.deepEqual(
      [...workerPorts, 25].sort((a, b) => a - b),
      Array.from({ length: 4096 }, (_, index) => index + 1),
    );
    assert.deepEqual(sample.run.state.scan_ranges, {});
    assert.equal(sample.saves(), 0);
    sample.releaseAll();
    assert.equal(await scanning, false);
    assert.deepEqual(sample.run.state.scan_ranges[sample.scanId], [[1, 4096]]);
    assert.deepEqual(sample.run.state.scans, []);
    assert.deepEqual(sample.run.state.completed, ["E5"]);
    assert.equal(sample.saves(), 1);
    assert.equal(sample.reports[0]!.pass, false);
  } finally {
    sample.releaseAll();
    await scanning.catch(() => undefined);
  }
});

test("native port25 proof is awaited before launching any segment batch", async () => {
  const proof = deferred<Set<string>>();
  const sample = fixture({ proof });
  const scanning = sample.run.scan();
  void scanning.catch(() => undefined);
  await sample.nativeStarted.promise;
  assert.equal(sample.calls.length, 0);
  proof.resolve(new Set());
  await assert.rejects(scanning, {
    message: "supplemental_external_tcp_probe_required",
  });
  assert.equal(sample.calls.length, 0);
  assert.equal(sample.saves(), 0);
  assert.deepEqual(sample.run.state.scan_ranges, {});
  assert.deepEqual(sample.run.state.scans, []);
  assert.deepEqual(sample.reports, []);
});

test("one rejected batch waits for every launched batch and checkpoints no coverage", async () => {
  const sample = fixture({ ranges: [[1, 4096]] });
  let settled = false;
  let error: unknown;
  const scanning = sample.run.scan().then(
    () => {
      settled = true;
    },
    (failure: unknown) => {
      settled = true;
      error = failure;
    },
  );
  try {
    await sample.launched.promise;
    await nextTurn();
    assert.equal(sample.calls.length, 16);
    sample.calls[0]!.reject(new HarnessError("probe_request_failed"));
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(sample.active(), 15);
    assert.equal(sample.saves(), 0);
    sample.releaseAll();
    await scanning;
    assert(error instanceof HarnessError);
    assert.equal(error.code, "probe_request_failed");
    assert.deepEqual(sample.run.state.scan_ranges[sample.scanId], [[1, 4096]]);
    assert.deepEqual(sample.run.state.scans, []);
    assert.deepEqual(sample.run.state.completed, ["E5"]);
    assert.deepEqual(sample.reports, []);
    assert.equal(sample.calls.length, 16);
    assert.equal(sample.saves(), 0);
  } finally {
    sample.releaseAll();
    await scanning;
  }
});

test("bad checked counts reject a fully settled segment without saving it", async () => {
  const sample = fixture({ ranges: [[1, 4096]] });
  const scanning = sample.run.scan();
  void scanning.catch(() => undefined);
  try {
    await sample.launched.promise;
    await nextTurn();
    assert.equal(sample.calls.length, 16);
    sample.calls[0]!.resolve({ checked: 255, open: [] });
    sample.releaseAll();
    await assert.rejects(scanning, { message: "invalid_scan_result" });
    assert.equal(sample.saves(), 0);
    assert.deepEqual(sample.run.state.scan_ranges[sample.scanId], [[1, 4096]]);
    assert.deepEqual(sample.run.state.scans, []);
    assert.deepEqual(sample.reports, []);
  } finally {
    sample.releaseAll();
    await scanning.catch(() => undefined);
  }
});

test("bad open shape rejects a fully settled segment without saving it", async () => {
  const sample = fixture({ ranges: [[1, 4096]] });
  const scanning = sample.run.scan();
  void scanning.catch(() => undefined);
  try {
    await sample.launched.promise;
    await nextTurn();
    assert.equal(sample.calls.length, 16);
    sample.calls[0]!.resolve({ checked: 256, open: ["unexpected"] });
    sample.releaseAll();
    await assert.rejects(scanning, { message: "invalid_scan_result" });
    assert.equal(sample.saves(), 0);
    assert.deepEqual(sample.run.state.scan_ranges[sample.scanId], [[1, 4096]]);
    assert.deepEqual(sample.run.state.scans, []);
    assert.deepEqual(sample.reports, []);
  } finally {
    sample.releaseAll();
    await scanning.catch(() => undefined);
  }
});

test("a forbidden open port rejects the segment after all batches finish", async () => {
  const sample = fixture({ ranges: [[1, 4096]] });
  let settled = false;
  const scanning = sample.run.scan().finally(() => {
    settled = true;
  });
  void scanning.catch(() => undefined);
  try {
    await sample.launched.promise;
    await nextTurn();
    assert.equal(sample.calls.length, 16);
    sample.calls[0]!.resolve({ checked: 256, open: [4097] });
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(sample.saves(), 0);
    sample.releaseAll();
    await assert.rejects(scanning, { message: "unexpected_open_port" });
    assert.equal(sample.calls.length, 16);
    assert.equal(sample.saves(), 0);
    assert.deepEqual(sample.run.state.scan_ranges[sample.scanId], [[1, 4096]]);
    assert.deepEqual(sample.run.state.scans, []);
    assert.deepEqual(sample.reports, []);
  } finally {
    sample.releaseAll();
    await scanning.catch(() => undefined);
  }
});

test("the final bounded segment completes E6 only after fresh native provenance", async () => {
  const proof = deferred<Set<string>>();
  const sample = fixture({ ranges: [[1, 61440]], proof });
  const scanning = sample.run.scan();
  void scanning.catch(() => undefined);
  try {
    await sample.launched.promise;
    await nextTurn();
    assert.equal(sample.calls.length, 16);
    assert.equal(sample.peak(), 16);
    assert.deepEqual(
      sample.calls.flatMap((call) => call.ports).sort((a, b) => a - b),
      Array.from({ length: 4095 }, (_, index) => index + 61441),
    );
    assert.equal(sample.nativeCalls.length, 0);
    sample.releaseAll();
    await sample.nativeStarted.promise;
    assert.deepEqual(sample.run.state.completed, ["E5"]);
    assert.deepEqual(sample.nativeCalls, [[sample.host]]);
    proof.resolve(new Set([sample.host]));
    assert.equal(await scanning, true);
    assert.deepEqual(sample.run.state.scans, [sample.scanId]);
    assert.deepEqual(sample.run.state.completed, ["E5", "E6"]);
    assert.deepEqual(sample.run.state.scan_ranges[sample.scanId], [
      [1, 61440],
      [61441, 65535],
    ]);
    assert.equal(sample.reports[0]!.stage, "E6");
    assert.equal(sample.reports[0]!.pass, true);
  } finally {
    sample.releaseAll();
    proof.resolve(new Set([sample.host]));
    await scanning.catch(() => undefined);
  }
});
